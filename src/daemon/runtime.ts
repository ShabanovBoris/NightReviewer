import { randomUUID } from "node:crypto";
import { chmod, lstat } from "node:fs/promises";
import type { ProtocolError } from "../protocol";
import { RUNTIME_PROTOCOL_VERSION } from "../protocol";
import { DurableScheduler } from "../scheduler";
import { createSnapshotService } from "../snapshot";
import type { SqliteStorage } from "../storage";
import { DaemonOwner, type DaemonOwnerOptions } from "./owner";
import { DaemonReviewRuntime } from "./reviews";
import { callDaemonRpc, type RpcServerHandle, startRpcServer } from "./rpc";
import {
  createDaemonRuntimePaths,
  type DaemonRuntimePaths,
  readExistingLifecycleToken,
  removeLifecycleToken,
  removeRuntimeSocket,
  rotateLifecycleToken,
} from "./runtime-files";
import { DAEMON_RPC_PROTOCOL_VERSION } from "./types";

const DAEMON_CAPABILITIES = [
  "review_submit",
  "review_status",
  "review_submit_fix",
  "review_cancel",
] as const;

export interface StartDaemonOptions {
  readonly store: SqliteStorage;
  readonly repositoryPaths:
    | ReadonlyMap<string, string>
    | Readonly<Record<string, string>>;
  readonly owner?: DaemonOwnerOptions;
  readonly drainTimeoutMs?: number;
}

export class DaemonRuntime {
  private closePromise: Promise<void> | undefined;

  private constructor(
    private readonly paths: DaemonRuntimePaths,
    private readonly store: SqliteStorage,
    private readonly owner: DaemonOwner,
    private readonly reviews: DaemonReviewRuntime,
    private readonly rpc: RpcServerHandle,
    private readonly instanceId: string,
  ) {}

  static async start(options: StartDaemonOptions): Promise<DaemonRuntime> {
    const owner = DaemonOwner.acquire(options.store, options.owner);
    let paths: DaemonRuntimePaths | undefined;
    let lifecycleToken: string | undefined;
    let rpc: RpcServerHandle | undefined;
    let pathsOwnedForThisEpoch = false;
    try {
      paths = await createDaemonRuntimePaths(options.store.rootDir);
      await retirePreviousSocket(paths);
      pathsOwnedForThisEpoch = true;
      lifecycleToken = await rotateLifecycleToken(paths);
      const snapshotService = await createSnapshotService({
        store: options.store,
        repositoryPaths: options.repositoryPaths,
        fencingProvider: () => owner.fencingToken(),
      });
      const scheduler = new DurableScheduler({
        store: options.store,
        owner,
      });
      const reviews = new DaemonReviewRuntime({
        store: options.store,
        owner,
        snapshotService,
        scheduler,
        trustedRepositoryIds: repositoryIds(options.repositoryPaths),
        ...(options.drainTimeoutMs === undefined
          ? {}
          : { drainTimeoutMs: options.drainTimeoutMs }),
      });
      const instanceId = randomUUID();
      rpc = await startRpcServer(
        paths.socket,
        lifecycleToken,
        async (method, params, context) => {
          if (!owner.isCurrent()) {
            throw protocolError(
              "CONFLICT",
              "Daemon ownership is no longer current.",
              context.correlationId,
            );
          }
          if (method === "handshake") {
            const fencing = owner.fencingToken();
            return {
              rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
              daemonInstanceId: instanceId,
              daemonOwnershipEpoch: fencing.token,
              daemonOwnershipResourceId: fencing.resourceId,
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              storageSchemaVersion: options.store.schemaVersion,
              capabilities: DAEMON_CAPABILITIES,
            };
          }
          return reviews.invoke(method, params, context.correlationId);
        },
      );
      await chmod(paths.socket, 0o600);
      const runtime = new DaemonRuntime(
        paths,
        options.store,
        owner,
        reviews,
        rpc,
        instanceId,
      );
      await scheduler.start();
      reviews.start();
      return runtime;
    } catch (error) {
      if (rpc !== undefined) await rpc.close().catch(() => undefined);
      if (paths !== undefined && pathsOwnedForThisEpoch && owner.isCurrent()) {
        await removeRuntimeSocket(paths).catch(() => undefined);
        if (lifecycleToken !== undefined) {
          await removeLifecycleToken(paths).catch(() => undefined);
        }
      }
      owner.release();
      throw error;
    }
  }

  get socketPath(): string {
    return this.paths.socket;
  }

  get daemonInstanceId(): string {
    return this.instanceId;
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOwnedRuntime();
    return this.closePromise;
  }

  private async closeOwnedRuntime(): Promise<void> {
    try {
      await this.reviews.drain();
    } finally {
      try {
        await this.rpc.close();
      } finally {
        try {
          if (this.owner.isCurrent()) {
            await removeRuntimeSocket(this.paths);
            await removeLifecycleToken(this.paths);
          }
        } finally {
          try {
            this.owner.release();
          } finally {
            this.store.close();
          }
        }
      }
    }
  }
}

async function retirePreviousSocket(paths: DaemonRuntimePaths): Promise<void> {
  try {
    const socketStat = await lstat(paths.socket);
    if (socketStat.isSymbolicLink() || !socketStat.isSocket()) {
      throw new Error("Existing daemon socket path is not a Unix socket.");
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }

  const previousToken = await readExistingLifecycleToken(paths);
  let probeSucceeded = false;
  try {
    await callDaemonRpc(
      paths.socket,
      previousToken ?? "",
      "handshake",
      undefined,
      500,
    );
    probeSucceeded = true;
  } catch {
    probeSucceeded = false;
  }
  if (probeSucceeded) {
    throw new Error(
      "Previous daemon socket still answers its authenticated health probe.",
    );
  }
  await removeRuntimeSocket(paths);
  await removeLifecycleToken(paths);
}

function protocolError(
  code: ProtocolError["code"],
  message: string,
  correlationId: string,
): ProtocolError {
  return { code, message, retryable: false, correlationId };
}

function repositoryIds(
  repositoryPaths:
    | ReadonlyMap<string, string>
    | Readonly<Record<string, string>>,
): ReadonlySet<string> {
  const map = repositoryPaths as ReadonlyMap<string, string>;
  return typeof map[Symbol.iterator] === "function"
    ? new Set(Array.from(map.keys()))
    : new Set(Object.keys(repositoryPaths));
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
