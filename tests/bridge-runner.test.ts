import { expect, test } from "bun:test";
import {
  loadBridgeSettings,
  ModelCatalogHttpError,
  requireIdleBridge,
  resolveLiveMode,
  runAc1Only,
  runPreflight,
  validateReleaseClientVersion,
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
