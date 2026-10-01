import { afterAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  EvidenceWriterError,
  FileStageEvidenceRecorder,
  loadBridgeSettings,
  loadUnavailableBridgeSettings,
  ModelCatalogHttpError,
  requireIdleBridge,
  resolveLiveMode,
  runAc1Only,
  runAc1OnlyWithEvidence,
  runPreflight,
  runUnavailableConnectorProbe,
  validateReleaseClientVersion,
  validateStageLedger,
  verifyBridge,
} from "../scripts/bridge-spike";

const PREFLIGHT_ENV = {
  BRIDGE_SPIKE_BASE_URL: "http://127.0.0.1:17841",
  BRIDGE_SPIKE_API_KEY: "test-bearer-must-not-be-emitted",
  BRIDGE_SPIKE_MODEL: "chatgpt-web/gpt-5.6-sol",
  BRIDGE_SPIKE_CLIENT_VERSION: "0.159.0",
};
const unavailableTestRoot = privateTestRoot("nr02-unavailable-runner-");
const UNAVAILABLE_ENV = {
  BRIDGE_SPIKE_BASE_URL: "http://127.0.0.1:17841/",
  BRIDGE_SPIKE_MODEL: "chatgpt-web/gpt-5.6-sol",
  BRIDGE_SPIKE_EXPECTED_ISOLATED_PID: "24680",
  BRIDGE_SPIKE_EXPECTED_ISOLATED_PORT: "17841",
  BRIDGE_SPIKE_PRODUCTION_PORT: "17842",
  BRIDGE_SPIKE_UNAVAILABLE_EVIDENCE_PATH: resolve(
    unavailableTestRoot,
    "evidence.json",
  ),
};
type TestFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Initializes ignored private storage so CI fixtures satisfy the evidence writer's path boundary. */
function privateTestRoot(prefix: string): string {
  const evidenceRoot = resolve(".nightreviewer");
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  chmodSync(evidenceRoot, 0o700);
  return mkdtempSync(resolve(evidenceRoot, prefix));
}

afterAll(() => rmSync(unavailableTestRoot, { recursive: true, force: true }));

/** Reads the last complete snapshot emitted by the offline unavailable-route tests. */
function readUnavailableEvidence(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      UNAVAILABLE_ENV.BRIDGE_SPIKE_UNAVAILABLE_EVIDENCE_PATH,
      "utf8",
    ),
  ) as Record<string, unknown>;
}

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

/** Supplies an isolated full-mode health identity for the negative connector route. */
function healthyUnavailableBridge(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    service: "codex-chatgpt-web",
    status: "ok",
    pid: 24680,
    version: "6.1.3",
    port: 17841,
    mode: "full",
    accepting_turns: true,
    active_http_turns: 0,
    active_browser_turns: 0,
    ...overrides,
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

/** Supplies only fake health/Responses replies and records every loopback route without network access. */
function unavailableProbeFixture(
  response: Response,
  healthReplies: readonly Record<string, unknown>[] = [
    healthyUnavailableBridge(),
    healthyUnavailableBridge(),
  ],
): {
  readonly fetcher: TestFetch;
  readonly requests: Array<{
    readonly url: URL;
    readonly method: string;
    readonly headers: Headers;
    readonly body?: string;
  }>;
} {
  const requests: Array<{
    readonly url: URL;
    readonly method: string;
    readonly headers: Headers;
    readonly body?: string;
  }> = [];
  let healthReads = 0;
  const fetcher: TestFetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      ...(init?.body === undefined ? {} : { body: String(init.body) }),
    });
    if (url.pathname === "/healthz") {
      const health =
        healthReplies[Math.min(healthReads, healthReplies.length - 1)];
      healthReads += 1;
      if (!health) throw new Error("No mocked isolated health reply.");
      return Response.json(health);
    }
    if (url.pathname === "/v1/responses") return response;
    throw new Error(`Unexpected unavailable-probe route: ${url.pathname}`);
  };
  return { fetcher, requests };
}

/** Models the expected streamed missing-connector failure returned inside HTTP 200. */
function unavailableFailureResponse(
  status = 424,
  type = "connector_error",
  code = "connector_not_found",
  extraEvents: readonly {
    readonly name: string;
    readonly body: Record<string, unknown>;
  }[] = [],
): Response {
  return sseResponse([
    {
      name: "response.failed",
      body: {
        type: "response.failed",
        response: {
          id: "resp_nr02_unavailable",
          status: "failed",
          error: { status, type, code },
        },
      },
    },
    ...extraEvents,
  ]);
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
  const root = privateTestRoot("nr02-runner-flow-test-");
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

test("unavailable probe accepts only the guarded full-mode failure and writes a private receipt", async () => {
  expect(loadUnavailableBridgeSettings(UNAVAILABLE_ENV)).toEqual({
    baseUrl: new URL(UNAVAILABLE_ENV.BRIDGE_SPIKE_BASE_URL),
    model: "chatgpt-web/gpt-5.6-sol",
    expectedPid: 24680,
    expectedPort: 17841,
    productionPort: 17842,
    evidencePath: UNAVAILABLE_ENV.BRIDGE_SPIKE_UNAVAILABLE_EVIDENCE_PATH,
  });
  const fixture = unavailableProbeFixture(unavailableFailureResponse());
  const receipt = await runUnavailableConnectorProbe(
    UNAVAILABLE_ENV,
    fixture.fetcher,
  );

  expect(fixture.requests.map(({ url }) => url.pathname)).toEqual([
    "/healthz",
    "/v1/responses",
    "/healthz",
  ]);
  expect(fixture.requests.map(({ method }) => method)).toEqual([
    "GET",
    "POST",
    "GET",
  ]);
  expect(
    fixture.requests.filter(
      ({ url, method }) =>
        url.pathname === "/v1/responses" && method === "POST",
    ),
  ).toHaveLength(1);
  expect(
    fixture.requests.every(
      ({ url }) => !url.searchParams.has("client_version"),
    ),
  ).toBe(true);
  const responseRequest = fixture.requests[1];
  if (!responseRequest?.body)
    throw new Error("Responses request was not captured.");
  expect(responseRequest.headers.get("authorization")).toBeNull();
  expect([...responseRequest.headers.keys()].sort()).toEqual([
    "accept",
    "content-type",
  ]);
  const body = JSON.parse(responseRequest.body) as {
    model: string;
    reasoning: { effort: string };
    tools: Array<Record<string, unknown>>;
    tool_choice: Record<string, unknown>;
    parallel_tool_calls: boolean;
    text: { format: { schema: { required: string[] } } };
    client_metadata: Record<string, string>;
    input: Array<{ content?: Array<{ text?: string }> }>;
  };
  expect(body.model).toBe("chatgpt-web/gpt-5.6-sol");
  expect(body.reasoning).toEqual({ effort: "high" });
  expect(body.tools).toHaveLength(1);
  expect(body.tools[0]).toMatchObject({
    type: "function",
    name: "read_fixture",
    strict: true,
    parameters: {
      properties: { fixture: { enum: ["probe"] } },
      required: ["fixture"],
      additionalProperties: false,
    },
  });
  expect(body.tool_choice).toEqual({ type: "function", name: "read_fixture" });
  expect(body.parallel_tool_calls).toBe(false);
  expect(body.text.format.schema.required).toEqual([
    "canaryId",
    "fixtureSha256",
  ]);
  const metadata = JSON.parse(
    body.client_metadata["x-codex-turn-metadata"] ?? "{}",
  );
  expect(metadata).toMatchObject({ sandbox_mode: "read-only" });
  expect(Object.keys(metadata.workspaces)).toEqual([
    resolve("spikes/bridge/fixtures"),
  ]);
  expect(receipt).toMatchObject({
    check: "unavailable-connector",
    status: "pass",
    outcome: {
      kind: "failed",
      status: 424,
      errorType: "connector_error",
      code: "connector_not_found",
    },
    isolatedBridge: {
      service: "codex-chatgpt-web",
      pid: 24680,
      port: 17841,
      version: "6.1.3",
      mode: "full",
    },
    postHealth: "same-process-idle",
  });
  const evidence = readUnavailableEvidence();
  expect(evidence).toMatchObject({
    schemaVersion: "nr02-unavailable-evidence/1",
    expectedIsolatedPid: 24680,
    expectedIsolatedPort: 17841,
    productionPortGuard: 17842,
    model: "chatgpt-web/gpt-5.6-sol",
    responsesRequestAttempted: true,
    outerHttpStatus: 200,
    outerContentTypeClass: "text/event-stream",
    terminalOutcomeKind: "failed",
    typedStatus: 424,
    typedErrorType: "connector_error",
    typedCode: "connector_not_found",
    responseFailedObserved: true,
    responseCompletedObserved: false,
    responseIncompleteObserved: false,
    functionOrToolEvidenceObserved: false,
    readFixtureEvidenceObserved: false,
    continuationRequests: 0,
    fixtureReadsExecuted: 0,
    terminalClassification: "PASS",
    preHealth: {
      observed: true,
      pid: 24680,
      port: 17841,
      version: "6.1.3",
      mode: "full",
      acceptingTurns: true,
      activeHttpTurns: 0,
      activeBrowserTurns: 0,
      idle: true,
    },
    postHealth: {
      attempted: true,
      observed: true,
      sameProcess: true,
      idle: true,
    },
  });
  expect(
    statSync(UNAVAILABLE_ENV.BRIDGE_SPIKE_UNAVAILABLE_EVIDENCE_PATH).mode &
      0o777,
  ).toBe(0o600);
});

test("unavailable mode works with API key and client version both absent", async () => {
  const environments = [
    { ...UNAVAILABLE_ENV },
    { ...UNAVAILABLE_ENV, BRIDGE_SPIKE_API_KEY: "unused-test-bearer" },
    { ...UNAVAILABLE_ENV, BRIDGE_SPIKE_CLIENT_VERSION: "0.159.0" },
  ];
  for (const environment of environments) {
    const fixture = unavailableProbeFixture(unavailableFailureResponse());
    await runUnavailableConnectorProbe(environment, fixture.fetcher);
    expect(fixture.requests.map(({ url }) => url.pathname)).toEqual([
      "/healthz",
      "/v1/responses",
      "/healthz",
    ]);
  }
});

test("unavailable route rejects browser-only mode before sending a Responses request", async () => {
  const fixture = unavailableProbeFixture(unavailableFailureResponse(), [
    healthyUnavailableBridge({ mode: "browser-only" }),
  ]);
  await expect(
    runUnavailableConnectorProbe(UNAVAILABLE_ENV, fixture.fetcher),
  ).rejects.toThrow("pre-health check");
  expect(fixture.requests.map(({ url }) => url.pathname)).toEqual(["/healthz"]);
  expect(readUnavailableEvidence()).toMatchObject({
    responsesRequestAttempted: false,
    terminalClassification: "FAIL",
    failureStage: "pre_health_validation",
  });
});

test("unavailable configuration guards reject bad PID, ports, and base URL before any fetch", async () => {
  const cases = [
    { ...UNAVAILABLE_ENV, BRIDGE_SPIKE_EXPECTED_ISOLATED_PID: "0" },
    { ...UNAVAILABLE_ENV, BRIDGE_SPIKE_EXPECTED_ISOLATED_PID: "1.5" },
    {
      ...UNAVAILABLE_ENV,
      BRIDGE_SPIKE_EXPECTED_ISOLATED_PID: "9007199254740992",
    },
    { ...UNAVAILABLE_ENV, BRIDGE_SPIKE_EXPECTED_ISOLATED_PORT: "0" },
    { ...UNAVAILABLE_ENV, BRIDGE_SPIKE_EXPECTED_ISOLATED_PORT: "65536" },
    { ...UNAVAILABLE_ENV, BRIDGE_SPIKE_PRODUCTION_PORT: "65536" },
    { ...UNAVAILABLE_ENV, BRIDGE_SPIKE_PRODUCTION_PORT: "17841" },
    { ...UNAVAILABLE_ENV, BRIDGE_SPIKE_MODEL: "gpt-6.1-sol" },
    { ...UNAVAILABLE_ENV, BRIDGE_SPIKE_BASE_URL: "http://localhost:17841/" },
    { ...UNAVAILABLE_ENV, BRIDGE_SPIKE_BASE_URL: "http://127.0.0.1:17841" },
    {
      ...UNAVAILABLE_ENV,
      BRIDGE_SPIKE_EXPECTED_ISOLATED_PORT: "17843",
    },
  ];
  for (const environment of cases) {
    const fixture = unavailableProbeFixture(unavailableFailureResponse());
    await expect(
      runUnavailableConnectorProbe(environment, fixture.fetcher),
    ).rejects.toThrow();
    expect(fixture.requests).toHaveLength(0);
  }
});

test("unavailable evidence path must have an existing private parent under ignored storage", async () => {
  const missingParent = {
    ...UNAVAILABLE_ENV,
    BRIDGE_SPIKE_UNAVAILABLE_EVIDENCE_PATH: resolve(
      unavailableTestRoot,
      "missing-parent/evidence.json",
    ),
  };
  const fixture = unavailableProbeFixture(unavailableFailureResponse());
  await expect(
    runUnavailableConnectorProbe(missingParent, fixture.fetcher),
  ).rejects.toThrow("evidence could not be persisted");
  expect(fixture.requests).toHaveLength(0);

  const publicDirectory = resolve(unavailableTestRoot, "public-parent");
  mkdirSync(publicDirectory, { mode: 0o755 });
  chmodSync(publicDirectory, 0o755);
  try {
    const publicPath = {
      ...UNAVAILABLE_ENV,
      BRIDGE_SPIKE_UNAVAILABLE_EVIDENCE_PATH: resolve(
        publicDirectory,
        "evidence.json",
      ),
    };
    const publicFixture = unavailableProbeFixture(unavailableFailureResponse());
    await expect(
      runUnavailableConnectorProbe(publicPath, publicFixture.fetcher),
    ).rejects.toThrow("evidence could not be persisted");
    expect(publicFixture.requests).toHaveLength(0);
  } finally {
    rmSync(publicDirectory, { recursive: true, force: true });
  }
});

test("unavailable pre-health requires the exact expected PID and port", async () => {
  for (const health of [
    healthyUnavailableBridge({ pid: 24681 }),
    healthyUnavailableBridge({ port: 17843 }),
    healthyUnavailableBridge({ pid: 0 }),
    healthyUnavailableBridge({ port: undefined }),
    healthyUnavailableBridge({ service: "other" }),
    healthyUnavailableBridge({ version: "6.1.2" }),
    healthyUnavailableBridge({ accepting_turns: false }),
    healthyUnavailableBridge({ active_http_turns: 1 }),
    healthyUnavailableBridge({ active_browser_turns: 1 }),
  ]) {
    const fixture = unavailableProbeFixture(unavailableFailureResponse(), [
      health,
    ]);
    await expect(
      runUnavailableConnectorProbe(UNAVAILABLE_ENV, fixture.fetcher),
    ).rejects.toThrow("pre-health check");
    expect(fixture.requests.map(({ url }) => url.pathname)).toEqual([
      "/healthz",
    ]);
    expect(readUnavailableEvidence()).toMatchObject({
      responsesRequestAttempted: false,
      terminalClassification: "FAIL",
    });
  }
});

test("unavailable route never uses model catalog and persists non-stream HTTP mismatch before post-health", async () => {
  const fixture = unavailableProbeFixture(
    new Response("{}", {
      status: 201,
      headers: { "content-type": "application/json" },
    }),
  );
  await expect(
    runUnavailableConnectorProbe(UNAVAILABLE_ENV, fixture.fetcher),
  ).rejects.toThrow("HTTP 200 text/event-stream");
  expect(fixture.requests.map(({ url }) => url.pathname)).toEqual([
    "/healthz",
    "/v1/responses",
    "/healthz",
  ]);
  expect(
    fixture.requests.some(({ url }) => url.pathname === "/v1/models"),
  ).toBe(false);
  expect(readUnavailableEvidence()).toMatchObject({
    outerHttpStatus: 201,
    outerContentTypeClass: "application/json",
    postHealth: {
      attempted: true,
      observed: true,
      sameProcess: true,
      idle: true,
    },
    terminalClassification: "FAIL",
    failureStage: "responses_http",
  });
});

test("unavailable route rejects any typed error mismatch, completion, or incomplete stream", async () => {
  const cases = [
    {
      response: unavailableFailureResponse(500),
      expected: "typed connector_not_found contract",
    },
    {
      response: unavailableFailureResponse(424, "upstream_error"),
      expected: "typed connector_not_found contract",
    },
    {
      response: unavailableFailureResponse(
        424,
        "connector_error",
        "other_code",
      ),
      expected: "typed connector_not_found contract",
    },
    {
      response: unavailableFailureResponse(
        424,
        "connector_error",
        "connector_not_found",
        [
          {
            name: "response.completed",
            body: {
              type: "response.completed",
              response: { id: "resp_nr02_late_completion" },
            },
          },
        ],
      ),
      expected: "typed connector_not_found contract",
    },
    {
      response: unavailableFailureResponse(
        424,
        "connector_error",
        "connector_not_found",
        [
          {
            name: "response.incomplete",
            body: {
              type: "response.incomplete",
              response: { id: "resp_nr02_late_incomplete" },
            },
          },
        ],
      ),
      expected: "typed connector_not_found contract",
    },
    {
      response: unavailableFailureResponse(
        424,
        "connector_error",
        "connector_not_found",
        [
          {
            name: "response.failed",
            body: {
              type: "response.failed",
              response: {
                id: "resp_nr02_second_failure",
                error: {
                  status: 424,
                  type: "connector_error",
                  code: "connector_not_found",
                },
              },
            },
          },
        ],
      ),
      expected: "typed connector_not_found contract",
    },
    {
      response: sseResponse([
        {
          name: "response.created",
          body: {
            type: "response.created",
            response: { id: "resp_nr02_open" },
          },
        },
      ]),
      expected: "typed connector_not_found contract",
    },
  ];
  for (const testCase of cases) {
    const fixture = unavailableProbeFixture(testCase.response);
    await expect(
      runUnavailableConnectorProbe(UNAVAILABLE_ENV, fixture.fetcher),
    ).rejects.toThrow(testCase.expected);
    expect(fixture.requests.map(({ url }) => url.pathname)).toEqual([
      "/healthz",
      "/v1/responses",
      "/healthz",
    ]);
    expect(readUnavailableEvidence()).toMatchObject({
      responsesRequestAttempted: true,
      postHealth: { attempted: true, observed: true },
      terminalClassification: "FAIL",
    });
  }
});

test("unavailable route rejects function-call evidence without continuing to fixture or tool handling", async () => {
  const fixture = unavailableProbeFixture(
    unavailableFailureResponse(424, "connector_error", "connector_not_found", [
      {
        name: "response.output_item.added",
        body: {
          type: "response.output_item.added",
          item: {
            id: "item_nr02_unexpected_call",
            type: "function_call",
            call_id: "call_nr02_unexpected",
            name: "read_fixture",
          },
        },
      },
    ]),
  );
  await expect(
    runUnavailableConnectorProbe(UNAVAILABLE_ENV, fixture.fetcher),
  ).rejects.toThrow("typed connector_not_found contract");
  expect(fixture.requests.map(({ url }) => url.pathname)).toEqual([
    "/healthz",
    "/v1/responses",
    "/healthz",
  ]);
  expect(readUnavailableEvidence()).toMatchObject({
    functionOrToolEvidenceObserved: true,
    readFixtureEvidenceObserved: true,
    fixtureReadsExecuted: 0,
    continuationRequests: 0,
    postHealth: { attempted: true, observed: true },
    terminalClassification: "FAIL",
  });
});

test("unavailable route rejects a truncated sanitized trace even with the expected failure", async () => {
  const heartbeatFrames = Array.from({ length: 513 }, (_, index) => ({
    name: "response.heartbeat",
    body: { type: "response.heartbeat", index },
  }));
  const fixture = unavailableProbeFixture(
    unavailableFailureResponse(
      424,
      "connector_error",
      "connector_not_found",
      heartbeatFrames,
    ),
  );
  await expect(
    runUnavailableConnectorProbe(UNAVAILABLE_ENV, fixture.fetcher),
  ).rejects.toThrow("typed connector_not_found contract");
  expect(fixture.requests.map(({ url }) => url.pathname)).toEqual([
    "/healthz",
    "/v1/responses",
    "/healthz",
  ]);
  expect(readUnavailableEvidence()).toMatchObject({
    sanitizedSseTrace: { complete: false, frameCount: 512 },
    postHealth: { attempted: true, observed: true },
    terminalClassification: "FAIL",
  });
});

test("unavailable route checks post-health process identity and idle state", async () => {
  const changedHealth = [
    healthyUnavailableBridge({ pid: 24681 }),
    healthyUnavailableBridge({ port: 17843 }),
    healthyUnavailableBridge({ version: "6.1.2" }),
    healthyUnavailableBridge({ mode: "browser-only" }),
    healthyUnavailableBridge({ active_http_turns: 1 }),
    healthyUnavailableBridge({ active_browser_turns: 1 }),
  ];
  for (const postHealth of changedHealth) {
    const fixture = unavailableProbeFixture(unavailableFailureResponse(), [
      healthyUnavailableBridge(),
      postHealth,
    ]);
    await expect(
      runUnavailableConnectorProbe(UNAVAILABLE_ENV, fixture.fetcher),
    ).rejects.toThrow();
    expect(fixture.requests.map(({ url }) => url.pathname)).toEqual([
      "/healthz",
      "/v1/responses",
      "/healthz",
    ]);
    expect(readUnavailableEvidence()).toMatchObject({
      postHealth: { attempted: true, observed: true },
      terminalClassification: "FAIL",
      failureStage: "post_health",
    });
  }
});

test("unavailable mismatch evidence keeps only sanitized trace data", async () => {
  const argumentSecret = "D73_FUNCTION_ARGUMENT_SENTINEL";
  const outputSecret = "D73_MODEL_OUTPUT_SENTINEL";
  const fixture = unavailableProbeFixture(
    unavailableFailureResponse(424, "connector_error", "connector_not_found", [
      {
        name: "response.output_item.added",
        body: {
          type: "response.output_item.added",
          item: {
            id: "item_safe_1",
            type: "function_call",
            call_id: "call_safe_1",
            name: "read_fixture",
            arguments: argumentSecret,
          },
        },
      },
      {
        name: "response.output_text.delta",
        body: { type: "response.output_text.delta", delta: outputSecret },
      },
    ]),
  );
  await expect(
    runUnavailableConnectorProbe(UNAVAILABLE_ENV, fixture.fetcher),
  ).rejects.toThrow();
  const contents = readFileSync(
    UNAVAILABLE_ENV.BRIDGE_SPIKE_UNAVAILABLE_EVIDENCE_PATH,
    "utf8",
  );
  const responsesBody = JSON.parse(fixture.requests[1]?.body ?? "{}") as {
    input?: Array<{ content?: Array<{ text?: string }> }>;
  };
  const submittedPrompt = responsesBody.input?.[1]?.content?.[0]?.text ?? "";
  const canaryId = submittedPrompt.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/,
  )?.[0];
  expect(canaryId).toBeDefined();
  expect(contents).not.toContain(argumentSecret);
  expect(contents).not.toContain(outputSecret);
  if (canaryId) expect(contents).not.toContain(canaryId);
  expect(contents).not.toContain('"prompt"');
  expect(contents).not.toContain('"input"');
  expect(contents).toContain('"dataSha256"');
  expect(readUnavailableEvidence()).toMatchObject({
    functionOrToolEvidenceObserved: true,
    readFixtureEvidenceObserved: true,
    postHealth: { attempted: true, observed: true },
    terminalClassification: "FAIL",
  });
});

test("unavailable stream read failure persists its partial trace before post-health", async () => {
  const streamSecret = "D73_STREAM_ERROR_SENTINEL";
  let sentFrame = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sentFrame) {
          sentFrame = true;
          controller.enqueue(
            new TextEncoder().encode(
              'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_partial"}}\n\n',
            ),
          );
          return;
        }
        controller.error(new Error(streamSecret));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  const fixture = unavailableProbeFixture(response);
  await expect(
    runUnavailableConnectorProbe(UNAVAILABLE_ENV, fixture.fetcher),
  ).rejects.toThrow("could not be read completely");
  expect(fixture.requests.map(({ url }) => url.pathname)).toEqual([
    "/healthz",
    "/v1/responses",
    "/healthz",
  ]);
  const contents = readFileSync(
    UNAVAILABLE_ENV.BRIDGE_SPIKE_UNAVAILABLE_EVIDENCE_PATH,
    "utf8",
  );
  expect(contents).not.toContain(streamSecret);
  expect(readUnavailableEvidence()).toMatchObject({
    terminalOutcomeKind: "stream_error",
    sanitizedSseTrace: { complete: false, frameCount: 1 },
    postHealth: { attempted: true, observed: true },
    terminalClassification: "FAIL",
    failureStage: "sse_read",
  });
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

test("AC1 rejects native and unsupported model slugs before its first fetch", async () => {
  let fetchCalls = 0;
  const fetcher: TestFetch = async () => {
    fetchCalls += 1;
    return Response.json({});
  };

  expect(loadBridgeSettings(PREFLIGHT_ENV).model).toBe(
    "chatgpt-web/gpt-5.6-sol",
  );
  for (const model of [
    "gpt-6.1-sol",
    "gpt-5.6-sol",
    "chatgpt-web/high",
    "chatgpt-web/gpt-6.1-sol",
  ]) {
    await expect(
      runPreflight({ ...PREFLIGHT_ENV, BRIDGE_SPIKE_MODEL: model }, fetcher),
    ).rejects.toThrow(
      "BRIDGE_SPIKE_MODEL must equal chatgpt-web/gpt-5.6-sol; no request was sent.",
    );
    expect(() =>
      loadBridgeSettings({ ...PREFLIGHT_ENV, BRIDGE_SPIKE_MODEL: model }),
    ).toThrow(
      "BRIDGE_SPIKE_MODEL must equal chatgpt-web/gpt-5.6-sol; no request was sent.",
    );
  }
  expect(fetchCalls).toBe(0);
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

test("model catalog does not accept a native passthrough slug for AC1", async () => {
  const paths: string[] = [];
  const fetcher: TestFetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    paths.push(url.pathname);
    if (url.pathname === "/healthz") return Response.json(healthyBridge());
    if (url.pathname === "/v1/models") {
      return Response.json({
        models: [
          {
            slug: "gpt-6.1-sol",
            supported_reasoning_levels: [{ effort: "high" }],
          },
        ],
      });
    }
    throw new Error(`Unexpected local request path: ${url.pathname}`);
  };

  await expect(
    verifyBridge(loadBridgeSettings(PREFLIGHT_ENV), fetcher),
  ).rejects.toThrow("BRIDGE_SPIKE_MODEL is absent from the live catalog");
  expect(paths).toEqual(["/healthz", "/v1/models"]);
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
  const root = privateTestRoot("nr02-redaction-test-");
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
  const root = privateTestRoot("nr02-pre-request-test-");
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
  const root = privateTestRoot("nr02-response-attempt-test-");
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
  let initialRequestBody: Record<string, unknown> | undefined;
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
      const requestBody = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      if (responseCalls === 1) {
        initialRequestBody = requestBody;
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
  expect(initialRequestBody).toMatchObject({
    model: "chatgpt-web/gpt-5.6-sol",
    stream: true,
    tool_choice: { type: "function", name: "read_fixture" },
    parallel_tool_calls: false,
    reasoning: { effort: "high" },
  });
  expect(initialRequestBody?.previous_response_id).toBeUndefined();
  const tools = initialRequestBody?.tools as Array<Record<string, unknown>>;
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({
    type: "function",
    name: "read_fixture",
    strict: true,
  });
  expect(tools[0]?.parameters).toMatchObject({
    required: ["fixture"],
    additionalProperties: false,
  });
  const clientMetadata = initialRequestBody?.client_metadata as Record<
    string,
    string
  >;
  expect(Object.keys(clientMetadata)).toEqual(["x-codex-turn-metadata"]);
  const turnMetadata = JSON.parse(
    clientMetadata["x-codex-turn-metadata"] ?? "{}",
  ) as Record<string, unknown>;
  expect(turnMetadata).toMatchObject({
    thread_id: expect.any(String),
    turn_id: expect.any(String),
    request_kind: "turn",
    sandbox_mode: "read-only",
  });
  expect(turnMetadata.workspaces).toEqual({
    [resolve("spikes/bridge/fixtures")]: {},
  });
  expect(globalFetchCalls).toBe(0);
  expect(routes).toEqual([
    "/healthz",
    "/v1/models",
    "/healthz",
    "/v1/responses",
    "/v1/responses",
    "/healthz",
  ]);
  const ledger = readFileSync(store.evidencePath, "utf8");
  expect(
    validateStageLedger(ledger, store.evidenceRunId, "f".repeat(40)),
  ).toMatchObject({
    terminalStage: "terminal_success",
    lastProvenStage: "post_ac1_health_passed",
    requestSent: true,
    initialResponsesRequestSent: true,
  });
  const ledgerEvents = ledger
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(
    ledgerEvents.find((event) => event.stage === "settings_validated"),
  ).toMatchObject({
    model: "chatgpt-web/gpt-5.6-sol",
  });
  expect(
    ledgerEvents.find((event) => event.stage === "model_catalog_passed"),
  ).toMatchObject({
    model: "chatgpt-web/gpt-5.6-sol",
    reasoningEffort: "high",
  });
  expect(ledger).not.toContain(PREFLIGHT_ENV.BRIDGE_SPIKE_API_KEY);
  rmSync(store.root, { recursive: true, force: true });
});
