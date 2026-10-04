import { createHash, randomUUID } from "node:crypto";
import { type ProtocolError, RUNTIME_PROTOCOL_VERSION } from "../protocol";
import { STORAGE_SCHEMA_VERSION } from "../storage";
import { callDaemonRpc, DaemonRpcError } from "./rpc";
import {
  readExistingLifecycleToken,
  resolveExistingDaemonRuntimePaths,
} from "./runtime-files";
import type { DaemonHandshake, DaemonRpcMethod } from "./types";
import { DAEMON_RPC_PROTOCOL_VERSION } from "./types";

const REQUIRED_CAPABILITIES = [
  "review_submit",
  "review_status",
  "review_submit_fix",
  "review_cancel",
] as const;

export class DaemonRpcClient {
  private constructor(
    private readonly storageRoot: string,
    private handshakeValue: DaemonHandshake,
    private tokenFingerprint: string,
  ) {}

  static async connect(storageRoot: string): Promise<DaemonRpcClient> {
    const paths = await resolveExistingDaemonRuntimePaths(storageRoot);
    const token = await readExistingLifecycleToken(paths);
    if (token === undefined) {
      throw remoteError("BACKEND_UNAVAILABLE", "Local daemon is not running.");
    }
    const value = await callDaemonRpc(paths.socket, token, "handshake");
    const handshake = validateHandshake(value);
    return new DaemonRpcClient(
      paths.storageRoot,
      handshake,
      fingerprint(token),
    );
  }

  get handshake(): DaemonHandshake {
    return this.handshakeValue;
  }

  async call(
    method: Exclude<DaemonRpcMethod, "handshake">,
    params: unknown,
  ): Promise<unknown> {
    const paths = await resolveExistingDaemonRuntimePaths(this.storageRoot);
    const token = await readExistingLifecycleToken(paths);
    if (token === undefined) {
      throw remoteError(
        "BACKEND_UNAVAILABLE",
        "Local daemon lifecycle token is unavailable.",
      );
    }
    const currentFingerprint = fingerprint(token);
    if (currentFingerprint !== this.tokenFingerprint) {
      const handshake = validateHandshake(
        await callDaemonRpc(paths.socket, token, "handshake"),
      );
      this.handshakeValue = handshake;
      this.tokenFingerprint = currentFingerprint;
    }
    const result = await callDaemonRpc(paths.socket, token, method, params);
    return result;
  }
}

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function validateHandshake(value: unknown): DaemonHandshake {
  const capabilities =
    isRecord(value) && Array.isArray(value.capabilities)
      ? value.capabilities
      : undefined;
  if (
    !isRecord(value) ||
    value.rpcProtocolVersion !== DAEMON_RPC_PROTOCOL_VERSION ||
    typeof value.daemonInstanceId !== "string" ||
    !Number.isSafeInteger(value.daemonOwnershipEpoch) ||
    (value.daemonOwnershipEpoch as number) < 1 ||
    typeof value.daemonOwnershipResourceId !== "string" ||
    value.runtimeProtocolVersion !== RUNTIME_PROTOCOL_VERSION ||
    value.storageSchemaVersion !== STORAGE_SCHEMA_VERSION ||
    capabilities === undefined ||
    !REQUIRED_CAPABILITIES.every((capability) =>
      capabilities.includes(capability),
    )
  ) {
    throw remoteError(
      "INVALID_ARGUMENT",
      "Local daemon handshake version or capabilities do not match this client.",
    );
  }
  return value as unknown as DaemonHandshake;
}

function remoteError(
  code: ProtocolError["code"],
  message: string,
): DaemonRpcError {
  return new DaemonRpcError({
    code,
    message,
    retryable: code === "BACKEND_UNAVAILABLE",
    correlationId: randomUUID(),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
