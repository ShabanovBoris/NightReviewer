import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { callDaemonRpc, DaemonRpcClient } from "../../src/daemon";
import {
  readExistingLifecycleToken,
  resolveExistingDaemonRuntimePaths,
} from "../../src/daemon/runtime-files";
import { openStorage } from "../../src/storage";

interface GitFixture {
  readonly root: string;
  readonly baseSha: string;
  readonly headSha: string;
}

interface JsonRpcEnvelope {
  readonly jsonrpc: "2.0";
  readonly id?: number | string;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

class McpStdioClient {
  private readonly outputReader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = Buffer.alloc(0);
  private requestId = 1;

  constructor(readonly process: ReturnType<typeof Bun.spawn>) {
    const stdout = process.stdout;
    if (stdout === undefined || typeof stdout === "number") {
      throw new Error("MCP test process did not expose piped stdout.");
    }
    this.outputReader = new Response(
      stdout,
    ).body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  }

  async initialize(): Promise<JsonRpcEnvelope> {
    return this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "nr-test-client", version: "1.0.0" },
    });
  }

  notifyInitialized(): void {
    this.notify("notifications/initialized");
  }

  async request(method: string, params: unknown): Promise<JsonRpcEnvelope> {
    const id = this.requestId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    const response = await this.readMessage();
    if (response.id !== id)
      throw new Error("MCP response correlation did not match its request.");
    return response;
  }

  notify(method: string, params?: unknown): void {
    this.write({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  async sendRawLine(line: string): Promise<JsonRpcEnvelope> {
    const stdin = this.process.stdin;
    if (stdin === undefined || typeof stdin === "number") {
      throw new Error("MCP test process did not expose piped stdin.");
    }
    stdin.write(`${line}\n`);
    stdin.flush();
    return this.readMessage();
  }

  close(): Promise<number> {
    const stdin = this.process.stdin;
    if (stdin === undefined || typeof stdin === "number") {
      throw new Error("MCP test process did not expose piped stdin.");
    }
    stdin.end();
    return this.process.exited;
  }

  private write(value: unknown): void {
    const stdin = this.process.stdin;
    if (stdin === undefined || typeof stdin === "number") {
      throw new Error("MCP test process did not expose piped stdin.");
    }
    stdin.write(`${JSON.stringify(value)}\n`);
    stdin.flush();
  }

  private async readMessage(): Promise<JsonRpcEnvelope> {
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline >= 0) {
        const line = this.buffer.subarray(0, newline);
        this.buffer = this.buffer.subarray(newline + 1);
        return JSON.parse(line.toString("utf8")) as JsonRpcEnvelope;
      }
      const chunk = await this.outputReader.read();
      if (chunk.done)
        throw new Error("MCP stdio process exited before replying.");
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk.value)]);
    }
  }
}

test("spawned daemon and MCP stdio clients preserve durable review lifecycle", async () => {
  const temporaryParent =
    process.platform === "darwin" ? "/private/tmp" : "/tmp";
  const temporary = await mkdtemp(path.join(temporaryParent, "nr07-int-"));
  const storageRoot = path.join(temporary, "storage");
  const fixture = await createGitFixture(path.join(temporary, "target"));
  let daemon: ReturnType<typeof Bun.spawn> | undefined;
  let clientA: McpStdioClient | undefined;
  let clientB: McpStdioClient | undefined;
  let clientC: McpStdioClient | undefined;
  let storage = undefined as
    | Awaited<ReturnType<typeof openStorage>>
    | undefined;
  try {
    daemon = spawnDaemon(storageRoot, fixture.root);
    const daemonClient = await waitForDaemon(storageRoot, daemon);
    expect(daemonClient.handshake.rpcProtocolVersion).toBe("nr-daemon-rpc/1");
    const socketPath = path.join(storageRoot, "runtime", "s");
    await expect(
      callDaemonRpc(socketPath, "A".repeat(43), "handshake"),
    ).rejects.toMatchObject({
      protocolError: { code: "AUTH_REQUIRED" },
    });
    const runtimePaths = await resolveExistingDaemonRuntimePaths(storageRoot);
    const lifecycleToken = await readExistingLifecycleToken(runtimePaths);
    if (lifecycleToken === undefined)
      throw new Error("Daemon lifecycle token was not created.");
    const unsupportedVersion = await rawRpcRequest(
      socketPath,
      JSON.stringify({
        protocolVersion: "nr-daemon-rpc/99",
        correlationId: "version-mismatch",
        lifecycleToken,
        method: "handshake",
      }),
    );
    expect(
      isRecord(unsupportedVersion.error)
        ? unsupportedVersion.error.code
        : undefined,
    ).toBe("INVALID_ARGUMENT");
    const malformedRpc = await rawRpcRequest(socketPath, "not-json");
    expect(
      isRecord(malformedRpc.error) ? malformedRpc.error.code : undefined,
    ).toBe("INVALID_ARGUMENT");

    clientA = await spawnMcpClient(storageRoot);
    const malformedMcp = await clientA.sendRawLine("not-json");
    expect(malformedMcp.error?.code).toBe(-32700);
    const initializedA = await clientA.initialize();
    expect(initializedA.result).toMatchObject({
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
    });
    const beforeInitializedNotification = await clientA.request(
      "tools/list",
      {},
    );
    expect(beforeInitializedNotification.error?.code).toBe(-32002);
    clientA.notifyInitialized();
    const listed = await clientA.request("tools/list", {});
    const toolNames = readTools(listed)
      .map((tool) => tool.name)
      .sort();
    expect(toolNames).toEqual([
      "review_cancel",
      "review_status",
      "review_submit",
      "review_submit_fix",
    ]);

    const submission = {
      repoId: "fixture/project",
      objectFormat: "sha1",
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      task: "Check the fixture change.",
      acceptanceCriteria: [{ id: "AC1", requirement: "Persist this review." }],
      profile: "strict/1",
      idempotencyKey: "integration-submit",
    };
    const accepted = await callTool(clientA, "review_submit", submission);
    expect(accepted.isError).not.toBe(true);
    const acceptedReview = structuredResult(accepted);
    expect(acceptedReview.state).toBe("QUEUED");
    const reviewId = acceptedReview.reviewId as string;
    const cycleId = acceptedReview.cycleId as string;
    expect(reviewId).toBeString();
    expect(cycleId).toBeString();

    const cancellationAccepted = structuredResult(
      await callTool(clientA, "review_submit", {
        ...submission,
        idempotencyKey: "integration-cancel-queued",
      }),
    );
    const cancelled = structuredResult(
      await callTool(clientA, "review_cancel", {
        reviewId: cancellationAccepted.reviewId,
        reason: "Integration test queued cancellation.",
        idempotencyKey: "integration-cancel-queued",
      }),
    );
    expect(cancelled.state).toBe("CANCELLED");

    expect(await clientA.close()).toBe(0);
    clientA = undefined;

    clientB = await spawnMcpClient(storageRoot);
    await clientB.initialize();
    clientB.notifyInitialized();
    const secondAccepted = await callTool(clientB, "review_submit", submission);
    expect(structuredResult(secondAccepted)).toEqual(acceptedReview);
    const changedPayload = await callTool(clientB, "review_submit", {
      ...submission,
      task: "Changed payload with same idempotency key.",
    });
    expect(errorResult(changedPayload).code).toBe("CONFLICT");

    const unknownRepository = await callTool(clientB, "review_submit", {
      ...submission,
      repoId: "unknown/repository",
      idempotencyKey: "unknown-repo",
    });
    expect(errorResult(unknownRepository).code).toBe("FORBIDDEN");
    const unknownReview = await callTool(clientB, "review_status", {
      reviewId: "unknown-review",
    });
    expect(errorResult(unknownReview).code).toBe("NOT_FOUND");

    const finalReview = await waitForState(clientB, reviewId, ["APPROVED"]);
    expect(finalReview.reviewId).toBe(reviewId);
    expect(finalReview.cycleId).toBe(cycleId);
    expect(finalReview.progress).toEqual({
      completedRuns: 9,
      requiredRuns: 9,
      activeRuns: 0,
    });
    expect(
      isRecord(finalReview.coverage) && finalReview.coverage.complete,
    ).toBe(true);
    expect(finalReview.nextAction).toBe("NONE");

    storage = await openStorage({ rootDir: storageRoot });
    for (let index = 0; index < 100; index += 1) {
      storage.recordOutboxEvent(reviewId, cycleId, "test.page", { index });
    }
    const firstPage = await callTool(clientB, "review_status", { reviewId });
    const firstStatus = structuredResult(firstPage);
    expect(firstStatus.nextCursor).toBeString();
    expect(firstStatus.events).toHaveLength(100);
    const repeatedPage = await callTool(clientB, "review_status", { reviewId });
    expect(structuredResult(repeatedPage).events).toEqual(firstStatus.events);
    const nextPage = await callTool(clientB, "review_status", {
      reviewId,
      cursor: firstStatus.nextCursor,
    });
    const nextStatus = structuredResult(nextPage);
    expect(Array.isArray(nextStatus.events)).toBe(true);
    expect((nextStatus.events as unknown[]).length).toBeGreaterThan(0);
    expect(nextStatus.nextCursor).toBeNull();
    const firstIds = new Set(
      (firstStatus.events as Array<{ eventId: string }>).map(
        (event) => event.eventId,
      ),
    );
    expect(
      (nextStatus.events as Array<{ eventId: string }>).every(
        (event) => !firstIds.has(event.eventId),
      ),
    ).toBe(true);

    const staleFix = await callTool(clientB, "review_submit_fix", {
      reviewId,
      objectFormat: "sha1",
      previousSha: "f".repeat(40),
      headSha: "e".repeat(40),
      resolutions: [{ findingId: "finding-1", note: "Attempt a stale fix." }],
      idempotencyKey: "stale-fix",
    });
    expect(errorResult(staleFix).code).toBe("CONFLICT");

    storage.close();
    storage = undefined;
    const shutdownAccepted = structuredResult(
      await callTool(clientB, "review_submit", {
        ...submission,
        idempotencyKey: "shutdown-preserve",
      }),
    );
    expect(shutdownAccepted.state).toBe("QUEUED");
    const shutdownReviewId = shutdownAccepted.reviewId as string;
    await clientB.close();
    clientB = undefined;

    daemon.kill("SIGTERM");
    expect(await daemon.exited).toBe(0);
    daemon = undefined;

    daemon = spawnDaemon(storageRoot, fixture.root);
    const restartedDaemonClient = await waitForDaemon(storageRoot, daemon);
    clientC = await spawnMcpClient(storageRoot);
    await clientC.initialize();
    clientC.notifyInitialized();
    const recovered = await waitForState(clientC, shutdownReviewId, [
      "APPROVED",
    ]);
    expect(recovered).toMatchObject({
      reviewId: shutdownReviewId,
      state: "APPROVED",
      nextAction: "NONE",
      progress: {
        completedRuns: 9,
        requiredRuns: 9,
        activeRuns: 0,
      },
    });

    const duplicateDaemon = spawnDaemon(storageRoot, fixture.root);
    expect(await duplicateDaemon.exited).toBe(1);
    expect(
      await restartedDaemonClient.call("review_status", { reviewId }),
    ).toBeDefined();
  } finally {
    if (clientA !== undefined) await clientA.close();
    if (clientB !== undefined) await clientB.close();
    if (clientC !== undefined) await clientC.close();
    storage?.close();
    if (daemon !== undefined && daemon.exitCode === null) {
      daemon.kill("SIGTERM");
      await daemon.exited;
    }
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);

async function spawnMcpClient(storageRoot: string): Promise<McpStdioClient> {
  const child = Bun.spawn(
    [process.execPath, "run", "src/mcp/main.ts", "--storage-root", storageRoot],
    {
      cwd: process.cwd(),
      env: process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return new McpStdioClient(child);
}

function spawnDaemon(
  storageRoot: string,
  repositoryPath: string,
): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(
    [
      process.execPath,
      "run",
      "src/daemon/main.ts",
      "--storage-root",
      storageRoot,
      "--repository",
      `fixture/project=${repositoryPath}`,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

async function waitForDaemon(
  storageRoot: string,
  process: ReturnType<typeof Bun.spawn>,
): Promise<DaemonRpcClient> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline && process.exitCode === null) {
    try {
      return await DaemonRpcClient.connect(storageRoot);
    } catch (error) {
      lastError = error;
      await Bun.sleep(20);
    }
  }
  const stderrStream = process.stderr;
  const stderr =
    stderrStream === undefined || typeof stderrStream === "number"
      ? ""
      : await new Response(stderrStream).text();
  throw new Error(
    `Daemon did not become ready: ${String(lastError)} ${stderr}`,
  );
}

async function callTool(
  client: McpStdioClient,
  name: string,
  args: unknown,
): Promise<Record<string, unknown>> {
  const envelope = await client.request("tools/call", {
    name,
    arguments: args,
  });
  if (envelope.error !== undefined) throw new Error(envelope.error.message);
  return envelope.result as Record<string, unknown>;
}

async function waitForState(
  client: McpStdioClient,
  reviewId: string,
  states: readonly string[],
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await callTool(client, "review_status", { reviewId });
    const status = structuredResult(result);
    if (typeof status.state === "string" && states.includes(status.state))
      return status;
    await Bun.sleep(20);
  }
  throw new Error("Review did not reach a terminal snapshot boundary in time.");
}

function structuredResult(
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (result.isError === true)
    throw new Error(JSON.stringify(errorResult(result)));
  const content = result.structuredContent;
  if (isRecord(content)) return content;
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  if (!isRecord(first) || typeof first.text !== "string")
    throw new Error("MCP tool response had no JSON result.");
  return JSON.parse(first.text) as Record<string, unknown>;
}

function errorResult(result: Record<string, unknown>): Record<string, unknown> {
  const structured = result.structuredContent;
  if (isRecord(structured) && isRecord(structured.error))
    return structured.error;
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  if (isRecord(first) && typeof first.text === "string") {
    try {
      return JSON.parse(first.text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function readTools(envelope: JsonRpcEnvelope): Array<{ name: string }> {
  if (!isRecord(envelope.result) || !Array.isArray(envelope.result.tools))
    return [];
  return envelope.result.tools.filter(
    (tool): tool is { name: string } =>
      isRecord(tool) && typeof tool.name === "string",
  );
}

async function createGitFixture(root: string): Promise<GitFixture> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await git(root, ["init", "--quiet"]);
  await git(root, ["config", "user.name", "NR-07 fixture"]);
  await git(root, ["config", "user.email", "nr07-fixture@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "base\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "--quiet", "-m", "base"]);
  const baseSha = await git(root, ["rev-parse", "HEAD"]);
  await writeFile(path.join(root, "README.md"), "head\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "--quiet", "-m", "head"]);
  const headSha = await git(root, ["rev-parse", "HEAD"]);
  return { root, baseSha, headSha };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: os.tmpdir(),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Fixture Git command failed: ${stderr}`);
  return stdout.trim();
}

async function rawRpcRequest(
  socketPath: string,
  line: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Internal RPC probe timed out."));
    }, 2_000);
    socket.once("connect", () => socket.write(`${line}\n`));
    socket.on("data", (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      const newline = response.indexOf(0x0a);
      if (newline < 0) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(
        JSON.parse(response.subarray(0, newline).toString("utf8")) as Record<
          string,
          unknown
        >,
      );
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
