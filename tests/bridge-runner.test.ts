import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EvidenceWriterError,
  FileStageEvidenceRecorder,
  loadBridgeSettings,
  ModelCatalogHttpError,
  requireIdleBridge,
  resolveLiveMode,
  runAc1Only,
  runAc1OnlyWithEvidence,
  runPreflight,
  validateReleaseClientVersion,
  validateStageLedger,
  verifyBridge,
} from "../scripts/bridge-spike";

const PREFLIGHT_ENV = {
  BRIDGE_SPIKE_BASE_URL: "http://127.0.0.1:17841",
  BRIDGE_SPIKE_API_KEY: "test-bearer-must-not-be-emitted",
  BRIDGE_SPIKE_MODEL: "gpt-6.1-sol",
  BRIDGE_SPIKE_CLIENT_VERSION: "0.159.0",
};
type TestFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Supplies stable process identity and idle counts for offline bridge-contract tests. */
function healthyBridge(successfulCatalogRequests = 0) {
  return {
    service: "codex-chatgpt-web",
    status: "ok",
    pid: 12345,
    version: "6.1.3",
    mode: "full",
    accepting_turns: true,
    active_http_turns: 0,
    active_browser_turns: 0,
    successful_model_catalog_requests: successfulCatalogRequests,
  };
}

/** Serializes deterministic upstream frames so runner tests exercise the production SSE parser offline. */
function sseResponse(
  events: readonly {
    readonly name: string;
    readonly body: Record<string, unknown>;
  }[],
): Response {
  const payload = events
    .map(
      ({ name, body }) => `event: ${name}\ndata: ${JSON.stringify(body)}\n\n`,
    )
    .join("");
  return new Response(payload, {
    headers: { "content-type": "text/event-stream" },
  });
}

/** Produces a completed, optionally invalid tool-call turn for host-side callback validation tests. */
function functionCallResponse(toolName = "read_fixture"): Response {
  const item = {
    id: "item_nr02_call",
    type: "function_call",
    call_id: "call_nr02_fixture",
    name: toolName,
    arguments: JSON.stringify({ fixture: "probe" }),
  };
  return sseResponse([
    {
      name: "response.output_item.added",
      body: { type: "response.output_item.added", item },
    },
    {
      name: "response.output_item.done",
      body: { type: "response.output_item.done", item },
    },
    {
      name: "response.completed",
      body: {
        type: "response.completed",
        response: { id: "resp_nr02_initial" },
      },
    },
  ]);
}

/** Extracts only the generated test canary so a fake continuation can model exact correlation. */
function canaryFromRequest(init?: RequestInit): string {
  const requestBody = JSON.parse(String(init?.body)) as {
    input?: Array<{ content?: Array<{ text?: string }> }>;
  };
  const prompt = requestBody.input
    ?.flatMap((message) => message.content ?? [])
    .map((part) => part.text ?? "")
    .find((text) => text.includes("this canaryId: "));
  const canary = prompt?.match(/this canaryId: ([0-9a-f-]{36})/)?.[1];
  if (!canary) throw new Error("Mocked initial request omitted the canary.");
  return canary;
}

/** Creates a private temporary JSONL file and run identity for one fully injected runner scenario. */
function createEvidenceStore(headSha: string): {
  readonly root: string;
  readonly evidencePath: string;
  readonly evidenceRunId: string;
  readonly recorder: FileStageEvidenceRecorder;
} {
  const root = mkdtempSync(resolve(".nightreviewer", "nr02-runner-flow-test-"));
  const evidencePath = resolve(root, "stages.jsonl");
  const evidenceRunId = randomUUID();
  writeFileSync(evidencePath, "", { mode: 0o600 });
  return {
    root,
    evidencePath,
    evidenceRunId,
    recorder: new FileStageEvidenceRecorder(
      evidencePath,
      evidenceRunId,
      headSha,
    ),
  };
}

test("LIVE runner requires one explicit mode and rejects the former combined cancel flag", () => {
  expect(() => resolveLiveMode(["--live", "--live", "--ac1-only"])).toThrow(
    "Pass --live exactly once",
  );
  expect(() => resolveLiveMode(["--live"])).toThrow(
    "Choose exactly one explicit live mode",
  );
  expect(() =>
    resolveLiveMode(["--live", "--ac1-only", "--cancel-only"]),
  ).toThrow("Choose exactly one explicit live mode");
  expect(() => resolveLiveMode(["--live", "--cancel"])).toThrow(
    "Unknown live mode argument",
  );
  expect(resolveLiveMode(["--live", "--preflight-only"])).toBe(
    "--preflight-only",
  );
  expect(resolveLiveMode(["--live", "--ac1-only"])).toBe("--ac1-only");
  expect(resolveLiveMode(["--live", "--cancel-only"])).toBe("--cancel-only");
});

test("pre-LIVE bridge guard requires both active-turn counts to be zero", () => {
  expect(() =>
    requireIdleBridge(
      { active_http_turns: 0, active_browser_turns: 0 },
      "before model discovery",
    ),
  ).not.toThrow();
  expect(() =>
    requireIdleBridge(
      { active_http_turns: 1, active_browser_turns: 0 },
      "before model discovery",
    ),
  ).toThrow("zero active HTTP and browser turns");
  expect(() =>
    requireIdleBridge({ active_http_turns: 0 }, "after model discovery"),
  ).toThrow("zero active HTTP and browser turns");
});

test("AC1 generates one canary, calls one fresh context, and returns only sanitized receipt fields", async () => {
  const settings = {
    baseUrl: new URL("http://127.0.0.1:17841/"),
    apiKey: "test-api-key-that-must-not-be-emitted",
    model: "test-model",
    clientVersion: "0.159.0",
  };
  const canaries: string[] = [];
  const receipt = await runAc1Only(settings, async (_settings, canaryId) => {
    canaries.push(canaryId);
    const fixtureSha256 = "a".repeat(64);
    const liveTrace = {
      schemaVersion: "nr02-live-trace/1",
      requestIdentity: { threadId: "thread-1", turnId: "turn-1" },
      model: settings.model,
      startedAt: "2026-09-30T00:00:00.000Z",
      finishedAt: "2026-09-30T00:00:01.000Z",
      elapsedMs: 1_000,
      responseLegs: [],
      fixtureRead: {
        startedAt: "2026-09-30T00:00:00.500Z",
        finishedAt: "2026-09-30T00:00:00.501Z",
        elapsedMs: 1,
        fixture: "probe",
        byteLength: 97,
        fixtureSha256,
        toolCall: {
          name: "read_fixture",
          itemId: "item-1",
          callId: "call-1",
          arguments: { fixture: "probe" },
          argumentsSha256: "b".repeat(64),
        },
        toolOutput: { byteLength: 150, sha256: "c".repeat(64) },
      },
      structuredResult: {
        responseId: "response-final",
        canaryId,
        fixtureSha256,
      },
    };
    return {
      threadId: "thread-1",
      turnId: "turn-1",
      canaryId,
      firstResponseId: "response-call",
      finalResponseId: "response-final",
      callId: "call-1",
      fixtureSha256,
      observedOutput: "fixture contents and model output are private",
      initialEvents: ["response.completed"],
      continuationEvents: ["response.completed"],
      liveTrace,
      liveTraceSha256: "d".repeat(64),
      liveTraceBytes: 1_000,
    } as never;
  });

  expect(canaries).toHaveLength(1);
  const generatedCanary = canaries[0];
  if (generatedCanary === undefined) {
    throw new Error("The AC1 runner did not pass its generated canary.");
  }
  expect(generatedCanary).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(receipt.canaryId).toBe(generatedCanary);
  expect(receipt.liveTrace.structuredResult.canaryId).toBe(generatedCanary);
  expect(receipt.liveTraceSha256).toBe("d".repeat(64));
  const serialized = JSON.stringify(receipt);
  expect(serialized).not.toContain(settings.apiKey);
  expect(serialized).not.toContain("fixture contents");
  expect(serialized).not.toContain("observedOutput");
});

test("client version accepts only release major.minor.patch values", () => {
  expect(validateReleaseClientVersion("0.159.0")).toBe("0.159.0");
  for (const value of [
    "0.159",
    "v0.159.0",
    "0.159.0-beta.1",
    "1.02.3",
    "0.159.0&x=y",
  ]) {
    expect(() => validateReleaseClientVersion(value)).toThrow(
      "BRIDGE_SPIKE_CLIENT_VERSION must be release semver major.minor.patch",
    );
  }
});

test("preflight requires a valid client version before it can call fetch", async () => {
  let fetchCalls = 0;
  const fetcher: TestFetch = async () => {
    fetchCalls += 1;
    return Response.json({});
  };

  const missingVersion = { ...PREFLIGHT_ENV };
  delete (missingVersion as Partial<typeof missingVersion>)
    .BRIDGE_SPIKE_CLIENT_VERSION;
  await expect(runPreflight(missingVersion, fetcher)).rejects.toThrow(
    "BRIDGE_SPIKE_CLIENT_VERSION is required; no request was sent.",
  );
  expect(fetchCalls).toBe(0);

  const malformedVersion = {
    ...PREFLIGHT_ENV,
    BRIDGE_SPIKE_CLIENT_VERSION: "0.159.0&account=private",
  };
  await expect(runPreflight(malformedVersion, fetcher)).rejects.toThrow(
    "BRIDGE_SPIKE_CLIENT_VERSION must be release semver major.minor.patch; no request was sent.",
  );
  expect(fetchCalls).toBe(0);
  expect(() => loadBridgeSettings(malformedVersion)).toThrow();
});

test("preflight sends one explicit client_version and no Responses request", async () => {
  const requests: Array<{
    url: URL;
    method: string;
    headers: Headers;
  }> = [];
  let healthReads = 0;
  const fetcher: TestFetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    requests.push({ url, method: init?.method ?? "GET", headers });
    if (url.pathname === "/healthz") {
      healthReads += 1;
      return Response.json(healthyBridge(healthReads === 1 ? 0 : 1));
    }
    if (url.pathname === "/v1/models") {
      return Response.json({
        models: [
          {
            slug: PREFLIGHT_ENV.BRIDGE_SPIKE_MODEL,
            supported_reasoning_levels: [{ effort: "high" }],
          },
        ],
      });
    }
    throw new Error(`Unexpected local request path: ${url.pathname}`);
  };

  const originalLog = console.log;
  const output: string[] = [];
  console.log = (...values: unknown[]) =>
    output.push(values.map(String).join(" "));
  try {
    await runPreflight(PREFLIGHT_ENV, fetcher);
  } finally {
    console.log = originalLog;
  }

  expect(requests.map(({ url }) => url.pathname)).toEqual([
    "/healthz",
    "/v1/models",
    "/healthz",
  ]);
  expect(requests.map(({ method }) => method)).toEqual(["GET", "GET", "GET"]);
  const catalogRequest = requests[1];
  if (!catalogRequest) throw new Error("Catalog request was not captured.");
  expect(catalogRequest.url.searchParams.getAll("client_version")).toEqual([
    "0.159.0",
  ]);
  expect(catalogRequest.headers.get("authorization")).toBe(
    `Bearer ${PREFLIGHT_ENV.BRIDGE_SPIKE_API_KEY}`,
  );
  expect(catalogRequest.headers.get("accept")).toBe("application/json");
  expect([...catalogRequest.headers.keys()].sort()).toEqual([
    "accept",
    "authorization",
  ]);
  expect(requests.some(({ url }) => url.pathname === "/v1/responses")).toBe(
    false,
  );
  expect(output.join("\n")).not.toContain(PREFLIGHT_ENV.BRIDGE_SPIKE_API_KEY);
});

test("catalog failure receipt retains numeric status and only safe health classification", async () => {
  const bodyMarker = "private-account-response-body";
  const health = {
    ...healthyBridge(),
    last_model_catalog_result: {
      status: 401,
      failure: { stage: "request", code: "unauthorized" },
      account: "private-account-data",
      url: "https://private.example/account",
    },
  };
  const fetcher: TestFetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/healthz") return Response.json(health);
    return new Response(bodyMarker, { status: 429 });
  };

  let caught: unknown;
  try {
    await verifyBridge(loadBridgeSettings(PREFLIGHT_ENV), fetcher);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ModelCatalogHttpError);
  if (!(caught instanceof ModelCatalogHttpError)) {
    throw new Error("Expected a typed catalog failure.");
  }

  const receipt = caught.toSanitizedReceipt();
  expect(receipt).toEqual({
    check: "bridge-model-catalog",
    status: "fail",
    httpStatus: 429,
    healthLastModelCatalogResult: {
      status: 401,
      failureStage: "request",
      failureCode: "unauthorized",
    },
  });
  const serialized = JSON.stringify(receipt);
  for (const privateValue of [
    PREFLIGHT_ENV.BRIDGE_SPIKE_API_KEY,
    bodyMarker,
    "private-account-data",
    "private.example",
  ]) {
    expect(serialized).not.toContain(privateValue);
  }
  expect(caught.message).not.toContain(PREFLIGHT_ENV.BRIDGE_SPIKE_API_KEY);
  expect(caught.message).not.toContain(bodyMarker);
});

test("stage writer rejects an unallowlisted secret field before it reaches durable evidence", () => {
  const root = mkdtempSync(resolve(".nightreviewer", "nr02-redaction-test-"));
  const evidencePath = resolve(root, "stages.jsonl");
  writeFileSync(evidencePath, "", { mode: 0o600 });
  const secretSentinel = "NR02_DO_NOT_PERSIST_1e87";
  const recorder = new FileStageEvidenceRecorder(
    evidencePath,
    randomUUID(),
    "d".repeat(40),
  );
  try {
    recorder.record("runner_started");
    expect(() =>
      recorder.record("settings_validated", {
        apiKey: secretSentinel,
      } as never),
    ).toThrow(EvidenceWriterError);
  } finally {
    recorder.close();
  }
  const contents = readFileSync(evidencePath, "utf8");
  expect(contents).not.toContain(secretSentinel);
  expect(contents).toContain('"stage":"runner_started"');
  rmSync(root, { recursive: true, force: true });
});

test("pre-request settings failure persists a terminal receipt with requestSent=false", async () => {
  const root = mkdtempSync(resolve(".nightreviewer", "nr02-pre-request-test-"));
  const evidencePath = resolve(root, "stages.jsonl");
  writeFileSync(evidencePath, "", { mode: 0o600 });
  const evidenceRunId = randomUUID();
  const recorder = new FileStageEvidenceRecorder(
    evidencePath,
    evidenceRunId,
    "a".repeat(40),
  );
  const environment = { ...PREFLIGHT_ENV };
  delete (environment as Partial<typeof environment>).BRIDGE_SPIKE_API_KEY;
  let fetchCalls = 0;
  try {
    await expect(
      runAc1OnlyWithEvidence(environment, recorder, async () => {
        fetchCalls += 1;
        return Response.json({});
      }),
    ).rejects.toThrow("BRIDGE_SPIKE_API_KEY is required; no request was sent.");
  } finally {
    recorder.close();
  }
  expect(fetchCalls).toBe(0);
  expect(
    validateStageLedger(
      readFileSync(evidencePath, "utf8"),
      evidenceRunId,
      "a".repeat(40),
    ),
  ).toMatchObject({
    terminalStage: "terminal_failure",
    lastProvenStage: "runner_started",
    requestSent: false,
    initialResponsesRequestSent: false,
  });
  rmSync(root, { recursive: true, force: true });
});

test("initial Responses transport failure records attempt before fetch and no false response or fixture result", async () => {
  const root = mkdtempSync(
    resolve(".nightreviewer", "nr02-response-attempt-test-"),
  );
  const evidencePath = resolve(root, "stages.jsonl");
  writeFileSync(evidencePath, "", { mode: 0o600 });
  const evidenceRunId = randomUUID();
  const headSha = "b".repeat(40);
  const recorder = new FileStageEvidenceRecorder(
    evidencePath,
    evidenceRunId,
    headSha,
  );
  let healthReads = 0;
  let responseFetchCount = 0;
  const networkErrorSentinel = "PRIVATE_TRANSPORT_ERROR_SENTINEL";
  const fetcher: TestFetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/healthz") {
      healthReads += 1;
      return Response.json(healthyBridge(healthReads === 1 ? 0 : 1));
    }
    if (url.pathname === "/v1/models") {
      return Response.json({
        models: [
          {
            slug: PREFLIGHT_ENV.BRIDGE_SPIKE_MODEL,
            supported_reasoning_levels: [{ effort: "high" }],
          },
        ],
      });
    }
    if (url.pathname === "/v1/responses") {
      responseFetchCount += 1;
      const beforeFetch = readFileSync(evidencePath, "utf8");
      expect(beforeFetch).toContain('"stage":"initial_responses_attempted"');
      expect(beforeFetch).not.toContain('"stage":"initial_responses_received"');
      throw new TypeError(networkErrorSentinel);
    }
    throw new Error("Unexpected mocked bridge route.");
  };
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await expect(
      runAc1OnlyWithEvidence(PREFLIGHT_ENV, recorder, fetcher),
    ).rejects.toThrow(TypeError);
  } finally {
    console.log = originalLog;
    recorder.close();
  }
  expect(responseFetchCount).toBe(1);
  const ledger = readFileSync(evidencePath, "utf8");
  expect(ledger).not.toContain(networkErrorSentinel);
  expect(ledger).not.toContain('"stage":"initial_responses_received"');
  expect(ledger).not.toContain('"stage":"tool_call_observed"');
  expect(ledger).not.toContain('"stage":"controlled_fixture_result_prepared"');
  expect(validateStageLedger(ledger, evidenceRunId, headSha)).toMatchObject({
    terminalStage: "terminal_failure",
    lastProvenStage: "initial_responses_attempted",
    requestSent: true,
    initialResponsesRequestSent: "UNKNOWN",
  });
  rmSync(root, { recursive: true, force: true });
});

test("tool-call, fixture, continuation, and final-correlation failures keep the furthest proven stage", async () => {
  const fixtureBytes = Buffer.from(
    "controlled synthetic fixture bytes",
    "utf8",
  );
  const failureCases = [
    {
      name: "tool call validation",
      expectedLastStage: "initial_responses_stream_ended",
      readFixture: async (): Promise<Uint8Array> => fixtureBytes,
      continuationFailure: false,
      wrongCanary: false,
      invalidToolCall: true,
    },
    {
      name: "fixture read",
      expectedLastStage: "controlled_fixture_read_attempted",
      readFixture: async (): Promise<Uint8Array> => {
        throw new Error("PRIVATE_FIXTURE_FAILURE_SENTINEL");
      },
      continuationFailure: false,
      wrongCanary: false,
      invalidToolCall: false,
    },
    {
      name: "continuation request",
      expectedLastStage: "continuation_responses_attempted",
      readFixture: async (): Promise<Uint8Array> => fixtureBytes,
      continuationFailure: true,
      wrongCanary: false,
      invalidToolCall: false,
    },
    {
      name: "final correlation",
      expectedLastStage: "continuation_responses_stream_ended",
      readFixture: async (): Promise<Uint8Array> => fixtureBytes,
      continuationFailure: false,
      wrongCanary: true,
      invalidToolCall: false,
    },
  ] as const;

  for (const failureCase of failureCases) {
    const store = createEvidenceStore("e".repeat(40));
    let healthReads = 0;
    let responseCalls = 0;
    let canaryId: string | undefined;
    const fetcher: TestFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/healthz") {
        healthReads += 1;
        return Response.json(healthyBridge(healthReads === 1 ? 0 : 1));
      }
      if (url.pathname === "/v1/models") {
        return Response.json({
          models: [
            {
              slug: PREFLIGHT_ENV.BRIDGE_SPIKE_MODEL,
              supported_reasoning_levels: [{ effort: "high" }],
            },
          ],
        });
      }
      if (url.pathname === "/v1/responses") {
        responseCalls += 1;
        if (responseCalls === 1) {
          canaryId = canaryFromRequest(init);
          return functionCallResponse(
            failureCase.invalidToolCall ? "unapproved_tool" : "read_fixture",
          );
        }
        if (failureCase.continuationFailure) {
          throw new TypeError("PRIVATE_CONTINUATION_FAILURE_SENTINEL");
        }
        const fixtureSha256 = createHash("sha256")
          .update(fixtureBytes)
          .digest("hex");
        const result = {
          canaryId: failureCase.wrongCanary ? randomUUID() : canaryId,
          fixtureSha256,
        };
        return sseResponse([
          {
            name: "response.output_text.delta",
            body: {
              type: "response.output_text.delta",
              delta: JSON.stringify(result),
            },
          },
          {
            name: "response.completed",
            body: {
              type: "response.completed",
              response: { id: "resp_nr02_final" },
            },
          },
        ]);
      }
      throw new Error("Unexpected mocked route.");
    };
    const originalLog = console.log;
    console.log = () => undefined;
    let caught: unknown;
    try {
      await runAc1OnlyWithEvidence(PREFLIGHT_ENV, store.recorder, fetcher, {
        readFixture: failureCase.readFixture,
      });
    } catch (error) {
      caught = error;
    } finally {
      console.log = originalLog;
      store.recorder.close();
    }
    expect(caught).toBeInstanceOf(Error);
    const ledgerContents = readFileSync(store.evidencePath, "utf8");
    expect(ledgerContents).not.toContain("PRIVATE_FIXTURE_FAILURE_SENTINEL");
    expect(ledgerContents).not.toContain(
      "PRIVATE_CONTINUATION_FAILURE_SENTINEL",
    );
    const summary = validateStageLedger(
      ledgerContents,
      store.evidenceRunId,
      "e".repeat(40),
    );
    expect(summary).toMatchObject({
      terminalStage: "terminal_failure",
      lastProvenStage: failureCase.expectedLastStage,
      requestSent: true,
      initialResponsesRequestSent: true,
    });
    expect(ledgerContents).toContain(
      `"stage":"${failureCase.expectedLastStage}"`,
    );
    expect(ledgerContents).not.toContain('"stage":"terminal_success"');
    store.recorder.close();
    rmSync(store.root, { recursive: true, force: true });
  }
});

test("fully simulated AC1 persists ordered stages and never reaches global fetch", async () => {
  const store = createEvidenceStore("f".repeat(40));
  const fixtureBytes = Buffer.from(
    "controlled synthetic fixture bytes",
    "utf8",
  );
  const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
  const routes: string[] = [];
  let healthReads = 0;
  let responseCalls = 0;
  let canaryId: string | undefined;
  const fetcher: TestFetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    routes.push(url.pathname);
    if (url.pathname === "/healthz") {
      healthReads += 1;
      return Response.json(healthyBridge(healthReads === 1 ? 0 : 1));
    }
    if (url.pathname === "/v1/models") {
      return Response.json({
        models: [
          {
            slug: PREFLIGHT_ENV.BRIDGE_SPIKE_MODEL,
            supported_reasoning_levels: [{ effort: "high" }],
          },
        ],
      });
    }
    if (url.pathname === "/v1/responses") {
      responseCalls += 1;
      if (responseCalls === 1) {
        canaryId = canaryFromRequest(init);
        return functionCallResponse();
      }
      const output = JSON.stringify({ canaryId, fixtureSha256 });
      return sseResponse([
        {
          name: "response.output_text.delta",
          body: { type: "response.output_text.delta", delta: output },
        },
        {
          name: "response.completed",
          body: {
            type: "response.completed",
            response: { id: "resp_nr02_final" },
          },
        },
      ]);
    }
    throw new Error("Unexpected mocked route.");
  };
  const originalLog = console.log;
  const originalFetch = globalThis.fetch;
  let globalFetchCalls = 0;
  console.log = () => undefined;
  globalThis.fetch = (async () => {
    globalFetchCalls += 1;
    throw new Error("The injected runner must not use global fetch.");
  }) as unknown as typeof fetch;
  let receipt: Awaited<ReturnType<typeof runAc1OnlyWithEvidence>> | undefined;
  try {
    receipt = await runAc1OnlyWithEvidence(
      PREFLIGHT_ENV,
      store.recorder,
      fetcher,
      { readFixture: async () => fixtureBytes },
    );
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    store.recorder.close();
  }
  expect(receipt?.check).toBe("nr02-ac1");
  expect(receipt?.status).toBe("pass");
  expect(receipt?.fixture.sha256).toBe(fixtureSha256);
  expect(globalFetchCalls).toBe(0);
  expect(routes).toEqual([
    "/healthz",
    "/v1/models",
    "/healthz",
    "/v1/responses",
    "/v1/responses",
    "/healthz",
  ]);
  expect(
    validateStageLedger(
      readFileSync(store.evidencePath, "utf8"),
      store.evidenceRunId,
      "f".repeat(40),
    ),
  ).toMatchObject({
    terminalStage: "terminal_success",
    lastProvenStage: "post_ac1_health_passed",
    requestSent: true,
    initialResponsesRequestSent: true,
  });
  rmSync(store.root, { recursive: true, force: true });
});
