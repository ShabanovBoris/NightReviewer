import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  type BridgeFunctionCall,
  type BridgeSseOutcome,
  type BridgeSseTrace,
  readBridgeSse,
} from "../src/spikes/bridge-sse";
import { isStreamTerminationWithinAcknowledgementWindow } from "../src/spikes/cancellation-contract";

const EXPECTED_UPSTREAM_VERSION = "6.1.3";
const FIXTURE_KEY = "probe";
const FIXTURE_PATH = resolve("spikes/bridge/fixtures/probe.txt");
// The model sees only the controlled fixture tree, not the surrounding project checkout.
const FIXTURE_WORKSPACE = resolve(FIXTURE_PATH, "..");
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    canaryId: { type: "string" },
    fixtureSha256: { type: "string" },
  },
  required: ["canaryId", "fixtureSha256"],
  additionalProperties: false,
};

/** Local connection configuration stays process-local and is never copied into evidence. */
interface BridgeSettings {
  readonly baseUrl: URL;
  readonly apiKey: string;
  readonly model: string;
}

/** Carries the observed process identity into the post-AC1 health gate. */
interface BridgeProcessIdentity {
  readonly service: "codex-chatgpt-web";
  readonly pid: number;
  readonly version: typeof EXPECTED_UPSTREAM_VERSION;
  readonly mode: "full";
}

/** Matches the upstream identity pair whose cancellation and browser session share ownership. */
interface TurnIdentity {
  readonly threadId: string;
  readonly turnId: string;
}

/** Holds internal scan text separately from the serialized, digest-bound live receipt. */
interface SessionReceipt {
  readonly threadId: string;
  readonly turnId: string;
  readonly canaryId: string;
  readonly firstResponseId: string;
  readonly finalResponseId: string;
  readonly callId: string;
  readonly fixtureSha256: string;
  readonly observedOutput: string;
  readonly initialEvents: readonly string[];
  readonly continuationEvents: readonly string[];
  readonly liveTrace: {
    readonly schemaVersion: "nr02-live-trace/1";
    readonly requestIdentity: TurnIdentity;
    readonly model: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly elapsedMs: number;
    readonly responseLegs: readonly {
      readonly name: "function-call" | "tool-result-continuation";
      readonly startedAt: string;
      readonly finishedAt: string;
      readonly elapsedMs: number;
      readonly responseId: string;
      readonly sanitizedSse: BridgeSseTrace;
    }[];
    readonly fixtureRead: {
      readonly startedAt: string;
      readonly finishedAt: string;
      readonly elapsedMs: number;
      readonly fixture: string;
      readonly byteLength: number;
      readonly fixtureSha256: string;
      readonly toolCall: {
        readonly name: "read_fixture";
        readonly itemId: string;
        readonly callId: string;
        readonly arguments: { readonly fixture: "probe" };
        readonly argumentsSha256: string;
      };
      readonly toolOutput: {
        readonly byteLength: number;
        readonly sha256: string;
      };
    };
    readonly structuredResult: {
      readonly responseId: string;
      readonly canaryId: string;
      readonly fixtureSha256: string;
    };
  };
  readonly liveTraceSha256: string;
  readonly liveTraceBytes: number;
}

/** Missing settings stop the run before any key or prompt can be printed or sent. */
function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required; no request was sent.`);
  return value;
}

/** Keeps real prompts and credentials on the user's local loopback bridge. */
function loadBridgeSettings(): BridgeSettings {
  const rawBaseUrl = requiredEnvironment("BRIDGE_SPIKE_BASE_URL");
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error(
      "BRIDGE_SPIKE_BASE_URL must be a local HTTP origin; no request was sent.",
    );
  }
  const isLoopback =
    baseUrl.hostname === "127.0.0.1" ||
    baseUrl.hostname === "localhost" ||
    baseUrl.hostname === "[::1]";
  if (
    baseUrl.protocol !== "http:" ||
    !isLoopback ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.pathname !== "/" ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error(
      "BRIDGE_SPIKE_BASE_URL must be an unauthenticated local HTTP origin; no request was sent.",
    );
  }
  return {
    baseUrl,
    apiKey: requiredEnvironment("BRIDGE_SPIKE_API_KEY"),
    model: requiredEnvironment("BRIDGE_SPIKE_MODEL"),
  };
}

/** Resolves API paths only after loadBridgeSettings has restricted the destination to loopback. */
function endpoint(settings: BridgeSettings, path: string): URL {
  return new URL(path, settings.baseUrl);
}

/** Confirms the exact pinned service and model catalog before any model traffic starts. */
async function verifyBridge(
  settings: BridgeSettings,
): Promise<BridgeProcessIdentity> {
  const healthResponse = await fetch(endpoint(settings, "/healthz"));
  if (!healthResponse.ok)
    throw new Error(
      `Bridge health check returned HTTP ${healthResponse.status}.`,
    );
  const health = (await healthResponse.json()) as Record<string, unknown>;
  if (health.service !== "codex-chatgpt-web" || health.status !== "ok") {
    throw new Error(
      "The local endpoint is not a healthy codex-chatgpt-web bridge.",
    );
  }
  if (typeof health.pid !== "number" || !Number.isSafeInteger(health.pid)) {
    throw new Error("The bridge health response omitted its process identity.");
  }
  if (health.version !== EXPECTED_UPSTREAM_VERSION) {
    const found =
      typeof health.version === "string" ? health.version : "unknown";
    throw new Error(
      `Pinned bridge version ${EXPECTED_UPSTREAM_VERSION} is required; the local endpoint reports ${found}.`,
    );
  }
  if (health.mode !== "full" || health.accepting_turns !== true) {
    throw new Error("The bridge must be in full mode and accepting turns.");
  }
  requireIdleBridge(health, "before model discovery");

  const catalogResponse = await fetch(endpoint(settings, "/v1/models"), {
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
      accept: "application/json",
    },
  });
  if (!catalogResponse.ok)
    throw new Error(`Model discovery returned HTTP ${catalogResponse.status}.`);
  const catalog = (await catalogResponse.json()) as { models?: unknown };
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const modelSlugs = models.flatMap((value) => {
    const entry = asRecord(value);
    return typeof entry?.slug === "string" ? [entry.slug] : [];
  });
  const selectedModel = models
    .map(asRecord)
    .find((model) => model?.slug === settings.model);
  if (!selectedModel) {
    throw new Error(
      `BRIDGE_SPIKE_MODEL is absent from the live catalog (${modelSlugs.join(", ") || "empty catalog"}).`,
    );
  }
  const supportedEfforts = Array.isArray(
    selectedModel.supported_reasoning_levels,
  )
    ? selectedModel.supported_reasoning_levels.flatMap((value) => {
        const level = asRecord(value);
        return typeof level?.effort === "string" ? [level.effort] : [];
      })
    : [];
  if (!supportedEfforts.includes("high")) {
    throw new Error(
      `The selected model does not advertise high effort (${supportedEfforts.join(", ") || "none"}).`,
    );
  }

  const confirmedHealthResponse = await fetch(endpoint(settings, "/healthz"));
  if (!confirmedHealthResponse.ok) {
    throw new Error(
      `Bridge confirmation returned HTTP ${confirmedHealthResponse.status}.`,
    );
  }
  const confirmedHealth = (await confirmedHealthResponse.json()) as Record<
    string,
    unknown
  >;
  if (
    confirmedHealth.service !== health.service ||
    confirmedHealth.pid !== health.pid ||
    confirmedHealth.version !== EXPECTED_UPSTREAM_VERSION ||
    confirmedHealth.status !== "ok" ||
    confirmedHealth.mode !== "full" ||
    confirmedHealth.accepting_turns !== true
  ) {
    throw new Error(
      "The bridge identity or readiness changed during model discovery.",
    );
  }
  requireIdleBridge(confirmedHealth, "after model discovery");
  const successfulCatalogRequests =
    confirmedHealth.successful_model_catalog_requests;
  if (
    typeof successfulCatalogRequests !== "number" ||
    successfulCatalogRequests < 1
  ) {
    throw new Error(
      "The bridge did not record a successful model-catalog request.",
    );
  }
  console.log(
    JSON.stringify({
      check: "bridge-ready",
      version: health.version,
      pid: health.pid,
      mode: health.mode,
      activeHttpTurns: health.active_http_turns,
      activeBrowserTurns: health.active_browser_turns,
      model: settings.model,
      supportedEfforts,
      successfulModelCatalogRequests: successfulCatalogRequests,
      requestHeaders: ["authorization", "accept", "content-type"],
    }),
  );
  return {
    service: "codex-chatgpt-web",
    pid: health.pid,
    version: EXPECTED_UPSTREAM_VERSION,
    mode: "full",
  };
}

/** Keeps pre-LIVE work behind an idle gate at both health observations. */
export function requireIdleBridge(
  health: Record<string, unknown>,
  observation: string,
): void {
  if (health.active_http_turns !== 0 || health.active_browser_turns !== 0) {
    throw new Error(
      `The bridge must have zero active HTTP and browser turns ${observation} (HTTP=${String(health.active_http_turns)}, browser=${String(health.active_browser_turns)}).`,
    );
  }
}

/** Rechecks the same process after AC1 so cancellation cannot follow an unhealthy or busy bridge. */
async function verifyBridgeStillIdle(
  settings: BridgeSettings,
  identity: BridgeProcessIdentity,
): Promise<void> {
  const healthResponse = await fetch(endpoint(settings, "/healthz"));
  if (!healthResponse.ok) {
    throw new Error(
      `Post-AC1 bridge health check returned HTTP ${healthResponse.status}.`,
    );
  }
  const health = (await healthResponse.json()) as Record<string, unknown>;
  if (
    health.service !== identity.service ||
    typeof health.pid !== "number" ||
    !Number.isSafeInteger(health.pid) ||
    health.pid !== identity.pid ||
    health.version !== identity.version ||
    health.status !== "ok" ||
    health.mode !== identity.mode ||
    health.accepting_turns !== true
  ) {
    throw new Error("The bridge identity or readiness changed after AC1.");
  }
  requireIdleBridge(health, "after AC1");
  console.log(
    JSON.stringify({
      check: "bridge-after-ac1",
      status: health.status,
      version: health.version,
      pid: health.pid,
      mode: health.mode,
      activeHttpTurns: health.active_http_turns,
      activeBrowserTurns: health.active_browser_turns,
    }),
  );
}

/** Narrows protocol data without trusting a provider-controlled JSON shape. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Escapes the local policy envelope so filesystem paths remain data inside XML. */
function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Limits declared context to the fixture tree; the host tool independently enforces the exact file. */
function makeEnvironmentMessage(
  identity: TurnIdentity,
): Record<string, unknown> {
  const environment = [
    "<environment_context>",
    `<cwd>${xml(FIXTURE_WORKSPACE)}</cwd>`,
    `<workspace_roots><root>${xml(FIXTURE_WORKSPACE)}</root></workspace_roots>`,
    `<filesystem><permission_profile type="managed"><file_system type="restricted"><entry access="read">${xml(FIXTURE_WORKSPACE)}</entry></file_system></permission_profile></filesystem>`,
    "</environment_context>",
  ].join("");
  return {
    type: "message",
    id: `nr02-environment-${identity.turnId}`,
    role: "user",
    content: [{ type: "input_text", text: environment }],
    internal_chat_message_metadata_passthrough: {
      turn_id: identity.turnId,
      content_item_kinds: ["environments.environment_context"],
    },
  };
}

/** Carries one native user revision so upstream replay logic can bind the prompt to its fresh turn. */
function makeUserMessage(
  identity: TurnIdentity,
  canaryId: string,
): Record<string, unknown> {
  return {
    type: "message",
    id: `nr02-instruction-${identity.turnId}`,
    role: "user",
    content: [
      {
        type: "input_text",
        text: `Read fixture ${FIXTURE_KEY} once with read_fixture, then return JSON with this canaryId: ${canaryId} and the SHA-256 of the exact fixture bytes. Do not include any other canary.`,
      },
    ],
    internal_chat_message_metadata_passthrough: { turn_id: identity.turnId },
  };
}

/** The schema exposes exactly one symbolic fixture; callers cannot select a filesystem path. */
function makeToolDefinition(): Record<string, unknown> {
  return {
    type: "function",
    name: "read_fixture",
    description:
      "Read the single controlled NR-02 fixture. This tool has no path argument and cannot access other files.",
    parameters: {
      type: "object",
      properties: { fixture: { type: "string", enum: [FIXTURE_KEY] } },
      required: ["fixture"],
      additionalProperties: false,
    },
    strict: true,
  };
}

/** Keeps thread and turn identity stable across the tool-result continuation. */
function makeTurnBody(
  settings: BridgeSettings,
  identity: TurnIdentity,
  input: unknown[],
  firstTurn: boolean,
  previousResponseId?: string,
): Record<string, unknown> {
  return {
    model: settings.model,
    stream: true,
    input,
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    tools: [makeToolDefinition()],
    tool_choice: firstTurn
      ? { type: "function", name: "read_fixture" }
      : "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "high" },
    text: {
      format: {
        type: "json_schema",
        name: "nr02_bridge_result",
        strict: true,
        schema: OUTPUT_SCHEMA,
      },
    },
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: identity.threadId,
        turn_id: identity.turnId,
        request_kind: "turn",
        sandbox_mode: "read-only",
        workspaces: { [FIXTURE_WORKSPACE]: {} },
      }),
    },
  };
}

/** Selects trace retention at the caller boundary without changing normal probe parsing. */
interface SendTurnOptions {
  readonly captureSanitizedTrace?: boolean;
}

/** Sends only to the validated local endpoint and leaves SSE outcome semantics to the contract parser. */
async function sendTurn(
  settings: BridgeSettings,
  body: Record<string, unknown>,
  options: SendTurnOptions = {},
): Promise<BridgeSseOutcome> {
  const response = await fetch(endpoint(settings, "/v1/responses"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  return readBridgeSse(response, {
    captureSanitizedTrace: options.captureSanitizedTrace ?? false,
  });
}

/** Refuses terminal errors and partial streams before they can be treated as a successful tool cycle. */
function requireCompleted(
  outcome: BridgeSseOutcome,
  stage: string,
): Extract<BridgeSseOutcome, { kind: "completed" }> {
  if (outcome.kind !== "completed") {
    const summary =
      outcome.kind === "failed"
        ? `${outcome.errorType}/${outcome.code} HTTP ${outcome.status}`
        : outcome.kind === "incomplete"
          ? outcome.reason
          : "cancelled";
    throw new Error(`${stage} ended as ${summary}.`);
  }
  return outcome;
}

/** Enforces the fixed tool allowlist at the host boundary before reading the controlled fixture. */
function requireFixtureCall(
  calls: readonly BridgeFunctionCall[],
): BridgeFunctionCall {
  if (calls.length !== 1)
    throw new Error(
      `Expected one read_fixture call; received ${calls.length}.`,
    );
  const call = calls[0];
  if (!call) throw new Error("read_fixture call item is missing.");
  if (call.name !== "read_fixture")
    throw new Error(`Unexpected function name ${call.name}.`);
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    throw new Error("read_fixture returned malformed arguments.");
  }
  const parsed = asRecord(args);
  if (
    !parsed ||
    parsed.fixture !== FIXTURE_KEY ||
    Object.keys(parsed).length !== 1
  ) {
    throw new Error(
      "read_fixture arguments exceeded the fixed fixture allowlist.",
    );
  }
  return call;
}

/** Executes the caller-owned half of one Responses function-call cycle against a fixed file. */
async function runFreshContext(
  settings: BridgeSettings,
  canaryId: string,
): Promise<SessionReceipt> {
  const sessionStartedAt = new Date().toISOString();
  const sessionStartedMs = performance.now();
  const identity = { threadId: randomUUID(), turnId: randomUUID() };
  const initialBody = makeTurnBody(
    settings,
    identity,
    [makeEnvironmentMessage(identity), makeUserMessage(identity, canaryId)],
    true,
  );
  const firstStartedAt = new Date().toISOString();
  const firstStartedMs = performance.now();
  const first = requireCompleted(
    await sendTurn(settings, initialBody, { captureSanitizedTrace: true }),
    "function-call turn",
  );
  const firstFinishedAt = new Date().toISOString();
  const firstElapsedMs = Math.round(performance.now() - firstStartedMs);
  if (!first.responseId)
    throw new Error("The first response omitted its continuation identity.");
  if (!first.sanitizedTrace?.complete)
    throw new Error(
      "The function-call response trace is missing or incomplete.",
    );
  const call = requireFixtureCall(first.functionCalls);
  const fixtureReadStartedAt = new Date().toISOString();
  const fixtureReadStartedMs = performance.now();
  const fixtureBytes = Buffer.from(await Bun.file(FIXTURE_PATH).arrayBuffer());
  const fixtureText = fixtureBytes.toString("utf8");
  const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
  const toolOutput = JSON.stringify({
    fixture: FIXTURE_KEY,
    content: fixtureText,
    sha256: fixtureSha256,
  });
  const fixtureReadFinishedAt = new Date().toISOString();
  const fixtureReadElapsedMs = Math.round(
    performance.now() - fixtureReadStartedMs,
  );
  const followUpBody = makeTurnBody(
    settings,
    identity,
    [
      {
        type: "function_call_output",
        call_id: call.callId,
        output: toolOutput,
      },
    ],
    false,
    first.responseId,
  );
  const continuationStartedAt = new Date().toISOString();
  const continuationStartedMs = performance.now();
  const final = requireCompleted(
    await sendTurn(settings, followUpBody, { captureSanitizedTrace: true }),
    "tool-result continuation",
  );
  const continuationFinishedAt = new Date().toISOString();
  const continuationElapsedMs = Math.round(
    performance.now() - continuationStartedMs,
  );
  if (!final.responseId)
    throw new Error("The completed response omitted its response identity.");
  if (!final.sanitizedTrace?.complete)
    throw new Error(
      "The continuation response trace is missing or incomplete.",
    );
  if (final.functionCalls.length !== 0)
    throw new Error(
      "The final response requested an unexpected extra tool call.",
    );

  let result: unknown;
  try {
    result = JSON.parse(final.outputText);
  } catch {
    throw new Error(
      "The final response did not contain valid structured JSON.",
    );
  }
  const output = asRecord(result);
  if (
    !output ||
    Object.keys(output).sort().join(",") !== "canaryId,fixtureSha256" ||
    output.canaryId !== canaryId ||
    output.fixtureSha256 !== fixtureSha256
  ) {
    throw new Error(
      "The structured result did not match this fresh session's canary and fixture digest.",
    );
  }
  // A foreign canary could appear before the tool-result continuation, so inspect both response legs.
  const observedOutput = [
    first.outputText,
    ...first.functionCalls.map((functionCall) => functionCall.arguments),
    final.outputText,
  ].join("\n");
  const sessionFinishedAt = new Date().toISOString();
  const liveTrace = {
    schemaVersion: "nr02-live-trace/1" as const,
    requestIdentity: identity,
    model: settings.model,
    startedAt: sessionStartedAt,
    finishedAt: sessionFinishedAt,
    elapsedMs: Math.round(performance.now() - sessionStartedMs),
    responseLegs: [
      {
        name: "function-call" as const,
        startedAt: firstStartedAt,
        finishedAt: firstFinishedAt,
        elapsedMs: firstElapsedMs,
        responseId: first.responseId,
        sanitizedSse: first.sanitizedTrace,
      },
      {
        name: "tool-result-continuation" as const,
        startedAt: continuationStartedAt,
        finishedAt: continuationFinishedAt,
        elapsedMs: continuationElapsedMs,
        responseId: final.responseId,
        sanitizedSse: final.sanitizedTrace,
      },
    ],
    fixtureRead: {
      startedAt: fixtureReadStartedAt,
      finishedAt: fixtureReadFinishedAt,
      elapsedMs: fixtureReadElapsedMs,
      fixture: FIXTURE_KEY,
      byteLength: fixtureBytes.length,
      fixtureSha256,
      toolCall: {
        name: "read_fixture" as const,
        itemId: call.itemId,
        callId: call.callId,
        arguments: { fixture: FIXTURE_KEY as "probe" },
        argumentsSha256: createHash("sha256")
          .update(call.arguments)
          .digest("hex"),
      },
      toolOutput: {
        byteLength: Buffer.byteLength(toolOutput),
        sha256: createHash("sha256").update(toolOutput).digest("hex"),
      },
    },
    structuredResult: {
      responseId: final.responseId,
      canaryId: output.canaryId as string,
      fixtureSha256: output.fixtureSha256 as string,
    },
  };
  const liveTraceBytes = Buffer.from(JSON.stringify(liveTrace), "utf8");
  return {
    ...identity,
    canaryId,
    firstResponseId: first.responseId,
    finalResponseId: final.responseId,
    callId: call.callId,
    fixtureSha256,
    observedOutput,
    initialEvents: first.events,
    continuationEvents: final.events,
    liveTrace,
    liveTraceSha256: createHash("sha256").update(liveTraceBytes).digest("hex"),
    liveTraceBytes: liveTraceBytes.length,
  };
}

/** Runs the single AC1 fresh context and projects its private scan state into a safe receipt. */
export async function runAc1Only(
  settings: BridgeSettings,
  executeFreshContext = runFreshContext,
) {
  const canaryId = randomUUID();
  const receipt = await executeFreshContext(settings, canaryId);
  return {
    check: "nr02-ac1",
    status: "pass",
    model: settings.model,
    effort: "high",
    threadId: receipt.threadId,
    turnId: receipt.turnId,
    canaryId: receipt.canaryId,
    responseIds: {
      functionCall: receipt.firstResponseId,
      continuation: receipt.finalResponseId,
    },
    functionCall: {
      name: receipt.liveTrace.fixtureRead.toolCall.name,
      callId: receipt.callId,
      argumentsSha256: receipt.liveTrace.fixtureRead.toolCall.argumentsSha256,
    },
    fixture: {
      key: FIXTURE_KEY,
      byteLength: receipt.liveTrace.fixtureRead.byteLength,
      sha256: receipt.fixtureSha256,
    },
    structuredResult: receipt.liveTrace.structuredResult,
    liveTrace: receipt.liveTrace,
    liveTraceSha256: receipt.liveTraceSha256,
    liveTraceBytes: receipt.liveTraceBytes,
  };
}

/** Separate native thread IDs exercise upstream conversation isolation without a scheduler. */
async function runThreeFreshContexts(settings: BridgeSettings): Promise<void> {
  const canaries = [randomUUID(), randomUUID(), randomUUID()];
  const receipts: SessionReceipt[] = [];
  for (const canary of canaries)
    receipts.push(await runFreshContext(settings, canary));

  // ❌ Удалено сокращённое формирование three-fresh-contexts receipt: оно отбрасывало timing и trace, нужные NR-02.
  const sessionReceipts = receipts.map((receipt) => {
    const foreignCanaryIds = canaries.filter(
      (otherCanary) =>
        otherCanary !== receipt.canaryId &&
        receipt.observedOutput.includes(otherCanary),
    );
    const { observedOutput: _observedOutput, ...serializedReceipt } = receipt;
    return {
      ...serializedReceipt,
      isolation: {
        ownCanaryInStructuredResult:
          receipt.liveTrace.structuredResult.canaryId === receipt.canaryId,
        foreignCanariesChecked: canaries.length - 1,
        foreignCanaryIds,
      },
    };
  });
  const leakedReceipt = sessionReceipts.find(
    (receipt) => receipt.isolation.foreignCanaryIds.length > 0,
  );
  console.log(
    JSON.stringify({
      check: "three-fresh-contexts",
      status: leakedReceipt ? "fail" : "pass",
      canaryIsolation: {
        sessionsChecked: sessionReceipts.length,
        foreignCanaryLeaks: sessionReceipts.reduce(
          (sum, receipt) => sum + receipt.isolation.foreignCanaryIds.length,
          0,
        ),
      },
      model: settings.model,
      effort: "high",
      fixture: FIXTURE_KEY,
      sessions: sessionReceipts,
    }),
  );
  if (leakedReceipt)
    throw new Error(
      `A fresh response contained a canary owned by another context (${leakedReceipt.threadId}).`,
    );
}

/** Interrupts only a synthetic UUID turn created by this process, never an existing task. */
async function runCancellationProbe(settings: BridgeSettings): Promise<void> {
  const controlToken = requiredEnvironment("BRIDGE_SPIKE_CONTROL_TOKEN");
  const identity = { threadId: randomUUID(), turnId: randomUUID() };
  const body = {
    model: settings.model,
    stream: true,
    max_output_tokens: 1_200,
    reasoning: { effort: "high" },
    input: [
      makeEnvironmentMessage(identity),
      {
        type: "message",
        id: `nr02-cancel-${identity.turnId}`,
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Write a long, harmless explanation of how a paper notebook is organized. Begin with the first paragraph.",
          },
        ],
        internal_chat_message_metadata_passthrough: {
          turn_id: identity.turnId,
        },
      },
    ],
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: identity.threadId,
        turn_id: identity.turnId,
        request_kind: "turn",
        sandbox_mode: "read-only",
        workspaces: { [FIXTURE_WORKSPACE]: {} },
      }),
    },
  };
  const responseAbort = new AbortController();
  let responsesStartedAt: string | undefined;
  let interruptRequestedAt: string | undefined;
  let interruptRequestedAtMs: number | undefined;
  let interruptAcknowledgedAt: string | undefined;
  let interruptAcknowledgedAtMs: number | undefined;
  let interruptHttpStatus: number | undefined;
  let controlAcknowledgement: Record<string, unknown> | undefined;
  let streamObservationStatus:
    | "not_started"
    | "observing"
    | "terminated"
    | "timeout" = "not_started";
  let streamTerminatedAt: string | undefined;
  let streamDisposition:
    | BridgeSseOutcome
    | { readonly kind: "read_error"; readonly name: string }
    | undefined;
  let terminalObservedAtMs: number | undefined;
  let terminalObservedAt: string | undefined;
  let terminalObservedName: string | undefined;
  let localAbortForCleanup = false;
  let responseTimedOut = false;
  let failureReason: string | undefined;
  const responseTimeout = setTimeout(() => {
    responseTimedOut = true;
    localAbortForCleanup = true;
    responseAbort.abort(
      new DOMException(
        "Responses cancellation probe timed out",
        "TimeoutError",
      ),
    );
  }, 180_000);
  try {
    let streamFinished = false;
    responsesStartedAt = new Date().toISOString();
    const response = await fetch(endpoint(settings, "/v1/responses"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: responseAbort.signal,
    });
    const streamObservation = readBridgeSse(response, {
      onTerminalEvent: (eventName) => {
        if (terminalObservedAtMs !== undefined) return;
        terminalObservedAtMs = Date.now();
        terminalObservedAt = new Date(terminalObservedAtMs).toISOString();
        terminalObservedName = eventName;
      },
    }).then(
      (outcome) => {
        const terminatedAtMs = Date.now();
        streamFinished = true;
        streamTerminatedAt = new Date(terminatedAtMs).toISOString();
        streamDisposition = outcome;
        if (!localAbortForCleanup) {
          streamObservationStatus = "terminated";
        }
        return {
          outcome,
          terminatedAt: new Date(terminatedAtMs).toISOString(),
          terminatedAtMs,
        };
      },
      (error) => {
        const terminatedAtMs = Date.now();
        streamFinished = true;
        streamTerminatedAt = new Date(terminatedAtMs).toISOString();
        streamDisposition = {
          kind: "read_error",
          name: error instanceof Error ? error.name : "Error",
        };
        if (!localAbortForCleanup) {
          streamObservationStatus = "terminated";
        }
        return {
          readErrorName: error instanceof Error ? error.name : "Error",
          terminatedAt: new Date(terminatedAtMs).toISOString(),
          terminatedAtMs,
        };
      },
    );
    streamObservationStatus = "observing";

    // The pinned health endpoint exposes active_http_turns; waiting for exactly this turn's owner
    // avoids a fixed-delay race where interrupt arrives before the Responses handler binds identity.
    const registrationDeadline = Date.now() + 10_000;
    let activeHttpTurnObserved = false;
    while (Date.now() < registrationDeadline) {
      const healthResponse = await fetch(endpoint(settings, "/healthz"), {
        signal: AbortSignal.timeout(2_000),
      });
      if (!healthResponse.ok) {
        throw new Error(
          `Cancellation readiness check returned HTTP ${healthResponse.status}.`,
        );
      }
      const health = asRecord(await healthResponse.json());
      const activeHttpTurns = health?.active_http_turns;
      if (typeof activeHttpTurns !== "number") {
        throw new Error(
          "The bridge health response omitted active_http_turns.",
        );
      }
      if (activeHttpTurns > 1) {
        throw new Error(
          `Expected only the synthetic cancellation turn (${activeHttpTurns} active HTTP turns).`,
        );
      }
      if (activeHttpTurns === 1) {
        activeHttpTurnObserved = true;
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    if (!activeHttpTurnObserved) {
      throw new Error(
        "The synthetic Responses request did not register as an active HTTP turn within 10 seconds.",
      );
    }
    // The HTTP owner can remain active briefly after the parser has seen a terminal SSE event.
    if (terminalObservedAtMs !== undefined) {
      throw new Error(
        `The synthetic Responses stream already emitted ${terminalObservedName} before the interrupt.`,
      );
    }
    if (streamFinished) {
      throw new Error(
        "The synthetic Responses stream terminated before the exact-turn interrupt was sent.",
      );
    }

    interruptRequestedAtMs = Date.now();
    interruptRequestedAt = new Date(interruptRequestedAtMs).toISOString();
    const interruptResponse = await fetch(
      endpoint(settings, "/admin/interrupt-turn"),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${controlToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(identity),
        signal: AbortSignal.timeout(10_000),
      },
    );
    interruptHttpStatus = interruptResponse.status;
    if (interruptResponse.status !== 200) {
      controlAcknowledgement = { httpStatus: interruptResponse.status };
      throw new Error(
        `Exact-turn cancellation returned HTTP ${interruptResponse.status}.`,
      );
    }
    const rawAcknowledgement = await interruptResponse.text();
    let acknowledgementBody: unknown;
    try {
      acknowledgementBody = JSON.parse(rawAcknowledgement);
    } catch {
      controlAcknowledgement = {
        httpStatus: interruptResponse.status,
        parseStatus: "malformed_json",
      };
      throw new Error("Exact-turn cancellation returned malformed JSON.");
    }
    const interrupt = asRecord(acknowledgementBody);
    if (!interrupt) {
      controlAcknowledgement = {
        httpStatus: interruptResponse.status,
        parseStatus: "malformed_object",
      };
      throw new Error(
        "Exact-turn cancellation returned a malformed acknowledgement.",
      );
    }
    const cancelledHttpTurns = interrupt.cancelled_http_turns;
    const acknowledgementFields = {
      status: interrupt.status,
      cancelled_http_turns: cancelledHttpTurns,
      ...(typeof interrupt.cancelled_browser_turns === "number"
        ? { cancelled_browser_turns: interrupt.cancelled_browser_turns }
        : {}),
      ...(typeof interrupt.cancelled_compaction_runs === "number"
        ? { cancelled_compaction_runs: interrupt.cancelled_compaction_runs }
        : {}),
    };
    controlAcknowledgement = {
      httpStatus: interruptResponse.status,
      // ❌ Удален rawAcknowledgement из receipt: произвольное тело ответа не нужно для D6 и могло содержать лишние данные.
      sanitizedBody: acknowledgementFields,
    };
    if (interrupt.status !== "ok" || cancelledHttpTurns !== 1) {
      throw new Error(
        `Exact-turn cancellation did not own one active HTTP turn (${String(cancelledHttpTurns)}).`,
      );
    }
    interruptAcknowledgedAtMs = Date.now();
    interruptAcknowledgedAt = new Date(interruptAcknowledgedAtMs).toISOString();

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const observed = await Promise.race([
      streamObservation,
      new Promise<{ timeout: true }>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout({ timeout: true }), 10_000);
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    if ("timeout" in observed) {
      streamObservationStatus = "timeout";
      localAbortForCleanup = true;
      // Local abort only releases the client stream; it never substitutes for observed termination.
      responseAbort.abort(
        new DOMException(
          "Cancellation stream cleanup deadline elapsed",
          "AbortError",
        ),
      );
      await Promise.race([
        streamObservation,
        new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000)),
      ]);
      throw new Error(
        "Cancelled response stream did not settle within 10 seconds; the local request was aborted for cleanup.",
      );
    }
    if (responseTimedOut) {
      streamObservationStatus = "timeout";
      throw new Error(
        "The Responses request timed out and was locally aborted; it cannot qualify as cancellation.",
      );
    }
    streamObservationStatus = "terminated";
    streamTerminatedAt = observed.terminatedAt;
    if ("outcome" in observed) {
      streamDisposition = observed.outcome;
    } else {
      streamDisposition = {
        kind: "read_error",
        name: observed.readErrorName,
      };
    }
    if (
      interruptRequestedAtMs === undefined ||
      observed.terminatedAtMs < interruptRequestedAtMs
    ) {
      throw new Error(
        "The synthetic Responses stream terminated before the interrupt request.",
      );
    }
    // ❌ Удалена inline D6-проверка окна: pure contract helper фиксирует ACK-границу и тестирует её отдельно.
    if (
      !isStreamTerminationWithinAcknowledgementWindow(
        interruptAcknowledgedAtMs,
        observed.terminatedAtMs,
      )
    ) {
      throw new Error(
        "Cancelled response stream terminated outside the 10-second D6 observation window.",
      );
    }
    const streamOutcome = "outcome" in observed ? observed.outcome : undefined;
    if (
      streamOutcome?.kind === "completed" ||
      streamOutcome?.events.includes("response.completed")
    ) {
      throw new Error(
        "The correlated Responses stream produced response.completed.",
      );
    }
  } catch (error) {
    failureReason =
      error instanceof Error
        ? error.message
        : "Bridge cancellation probe failed.";
  } finally {
    clearTimeout(responseTimeout);
    if (!responseAbort.signal.aborted) {
      if (failureReason && streamObservationStatus === "observing") {
        localAbortForCleanup = true;
      }
      responseAbort.abort(
        new DOMException("Cancellation probe finished", "AbortError"),
      );
    }
    // ❌ Удален success-only receipt: failed probes now preserve their observed acknowledgement and stream state too.
    console.log(
      JSON.stringify({
        check: "exact-turn-cancellation",
        status: failureReason ? "fail" : "pass",
        ...(failureReason
          ? { failureReason }
          : {
              classification: "acknowledged_non_completed_stream_termination",
            }),
        requestIdentity: identity,
        ...(responsesStartedAt ? { responsesStartedAt } : {}),
        ...(interruptRequestedAt ? { interruptRequestedAt } : {}),
        ...(interruptAcknowledgedAt ? { interruptAcknowledgedAt } : {}),
        ...(interruptHttpStatus !== undefined ? { interruptHttpStatus } : {}),
        ...(terminalObservedName
          ? {
              terminalEventObserved: {
                name: terminalObservedName,
                at: terminalObservedAt,
              },
            }
          : {}),
        ...(streamTerminatedAt ? { streamTerminatedAt } : {}),
        streamObservationStatus,
        ...(controlAcknowledgement ? { controlAcknowledgement } : {}),
        ...(streamDisposition ? { streamDisposition } : {}),
        ...(responseTimedOut ? { responseTimedOut } : {}),
        localAbortForCleanup,
      }),
    );
  }
  if (failureReason) throw new Error(failureReason);
}

/** Exercises the typed missing-connector failure using an isolated, unmatched connector name. */
async function runUnavailableConnectorProbe(
  settings: BridgeSettings,
): Promise<void> {
  const identity = { threadId: randomUUID(), turnId: randomUUID() };
  const canaryId = randomUUID();
  const body = makeTurnBody(
    settings,
    identity,
    [makeEnvironmentMessage(identity), makeUserMessage(identity, canaryId)],
    true,
  );
  const outcome = await sendTurn(settings, body);
  if (
    outcome.kind !== "failed" ||
    outcome.status !== 424 ||
    outcome.errorType !== "connector_error" ||
    outcome.code !== "connector_not_found"
  ) {
    throw new Error(
      `Unavailable connector did not return the pinned typed outcome (${outcome.kind}).`,
    );
  }
  console.log(
    JSON.stringify({
      check: "unavailable-connector",
      status: "pass",
      threadId: identity.threadId,
      turnId: identity.turnId,
      outcome: {
        kind: "failed",
        status: outcome.status,
        errorType: outcome.errorType,
        code: outcome.code,
      },
      events: outcome.events,
    }),
  );
}

// ❌ Удалён implicit three-context/combined-cancel default: D41 requires one named action per LIVE invocation.
const LIVE_MODE_FLAGS = [
  "--preflight-only",
  "--ac1-only",
  "--cancel-only",
  "--connector-unavailable-only",
  "--three-contexts-only",
] as const;

type LiveModeFlag = (typeof LIVE_MODE_FLAGS)[number];

/** Requires exactly one named LIVE action before settings or network access are read. */
export function resolveLiveMode(args: readonly string[]): LiveModeFlag {
  const liveFlags = args.filter((argument) => argument === "--live");
  if (liveFlags.length !== 1) {
    throw new Error(
      "This command sends controlled requests to a local ChatGPT Web bridge. Pass --live exactly once to run it.",
    );
  }
  const unknownArguments = args.filter(
    (argument) =>
      argument !== "--live" &&
      !LIVE_MODE_FLAGS.includes(argument as LiveModeFlag),
  );
  if (unknownArguments.length > 0) {
    throw new Error(
      `Unknown live mode argument: ${unknownArguments.join(", ")}.`,
    );
  }
  const selectedModes = args.filter((argument) =>
    LIVE_MODE_FLAGS.includes(argument as LiveModeFlag),
  );
  if (selectedModes.length !== 1) {
    throw new Error(
      `Choose exactly one explicit live mode: ${LIVE_MODE_FLAGS.join(", ")}.`,
    );
  }
  return selectedModes[0] as LiveModeFlag;
}

/** Requires an explicit live mode so routine verification never reaches a ChatGPT account. */
async function main(): Promise<void> {
  const mode = resolveLiveMode(Bun.argv.slice(2));
  const settings = loadBridgeSettings();
  const bridgeIdentity = await verifyBridge(settings);
  if (mode === "--preflight-only") return;
  if (mode === "--ac1-only") {
    console.log(JSON.stringify(await runAc1Only(settings)));
    await verifyBridgeStillIdle(settings, bridgeIdentity);
    return;
  }
  if (mode === "--connector-unavailable-only") {
    await runUnavailableConnectorProbe(settings);
    return;
  }
  if (mode === "--cancel-only") {
    await runCancellationProbe(settings);
    return;
  }
  if (mode === "--three-contexts-only") {
    await runThreeFreshContexts(settings);
    return;
  }
}

// ❌ Удалён безусловный запуск main при импорте, чтобы локальные tests могли проверять runner без bridge traffic.
if (import.meta.main) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Bridge spike failed.",
    );
    process.exitCode = 1;
  });
}
