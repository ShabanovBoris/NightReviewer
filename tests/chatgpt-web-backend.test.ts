import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  CHATGPT_WEB_AUTH_MODE,
  CHATGPT_WEB_BRIDGE_ORIGIN,
  CHATGPT_WEB_BRIDGE_PIN,
  ChatGptWebBackendError,
  type ChatGptWebBackendOptions,
  ChatGptWebReviewerBackend,
  createChatGptWebConfigurationDigest,
} from "../src/backends/chatgpt-web";
import type { BackendInvocationInput } from "../src/scheduler/types";
import type { ArtifactReference, RawArtifactCapture } from "../src/storage";

const prompt = "Review only the run-bound context supplied to this worker.";
const promptHash = hash(prompt);
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const clientVersionProvenance = {
  kind: "active-codex-desktop-bundle" as const,
  bundleIdentifier: "com.example.codex",
  applicationPath: "/Applications/Codex.app",
  observedVersion: "0.1.0",
  observedAtUtc: "2026-10-05T12:00:00.000Z",
};

function workerOutput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "nr-review/1",
    reviewId: "review-1",
    cycleId: "cycle-1",
    runId: "run-1",
    attemptId: "attempt-1",
    promptHash,
    direction: "correctness",
    objectFormat: "sha1",
    reviewedBaseSha: baseSha,
    reviewedHeadSha: headSha,
    verdict: "NO_FINDINGS",
    coverage: { complete: true, paths: ["README.md"], limitations: [] },
    findings: [],
    ...overrides,
  };
}

function sse(
  responseId: string,
  outputText: string,
  responseOverrides: Record<string, unknown> = {},
): string {
  const response = {
    id: responseId,
    status: "completed",
    model: CHATGPT_WEB_BRIDGE_PIN.model,
    reasoning: { effort: CHATGPT_WEB_BRIDGE_PIN.reasoningEffort },
    ...responseOverrides,
  };
  return [
    "event: response.created",
    `data: ${JSON.stringify({ type: "response.created", response })}`,
    "",
    "event: response.output_text.delta",
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: outputText })}`,
    "",
    "event: response.completed",
    `data: ${JSON.stringify({ type: "response.completed", response })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

function streamFromChunks(
  chunks: readonly Uint8Array[],
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  });
}

function input(
  overrides: Partial<BackendInvocationInput> = {},
): BackendInvocationInput {
  const context: BackendInvocationInput["context"] = {
    reviewId: "review-1",
    cycleId: "cycle-1",
    runId: "run-1",
    direction: "correctness",
    replicaIndex: 1,
    objectFormat: "sha1",
    baseSha,
    headSha,
    promptHash,
    schemaHash: "c".repeat(64),
    policyHash: "d".repeat(64),
  };
  const claim: BackendInvocationInput["claim"] = {
    reviewId: "review-1",
    cycleId: "cycle-1",
    runId: "run-1",
    direction: "correctness",
    replicaIndex: 1,
    attemptId: "attempt-1",
    attemptNumber: 1,
    workKind: "TURN",
    deadlineAtUtc: "2026-10-05T13:00:00.000Z",
    attemptDeadlineAtUtc: "2026-10-05T12:30:00.000Z",
    lease: { resourceId: "job-run-1", ownerId: "daemon-1", token: 1 },
    leaseExpiresAtUtc: "2026-10-05T12:31:00.000Z",
  };
  return {
    claim,
    context,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function backendOptions(
  fetcher: typeof fetch,
  options: Partial<ChatGptWebBackendOptions> = {},
) {
  const captured: Uint8Array[] = [];
  const persistRawArtifact =
    options.persistRawArtifact ??
    (async (bytes: Uint8Array) => {
      const copy = Uint8Array.from(bytes);
      captured.push(copy);
      return artifactReference(copy, captured.length);
    });
  const createRawArtifactCapture =
    options.createRawArtifactCapture ??
    (async () => memoryArtifactCapture(persistRawArtifact));
  const clientVersion = options.clientVersion ?? "0.1.0";
  const backend = new ChatGptWebReviewerBackend({
    authMode: CHATGPT_WEB_AUTH_MODE,
    baseUrl: CHATGPT_WEB_BRIDGE_ORIGIN + "/",
    clientVersion,
    clientVersionProvenance: {
      ...clientVersionProvenance,
      observedVersion: clientVersion,
      ...options.clientVersionProvenance,
    },
    buildPrompt: () => prompt,
    persistRawArtifact,
    createRawArtifactCapture,
    fetcher,
    createId: sequentialIds(),
    now: () => new Date("2026-10-05T12:00:00.000Z"),
    ...options,
  });
  return { backend, captured };
}

function bridgeFetcher(
  turnResponses: readonly (Response | (() => Response))[] = [],
  options: {
    readonly version?: string;
    readonly efforts?: readonly string[];
  } = {},
  onTurn?: (request: RequestInit, capturedCount: () => number) => void,
  capturedCount: () => number = () => 0,
): typeof fetch {
  let responseIndex = 0;
  return (async (request, init) => {
    const url = new URL(String(request));
    if (url.pathname === "/healthz") {
      return Response.json({
        service: "codex-chatgpt-web",
        status: "ok",
        pid: 42,
        version: options.version ?? CHATGPT_WEB_BRIDGE_PIN.upstreamVersion,
        mode: "full",
        accepting_turns: true,
        active_http_turns: 0,
        active_browser_turns: 0,
      });
    }
    if (url.pathname === "/v1/models") {
      return Response.json({
        models: [
          {
            slug: CHATGPT_WEB_BRIDGE_PIN.model,
            supported_reasoning_levels: (
              options.efforts ?? [CHATGPT_WEB_BRIDGE_PIN.reasoningEffort]
            ).map((effort) => ({ effort })),
          },
        ],
      });
    }
    if (url.pathname === "/v1/responses") {
      onTurn?.(init ?? {}, capturedCount);
      const response = turnResponses[responseIndex++];
      if (response === undefined)
        throw new Error("Unexpected Responses request.");
      return typeof response === "function" ? response() : response;
    }
    throw new Error(`Unexpected endpoint: ${url.pathname}`);
  }) as typeof fetch;
}

function jsonSse(
  responseId: string,
  value: unknown,
  responseOverrides: Record<string, unknown> = {},
): Response {
  return new Response(
    sse(responseId, JSON.stringify(value), responseOverrides),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function artifactReference(
  bytes: Uint8Array,
  index: number,
): ArtifactReference {
  return {
    sha256: hash(bytes),
    sizeBytes: bytes.byteLength,
    relativePath: `artifacts/test-${index}`,
  };
}

function memoryArtifactCapture(
  persist: ChatGptWebBackendOptions["persistRawArtifact"],
): RawArtifactCapture {
  const chunks: Uint8Array[] = [];
  return {
    async write(bytes) {
      chunks.push(Uint8Array.from(bytes));
    },
    async commit() {
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return persist(bytes);
    },
    async abort() {
      chunks.length = 0;
    },
  };
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sequentialIds(): () => string {
  let index = 0;
  return () => `00000000-0000-4000-8000-${String(++index).padStart(12, "0")}`;
}

test("preflights the exact bridge, model, and advertised effort", async () => {
  const { backend } = backendOptions(bridgeFetcher());

  expect(backend.profile).toMatchObject({
    backend: "LIVE",
    backendProtocol: "chatgpt-web-responses/1",
    bridgeVersionPin: "6.1.3",
    model: CHATGPT_WEB_BRIDGE_PIN.model,
    reasoningEffort: "high",
    qualification: "LIVE_PRODUCTION_BRIDGE",
    runPlan: "NR09_LIVE_QUALIFICATION",
    requiredRuns: 1,
  });
  expect(JSON.stringify(backend.profile)).not.toContain("credential");

  const compatibility = await backend.checkCompatibility();

  expect(compatibility).toMatchObject({
    service: "codex-chatgpt-web",
    pid: 42,
    version: CHATGPT_WEB_BRIDGE_PIN.upstreamVersion,
    model: CHATGPT_WEB_BRIDGE_PIN.model,
    reasoningEffort: CHATGPT_WEB_BRIDGE_PIN.reasoningEffort,
    advertisedReasoningEfforts: ["high"],
    capabilities: {
      streamingResponses: true,
      freshSessionMetadata: true,
      requestAbortCancellation: true,
      boundedSchemaRepair: true,
    },
  });
  expect(compatibility.rawArtifacts.map(({ purpose }) => purpose)).toEqual([
    "HEALTH",
    "MODEL_CATALOG",
  ]);
});

test("configuration digest binds stable route identity, capabilities, and limits", () => {
  const first = backendOptions(bridgeFetcher()).backend.profile;
  const otherClientVersion = backendOptions(bridgeFetcher(), {
    clientVersion: "0.2.0",
  }).backend.profile;
  const otherProvenance = backendOptions(bridgeFetcher(), {
    clientVersionProvenance: {
      ...clientVersionProvenance,
      bundleIdentifier: "com.example.codex.preview",
      applicationPath: "/Applications/Codex Preview.app",
    },
  }).backend.profile;
  const nextTimeout = backendOptions(bridgeFetcher(), {
    requestTimeoutMs: 120_000,
  }).backend.profile;
  const nextLimit = backendOptions(bridgeFetcher(), {
    maxResponseBytes: 8 * 1024 * 1024,
  }).backend.profile;
  const newEvidenceTimestamp = backendOptions(bridgeFetcher(), {
    clientVersionProvenance: {
      ...clientVersionProvenance,
      observedAtUtc: "2026-10-05T13:00:00.000Z",
    },
  }).backend.profile;

  expect(
    new Set([
      first.configurationDigest,
      otherClientVersion.configurationDigest,
      otherProvenance.configurationDigest,
      nextTimeout.configurationDigest,
      nextLimit.configurationDigest,
    ]).size,
  ).toBe(5);
  expect(newEvidenceTimestamp.configurationDigest).toBe(
    first.configurationDigest,
  );
  const identity = {
    backend: "LIVE" as const,
    backendProtocol: "chatgpt-web-responses/1",
    authMode: "LOOPBACK_LOCAL",
    bridgeVersionPin: "6.1.3",
    bridgeOrigin: "http://127.0.0.1:17841",
    clientVersion: "0.1.0",
    clientVersionProvenance: {
      kind: "active-codex-desktop-bundle",
      bundleIdentifier: "com.example.codex",
      applicationPath: "/Applications/Codex.app",
      observedVersion: "0.1.0",
    },
    model: CHATGPT_WEB_BRIDGE_PIN.model,
    reasoningEffort: CHATGPT_WEB_BRIDGE_PIN.reasoningEffort,
    qualification: "LIVE_PRODUCTION_BRIDGE" as const,
    requestTimeoutMs: 180_000,
    maxResponseBytes: 16 * 1024 * 1024,
    capabilities: ["responses-sse", "fresh-thread", "abort", "schema-repair/1"],
  };
  const digestChanges = [
    { ...identity, authMode: "OTHER_MODE" },
    { ...identity, bridgeOrigin: "http://127.0.0.1:17842" },
    { ...identity, bridgeVersionPin: "6.1.2" },
    { ...identity, clientVersion: "0.2.0" },
    {
      ...identity,
      clientVersionProvenance: {
        ...identity.clientVersionProvenance,
        applicationPath: "/Applications/Other.app",
      },
    },
    { ...identity, model: "chatgpt-web/other-model" },
    { ...identity, reasoningEffort: "low" },
    { ...identity, capabilities: [...identity.capabilities, "new-capability"] },
    { ...identity, requestTimeoutMs: 120_000 },
    { ...identity, maxResponseBytes: 8 * 1024 * 1024 },
  ].map(createChatGptWebConfigurationDigest);
  const expectedDigest = createChatGptWebConfigurationDigest(identity);

  expect(first.configurationDigest).toBe(expectedDigest);
  expect(new Set([expectedDigest, ...digestChanges]).size).toBe(
    digestChanges.length + 1,
  );
});

test("direct route requests omit Authorization and reject unsupported identities before fetch", async () => {
  const authorizations: Array<string | null> = [];
  const requestedPaths: string[] = [];
  const redirectModes: Array<RequestInit["redirect"]> = [];
  const { backend } = backendOptions((async (request, init) => {
    const url = new URL(String(request));
    requestedPaths.push(url.pathname);
    redirectModes.push(init?.redirect);
    if (url.pathname === "/healthz") {
      return Response.json({
        service: "codex-chatgpt-web",
        status: "ok",
        pid: 42,
        version: CHATGPT_WEB_BRIDGE_PIN.upstreamVersion,
        mode: "full",
        accepting_turns: true,
        active_http_turns: 0,
        active_browser_turns: 0,
      });
    }
    authorizations.push(new Headers(init?.headers).get("authorization"));
    return url.pathname === "/v1/models"
      ? Response.json({
          models: [
            {
              slug: CHATGPT_WEB_BRIDGE_PIN.model,
              supported_reasoning_levels: [{ effort: "high" }],
            },
          ],
        })
      : sse("response-1", JSON.stringify(workerOutput()));
  }) as typeof fetch);
  await backend.checkCompatibility();
  expect(requestedPaths).toEqual(["/healthz", "/v1/models"]);
  expect(redirectModes).toEqual(["error", "error"]);
  expect(authorizations).toEqual([null]);

  const invalidBaseUrls = [
    "http://localhost:17841",
    "http://[::1]:17841",
    "http://127.0.0.1:17842",
    "http://127.0.0.1:17841.evil.test",
    "http://user@127.0.0.1:17841",
    "http://user:pass@127.0.0.1:17841",
    "http://127.0.0.1:17841?mode=proxy",
    "http://127.0.0.1:17841#fragment",
  ];
  for (const baseUrl of invalidBaseUrls) {
    expect(() => backendOptions(bridgeFetcher(), { baseUrl })).toThrow(
      ChatGptWebBackendError,
    );
  }
  expect(() =>
    backendOptions(bridgeFetcher(), {
      authMode: "HTTP_BEARER" as never,
    }),
  ).toThrow(ChatGptWebBackendError);
  expect(() =>
    backendOptions(bridgeFetcher(), {
      model: "chatgpt-web/other-model",
    }),
  ).toThrow(ChatGptWebBackendError);
  expect(() =>
    backendOptions(bridgeFetcher(), {
      clientVersionProvenance: {
        ...clientVersionProvenance,
        observedVersion: "9.9.9",
      },
    }),
  ).toThrow(ChatGptWebBackendError);
});

test("fails closed on a health redirect without requesting a second origin", async () => {
  const requestedUrls: string[] = [];
  const redirectModes: Array<RequestInit["redirect"]> = [];
  const { backend } = backendOptions((async (
    request: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(String(request));
    requestedUrls.push(url.href);
    redirectModes.push(init?.redirect);
    if (init?.redirect !== "error") {
      requestedUrls.push("https://outside.invalid/healthz");
    }
    throw new TypeError("Synthetic redirect rejection.");
  }) as unknown as typeof fetch);

  await expect(backend.checkCompatibility()).rejects.toMatchObject({
    code: "BRIDGE_UNAVAILABLE",
    sendState: "UNSENT",
  });
  expect(redirectModes).toEqual(["error"]);
  expect(requestedUrls).toEqual(["http://127.0.0.1:17841/healthz"]);
});

test("does not follow or retry a redirected Responses request", async () => {
  const requestedUrls: string[] = [];
  const redirectModes: Array<RequestInit["redirect"]> = [];
  const { backend } = backendOptions((async (request, init) => {
    const url = new URL(String(request));
    requestedUrls.push(url.href);
    redirectModes.push(init?.redirect);
    if (url.pathname === "/healthz") {
      return Response.json({
        service: "codex-chatgpt-web",
        status: "ok",
        pid: 42,
        version: CHATGPT_WEB_BRIDGE_PIN.upstreamVersion,
        mode: "full",
        accepting_turns: true,
        active_http_turns: 0,
        active_browser_turns: 0,
      });
    }
    if (url.pathname === "/v1/models") {
      return Response.json({
        models: [
          {
            slug: CHATGPT_WEB_BRIDGE_PIN.model,
            supported_reasoning_levels: [
              { effort: CHATGPT_WEB_BRIDGE_PIN.reasoningEffort },
            ],
          },
        ],
      });
    }
    if (url.pathname === "/v1/responses") {
      if (init?.redirect !== "error") {
        requestedUrls.push("https://outside.invalid/v1/responses");
      }
      throw new TypeError("Synthetic redirect rejection.");
    }
    throw new Error(`Unexpected endpoint: ${url.pathname}`);
  }) as typeof fetch);

  const result = await backend.invoke(input());

  expect(result.kind).toBe("UNKNOWN_SEND");
  expect(requestedUrls).toEqual([
    "http://127.0.0.1:17841/healthz",
    "http://127.0.0.1:17841/v1/models?client_version=0.1.0",
    "http://127.0.0.1:17841/v1/responses",
  ]);
  expect(redirectModes).toEqual(["error", "error", "error"]);
});

test("parses a chunked completed turn and returns run-bound raw and receipt evidence", async () => {
  const bytes = new TextEncoder().encode(
    sse(
      "response-1",
      JSON.stringify(
        workerOutput({
          coverage: {
            complete: true,
            paths: ["README.md", "レビュー.md"],
            limitations: [],
          },
        }),
      ),
    ),
  );
  const chunks: Uint8Array[] = [];
  const chunkSizes = [1, 2, 5, 3, 13, 8, 21, 4, 34, 7, 11];
  let offset = 0;
  let chunkIndex = 0;
  while (offset < bytes.byteLength) {
    const chunkSize = chunkSizes[chunkIndex % chunkSizes.length];
    if (chunkSize === undefined) {
      throw new Error("Chunk size sequence was unexpectedly empty.");
    }
    const end = Math.min(bytes.byteLength, offset + chunkSize);
    chunks.push(bytes.slice(offset, end));
    offset = end;
    chunkIndex += 1;
  }
  let sentBody: Record<string, unknown> | undefined;
  let sentHeaders: Headers | undefined;
  let sentRedirect: RequestInit["redirect"];
  const { backend, captured } = backendOptions(
    bridgeFetcher(
      [
        new Response(streamFromChunks(chunks), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ],
      {},
      (request) => {
        sentBody = JSON.parse(String(request.body)) as Record<string, unknown>;
        sentHeaders = new Headers(request.headers);
        sentRedirect = request.redirect;
      },
    ),
  );

  const result = await backend.invoke(input());

  expect(result.kind).toBe("SUCCESS");
  if (result.kind !== "SUCCESS") return;
  expect(result.output).toMatchObject({
    runId: "run-1",
    attemptId: "attempt-1",
    reviewedBaseSha: baseSha,
    reviewedHeadSha: headSha,
  });
  expect(result.receipt).toMatchObject({
    backend: "LIVE",
    qualification: "LIVE_PRODUCTION_BRIDGE",
    runId: "run-1",
    attemptId: "attempt-1",
    reviewedBaseSha: baseSha,
    reviewedHeadSha: headSha,
    bridge: { pid: 42, version: CHATGPT_WEB_BRIDGE_PIN.upstreamVersion },
    model: {
      observed: CHATGPT_WEB_BRIDGE_PIN.model,
      reasoningEffortObserved: CHATGPT_WEB_BRIDGE_PIN.reasoningEffort,
    },
    session: {
      turnIds: ["00000000-0000-4000-8000-000000000002"],
      responseIds: ["response-1"],
      freshForAttempt: true,
    },
    outcome: "COMPLETED",
    sendState: "SENT",
  });
  expect(Buffer.from(result.rawBytes).toString("utf8")).toBe(
    Buffer.from(bytes).toString("utf8"),
  );
  expect(captured).toContainEqual(bytes);
  expect(result.receiptArtifact).toBeDefined();
  expect(sentBody).toMatchObject({
    model: CHATGPT_WEB_BRIDGE_PIN.model,
    stream: true,
    reasoning: { effort: CHATGPT_WEB_BRIDGE_PIN.reasoningEffort },
  });
  expect(sentHeaders?.get("authorization")).toBeNull();
  expect(sentRedirect).toBe("error");
  if (sentBody === undefined) throw new Error("Request body was not captured.");
  const clientMetadata = sentBody.client_metadata as Record<string, unknown>;
  const metadata = JSON.parse(
    String(clientMetadata["x-codex-turn-metadata"]),
  ) as Record<string, unknown>;
  expect(metadata).toMatchObject({
    thread_id: result.receipt?.session.threadId,
    turn_id: result.receipt?.session.turnIds[0],
    request_kind: "turn",
  });
});

test("persists malformed output before its single schema-repair turn", async () => {
  const capturedBeforeRepair: number[] = [];
  const firstResponse = jsonSse("response-before-repair", "not-json");
  const secondResponse = jsonSse("response-after-repair", workerOutput());
  const { backend, captured } = backendOptions(
    bridgeFetcher(
      [firstResponse, secondResponse],
      {},
      (_request, count) => capturedBeforeRepair.push(count()),
      () => captured.length,
    ),
  );

  const result = await backend.invoke(input());

  expect(result.kind).toBe("SUCCESS");
  expect(capturedBeforeRepair).toEqual([2, 3]);
  expect(result.receipt?.session.turnIds).toEqual([
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
  ]);
  expect(result.receipt?.session.responseIds).toEqual([
    "response-before-repair",
    "response-after-repair",
  ]);
  expect(result.receipt?.rawArtifacts.map(({ purpose }) => purpose)).toEqual([
    "HEALTH",
    "MODEL_CATALOG",
    "TURN_RESPONSE",
    "SCHEMA_REPAIR_RESPONSE",
  ]);
});

test("keeps incomplete completion ambiguous and never retries it", async () => {
  const partial = [
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":"partial"}',
    "",
  ].join("\n");
  let postCount = 0;
  const { backend } = backendOptions(
    bridgeFetcher(
      [
        new Response(partial, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ],
      {},
      () => {
        postCount += 1;
      },
    ),
  );

  const result = await backend.invoke(input());
  const reconciliation = await backend.reconcile(input());

  expect(result.kind).toBe("UNKNOWN_SEND");
  expect(result.receipt?.outcome).toBe("INCOMPLETE");
  expect(reconciliation).toEqual({ kind: "STILL_UNKNOWN" });
  expect(postCount).toBe(1);
});

test("persists only the exact bounded prefix of an overlarge response", async () => {
  const fullResponse = new TextEncoder().encode(
    sse("response-too-large", JSON.stringify(workerOutput())),
  );
  const limit = 128;
  const { backend, captured } = backendOptions(
    bridgeFetcher([
      new Response(
        streamFromChunks([fullResponse.slice(0, 64), fullResponse.slice(64)]),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
    ]),
    { maxResponseBytes: limit },
  );

  const result = await backend.invoke(input());
  const boundedPrefix = fullResponse.slice(0, limit);

  expect(result.kind).toBe("UNKNOWN_SEND");
  expect(result.rawBytes).toEqual(boundedPrefix);
  expect(result.receipt?.outcome).toBe("AMBIGUOUS");
  expect(captured).toContainEqual(boundedPrefix);
});

test("keeps a completed turn unknown when its receipt cannot be persisted", async () => {
  const response = jsonSse("response-without-receipt", workerOutput());
  const { backend } = backendOptions(bridgeFetcher([response]), {
    persistRawArtifact: async (bytes) => {
      const text = Buffer.from(bytes).toString("utf8");
      if (text.includes('"schemaVersion":"nr-backend-turn-receipt/1"')) {
        throw new Error("receipt store unavailable");
      }
      return artifactReference(bytes, 1);
    },
  });

  const result = await backend.invoke(input());

  expect(result).toMatchObject({
    kind: "UNKNOWN_SEND",
    sendState: "UNKNOWN",
    rawArtifacts: [
      { purpose: "HEALTH" },
      { purpose: "MODEL_CATALOG" },
      { purpose: "TURN_RESPONSE" },
    ],
  });
  expect(result.receiptArtifact).toBeUndefined();
  expect(result.primaryRawArtifact).toBeDefined();
});

test("blocks wrong bridge version and unsupported effort before POST", async () => {
  let postCount = 0;
  const wrongVersion = backendOptions(
    bridgeFetcher([], { version: "6.1.2" }, () => {
      postCount += 1;
    }),
  ).backend;
  await expect(wrongVersion.checkCompatibility()).rejects.toMatchObject({
    code: "UNSUPPORTED_BRIDGE_VERSION",
  });

  const wrongEffort = backendOptions(
    bridgeFetcher([], { efforts: ["low"] }, () => {
      postCount += 1;
    }),
  ).backend;
  await expect(wrongEffort.checkCompatibility()).rejects.toBeInstanceOf(
    ChatGptWebBackendError,
  );
  await expect(wrongEffort.checkCompatibility()).rejects.toMatchObject({
    code: "EFFORT_UNAVAILABLE",
  });
  expect(postCount).toBe(0);
});

test("supports a read-only explicit version candidate canary", async () => {
  const { backend } = backendOptions(bridgeFetcher([], { version: "6.1.4" }));

  const candidate = await backend.checkCompatibility({
    expectedBridgeVersion: "6.1.4",
  });

  expect(candidate.version).toBe("6.1.4");
  expect(candidate.rawArtifacts.map(({ purpose }) => purpose)).toEqual([
    "HEALTH",
    "MODEL_CATALOG",
  ]);
  await expect(backend.checkCompatibility()).rejects.toMatchObject({
    code: "UNSUPPORTED_BRIDGE_VERSION",
  });
});

test("marks a broken stream after HTTP acceptance as unknown and preserves captured bytes", async () => {
  const encoder = new TextEncoder();
  let deliveredChunk = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (deliveredChunk) {
        controller.error(new Error("socket closed"));
      } else {
        deliveredChunk = true;
        controller.enqueue(
          encoder.encode("event: response.output_text.delta\n"),
        );
      }
    },
  });
  const { backend, captured } = backendOptions(
    bridgeFetcher([
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    ]),
  );

  const result = await backend.invoke(input());

  expect(result.kind).toBe("UNKNOWN_SEND");
  expect(result.receipt?.outcome).toBe("DISCONNECTED");
  expect(result.rawBytes).toEqual(
    encoder.encode("event: response.output_text.delta\n"),
  );
  expect(captured).toContainEqual(result.rawBytes);
});

test("cancels the owned response stream and records an aborted attempt", async () => {
  let resolveTurnStarted: () => void = () => undefined;
  const turnStarted = new Promise<void>((resolve) => {
    resolveTurnStarted = resolve;
  });
  let streamCancelled = false;
  const responseBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode("event: response.output_text.delta\n"),
      );
    },
    cancel() {
      streamCancelled = true;
    },
  });
  const { backend } = backendOptions(
    bridgeFetcher(
      [
        new Response(responseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ],
      {},
      () => resolveTurnStarted(),
    ),
  );
  const controller = new AbortController();
  const pending = backend.invoke(input({ signal: controller.signal }));
  await turnStarted;
  controller.abort();

  const result = await pending;

  expect(result.kind).toBe("UNKNOWN_SEND");
  expect(result.receipt?.outcome).toBe("ABORTED");
  expect(streamCancelled).toBe(true);
});

test("classifies its bounded request timeout as ambiguous", async () => {
  let resolveTurnStarted: () => void = () => undefined;
  const turnStarted = new Promise<void>((resolve) => {
    resolveTurnStarted = resolve;
  });
  let streamCancelled = false;
  const responseBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode("event: response.output_text.delta\n"),
      );
    },
    cancel() {
      streamCancelled = true;
    },
  });
  const { backend } = backendOptions(
    bridgeFetcher(
      [
        new Response(responseBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ],
      {},
      () => resolveTurnStarted(),
    ),
    { requestTimeoutMs: 25 },
  );
  const result = backend.invoke(input());
  await turnStarted;

  const terminal = await result;

  expect(terminal.kind).toBe("UNKNOWN_SEND");
  expect(terminal.receipt?.outcome).toBe("AMBIGUOUS");
  expect(streamCancelled).toBe(true);
});

test("fails closed on a response model mismatch without schema repair", async () => {
  let postCount = 0;
  const { backend } = backendOptions(
    bridgeFetcher(
      [
        jsonSse("response-wrong-model", workerOutput(), {
          model: "gpt-6.1-sol",
        }),
      ],
      {},
      () => {
        postCount += 1;
      },
    ),
  );

  const result = await backend.invoke(input());

  expect(result.kind).toBe("PERMANENT_FAILURE");
  expect(result.receipt?.outcome).toBe("FAILED");
  expect(postCount).toBe(1);
});

test("fails closed when the completed turn reports the wrong effort", async () => {
  const { backend } = backendOptions(
    bridgeFetcher([
      jsonSse("response-wrong-effort", workerOutput(), {
        reasoning: { effort: "low" },
      }),
    ]),
  );

  const result = await backend.invoke(input());

  expect(result.kind).toBe("PERMANENT_FAILURE");
  expect(result.receipt?.model.reasoningEffortObserved).toBe("low");
});

test("preserves typed terminal bridge failures without treating them as success", async () => {
  const failure = [
    "event: response.failed",
    'data: {"type":"response.failed","response":{"id":"response-failed","status":"failed","error":{"type":"connector_error","code":"connector_not_found"}}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const { backend } = backendOptions(
    bridgeFetcher([
      new Response(failure, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    ]),
  );

  const result = await backend.invoke(input());

  expect(result.kind).toBe("PERMANENT_FAILURE");
  expect(result.receipt?.outcome).toBe("FAILED");
  expect(result.rawBytes).toEqual(new TextEncoder().encode(failure));
});

test("does not send a Responses turn after cancellation before invocation", async () => {
  let postCount = 0;
  const { backend } = backendOptions(
    bridgeFetcher([], {}, () => {
      postCount += 1;
    }),
  );
  const controller = new AbortController();
  controller.abort();

  const result = await backend.invoke(input({ signal: controller.signal }));

  expect(result.kind).toBe("PERMANENT_FAILURE");
  expect(postCount).toBe(0);
});

test("records cancellation after preflight as proven unsent before the POST", async () => {
  const controller = new AbortController();
  const reportedSendStates: Array<"UNSENT" | "UNKNOWN"> = [];
  let postCount = 0;
  const { backend } = backendOptions(
    bridgeFetcher([], {}, () => {
      postCount += 1;
    }),
    {
      persistRawArtifact: async (bytes) => {
        const copy = Uint8Array.from(bytes);
        const reference = artifactReference(copy, 1);
        if (Buffer.from(copy).includes(Buffer.from('"models"'))) {
          controller.abort();
        }
        return reference;
      },
    },
  );

  const result = await backend.invoke(
    input({
      signal: controller.signal,
      reportSendState: (state) => reportedSendStates.push(state),
    }),
  );

  expect(result).toMatchObject({
    kind: "PERMANENT_FAILURE",
    errorClass: "PERMANENT",
    sendState: "UNSENT",
    receipt: {
      outcome: "ABORTED",
      sendState: "UNSENT",
      session: { turnIds: [], responseIds: [] },
    },
  });
  expect(result.receiptArtifact).toBeDefined();
  expect(postCount).toBe(0);
  expect(reportedSendStates).toEqual(["UNSENT"]);
});
