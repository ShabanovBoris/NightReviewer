import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  constants as fsConstants,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  type BridgeFunctionCall,
  type BridgeSseOutcome,
  type BridgeSseTrace,
  readBridgeSse,
} from "../src/spikes/bridge-sse";
import { isStreamTerminationWithinAcknowledgementWindow } from "../src/spikes/cancellation-contract";

const EXPECTED_UPSTREAM_VERSION = "6.1.3";
const EXPECTED_AC1_MODEL = "chatgpt-web/gpt-5.6-sol";
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
interface LoopbackBridgeSettings {
  readonly baseUrl: URL;
}

interface BridgeSettings extends LoopbackBridgeSettings {
  readonly apiKey: string;
  readonly model: string;
  readonly clientVersion: string;
}

interface UnavailableBridgeSettings extends LoopbackBridgeSettings {
  readonly model: typeof EXPECTED_AC1_MODEL;
  readonly expectedPid: number;
  readonly expectedPort: number;
  readonly productionPort: number;
  readonly evidencePath: string;
}

type SanitizedHealthMode = "full" | "browser-only" | "other";

interface SanitizedUnavailableHealth {
  readonly observed: boolean;
  readonly httpStatus: number | null;
  readonly service: "codex-chatgpt-web" | "other" | null;
  readonly status: "ok" | "other" | null;
  readonly pid: number | null;
  readonly port: number | null;
  readonly version: "6.1.3" | "other" | null;
  readonly mode: SanitizedHealthMode | null;
  readonly acceptingTurns: boolean | null;
  readonly activeHttpTurns: number | null;
  readonly activeBrowserTurns: number | null;
  readonly idle: boolean | null;
}

interface UnavailableProbeEvidence {
  readonly schemaVersion: "nr02-unavailable-evidence/1";
  readonly expectedIsolatedPid: number;
  readonly expectedIsolatedPort: number;
  readonly productionPortGuard: number;
  readonly model: typeof EXPECTED_AC1_MODEL;
  preHealth: SanitizedUnavailableHealth;
  responsesRequestAttempted: boolean;
  outerHttpStatus: number | null;
  outerContentTypeClass:
    | "not_received"
    | "missing"
    | "text/event-stream"
    | "application/json"
    | "other";
  sanitizedSseTrace: {
    readonly schemaVersion: "nr02-sanitized-sse/1";
    readonly complete: boolean;
    readonly frameCount: number;
    readonly observedFrames: number;
    readonly frames: readonly BridgeSseTrace["frames"][number][];
  };
  terminalOutcomeKind:
    | "not_observed"
    | "failed"
    | "completed"
    | "incomplete"
    | "cancelled"
    | "stream_error";
  typedStatus: number | null;
  typedErrorType: "connector_error" | "other" | null;
  typedCode: "connector_not_found" | "other" | null;
  responseFailedObserved: boolean;
  responseCompletedObserved: boolean;
  responseIncompleteObserved: boolean;
  functionOrToolEvidenceObserved: boolean;
  readFixtureEvidenceObserved: boolean;
  readonly continuationRequests: 0;
  readonly fixtureReadsExecuted: 0;
  postHealth: {
    attempted: boolean;
    observed: boolean;
    sameProcess: boolean | null;
    idle: boolean | null;
    health: SanitizedUnavailableHealth;
  };
  terminalClassification: "IN_PROGRESS" | "PASS" | "FAIL";
  failureStage?:
    | "pre_health"
    | "pre_health_validation"
    | "responses_request"
    | "responses_http"
    | "sse_read"
    | "terminal_validation"
    | "post_health"
    | "evidence_persistence";
}

type BridgeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

// ❌ Удалён отдельный bridge-live-evidence.ts: D52 закрепляет durable ledger за canonical bridge runner, поэтому схема и отправитель хранятся в одном модуле.
/** One canonical allowlist drives both the writer's type and runtime validator. */
const EVIDENCE_STAGE_NAMES = [
  "runner_started",
  "settings_validated",
  "internal_health_1_attempted",
  "internal_health_1_received",
  "internal_health_1_passed",
  "model_catalog_attempted",
  "model_catalog_received",
  "model_catalog_passed",
  "internal_health_2_attempted",
  "internal_health_2_received",
  "internal_health_2_passed",
  "ac1_context_created",
  "initial_responses_attempted",
  "initial_responses_received",
  "initial_responses_stream_ended",
  "tool_call_observed",
  "controlled_fixture_read_attempted",
  "controlled_fixture_result_prepared",
  "continuation_responses_attempted",
  "continuation_responses_received",
  "continuation_responses_stream_ended",
  "final_correlation_validated",
  "post_ac1_health_attempted",
  "post_ac1_health_received",
  "post_ac1_health_passed",
  "terminal_success",
  "terminal_failure",
] as const;
export type EvidenceStage = (typeof EVIDENCE_STAGE_NAMES)[number];

type SafeEvidenceField = string | number | boolean;
export type RequestSentState = boolean | "UNKNOWN";

/** Keeps the bridge flow dependent on a narrow synchronous durability contract. */
export interface StageEvidenceRecorder {
  readonly lastProvenStage: EvidenceStage | undefined;
  readonly requestSent: RequestSentState;
  readonly initialResponsesRequestSent: RequestSentState;
  record(
    stage: EvidenceStage,
    fields?: Readonly<Record<string, SafeEvidenceField>>,
  ): void;
  close(): void;
}

const EVIDENCE_STAGE_SCHEMA = "nr02-stage-evidence/1" as const;
const EVIDENCE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVIDENCE_SHA256 = /^[0-9a-f]{64}$/;
const EVIDENCE_FIELDS = new Set([
  "endpointClass",
  "method",
  "httpStatus",
  "service",
  "status",
  "pid",
  "version",
  "mode",
  "acceptingTurns",
  "activeHttpTurns",
  "activeBrowserTurns",
  "successfulModelCatalogRequests",
  "threadId",
  "turnId",
  "canaryId",
  "responseId",
  "itemId",
  "callId",
  "toolName",
  "argumentsSha256",
  "fixtureName",
  "fixtureByteLength",
  "fixtureSha256",
  "toolOutputByteLength",
  "toolOutputSha256",
  "sanitizedTraceBytes",
  "sanitizedTraceSha256",
  "streamDisposition",
  "requestAttempted",
  "responseReceived",
  "requestSent",
  "initialResponsesRequestSent",
  "errorClass",
  "errorCode",
  "exitClassification",
  "lastProvenStage",
  "model",
  "reasoningEffort",
]);

/** Replaces storage errors with a fixed message so private filesystem details cannot leak. */
export class EvidenceWriterError extends Error {
  constructor() {
    super("Stage evidence could not be persisted.");
    this.name = "EvidenceWriterError";
  }
}

/** Keeps the unavailable probe's durable receipt separate from the AC1 stage ledger. */
export class UnavailableEvidenceError extends Error {
  constructor() {
    super("Sanitized unavailable-probe evidence could not be persisted.");
    this.name = "UnavailableEvidenceError";
  }
}

/** Enforces the evidence schema's value types, ranges and enumerated identifiers before serialization. */
function isSafeEvidenceValue(key: string, value: SafeEvidenceField): boolean {
  if (typeof value === "boolean")
    return [
      "acceptingTurns",
      "requestAttempted",
      "responseReceived",
      "requestSent",
      "initialResponsesRequestSent",
    ].includes(key);
  if (typeof value === "number") {
    const isBounded =
      key === "httpStatus"
        ? value >= 100 && value <= 599
        : key === "pid"
          ? value > 0
          : value >= 0;
    return (
      Number.isSafeInteger(value) &&
      isBounded &&
      [
        "httpStatus",
        "pid",
        "activeHttpTurns",
        "activeBrowserTurns",
        "successfulModelCatalogRequests",
        "fixtureByteLength",
        "toolOutputByteLength",
        "sanitizedTraceBytes",
      ].includes(key)
    );
  }
  if (
    value === "UNKNOWN" &&
    (key === "requestSent" || key === "initialResponsesRequestSent")
  ) {
    return true;
  }
  switch (key) {
    case "endpointClass":
      return ["health", "models", "responses"].includes(value);
    case "method":
      return value === "GET" || value === "POST";
    case "service":
      return value === "codex-chatgpt-web";
    case "status":
      return value === "ok";
    case "version":
      return /^\d+\.\d+\.\d+$/.test(value);
    case "model":
      return value === EXPECTED_AC1_MODEL;
    case "reasoningEffort":
      return value === "high";
    case "mode":
      return value === "full";
    case "threadId":
    case "turnId":
    case "canaryId":
      return EVIDENCE_UUID.test(value);
    case "responseId":
    case "itemId":
    case "callId":
      return /^[A-Za-z0-9_-]{1,128}$/.test(value);
    case "toolName":
      return value === "read_fixture";
    case "argumentsSha256":
    case "fixtureSha256":
    case "toolOutputSha256":
    case "sanitizedTraceSha256":
      return EVIDENCE_SHA256.test(value);
    case "fixtureName":
      return value === FIXTURE_KEY;
    case "streamDisposition":
      return ["completed", "failed", "incomplete", "cancelled"].includes(value);
    case "errorClass":
      return [
        "Error",
        "TypeError",
        "TimeoutError",
        "AbortError",
        "ModelCatalogHttpError",
        "EvidenceWriterError",
        "UnknownError",
      ].includes(value);
    case "errorCode":
      return [
        "RUNNER_ERROR",
        "TRANSPORT_ERROR",
        "TIMEOUT",
        "MODEL_CATALOG_HTTP",
        "EVIDENCE_PERSISTENCE_FAILED",
        "INVALID_BRIDGE_RESPONSE",
      ].includes(value);
    case "exitClassification":
      return [
        "SUCCESS",
        "RUNNER_FAILURE",
        "EVIDENCE_PERSISTENCE_FAILURE",
      ].includes(value);
    case "lastProvenStage":
      return value === "none" || EVIDENCE_STAGES.has(value as EvidenceStage);
    default:
      return false;
  }
}

const EVIDENCE_STAGES = new Set<EvidenceStage>(EVIDENCE_STAGE_NAMES);

/** Persists only allowlisted stage facts; each flush precedes the next side-effect boundary. */
export class FileStageEvidenceRecorder implements StageEvidenceRecorder {
  readonly #fd: number;
  #sequence = 0;
  #closed = false;
  #lastProvenStage: EvidenceStage | undefined;
  #networkAttempts = 0;
  #responseReceipts = 0;
  #initialResponsesAttempted = false;
  #initialResponsesReceived = false;

  constructor(
    evidencePath: string,
    readonly evidenceRunId: string,
    readonly prHeadSha: string,
  ) {
    if (!EVIDENCE_UUID.test(evidenceRunId) || !/^[0-9a-f]{40}$/.test(prHeadSha))
      throw new EvidenceWriterError();
    const resolvedRoot = resolve(".nightreviewer");
    const resolvedEvidencePath = resolve(evidencePath);
    const relativeEvidencePath = relative(resolvedRoot, resolvedEvidencePath);
    if (
      relativeEvidencePath.length === 0 ||
      relativeEvidencePath.startsWith("..") ||
      isAbsolute(relativeEvidencePath)
    ) {
      throw new EvidenceWriterError();
    }
    try {
      this.#fd = openSync(
        resolvedEvidencePath,
        fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(this.#fd, 0o600);
      fsyncSync(this.#fd);
    } catch {
      throw new EvidenceWriterError();
    }
  }

  get lastProvenStage(): EvidenceStage | undefined {
    return this.#lastProvenStage;
  }

  get requestSent(): RequestSentState {
    if (this.#responseReceipts > 0) return true;
    return this.#networkAttempts > 0 ? "UNKNOWN" : false;
  }

  get initialResponsesRequestSent(): RequestSentState {
    if (this.#initialResponsesReceived) return true;
    return this.#initialResponsesAttempted ? "UNKNOWN" : false;
  }

  record(
    stage: EvidenceStage,
    fields: Readonly<Record<string, SafeEvidenceField>> = {},
  ): void {
    if (this.#closed || !EVIDENCE_STAGES.has(stage))
      throw new EvidenceWriterError();
    for (const [key, value] of Object.entries(fields)) {
      if (!EVIDENCE_FIELDS.has(key) || !isSafeEvidenceValue(key, value))
        throw new EvidenceWriterError();
    }
    const event = {
      schemaVersion: EVIDENCE_STAGE_SCHEMA,
      evidenceRunId: this.evidenceRunId,
      prHeadSha: this.prHeadSha,
      sequence: this.#sequence + 1,
      timestampUtc: new Date().toISOString(),
      stage,
      ...fields,
    };
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    try {
      let offset = 0;
      while (offset < bytes.length) {
        offset += writeSync(this.#fd, bytes, offset, bytes.length - offset);
      }
      fsyncSync(this.#fd);
    } catch {
      throw new EvidenceWriterError();
    }
    this.#sequence += 1;
    this.#lastProvenStage = stage;
    if (NETWORK_ATTEMPT_STAGES.has(stage)) this.#networkAttempts += 1;
    if (stage.endsWith("_received")) this.#responseReceipts += 1;
    if (stage === "initial_responses_attempted")
      this.#initialResponsesAttempted = true;
    if (stage === "initial_responses_received")
      this.#initialResponsesReceived = true;
  }

  close(): void {
    if (this.#closed) return;
    try {
      fsyncSync(this.#fd);
      closeSync(this.#fd);
      this.#closed = true;
    } catch {
      throw new EvidenceWriterError();
    }
  }
}

export interface StageLedgerSummary {
  readonly eventCount: number;
  readonly lastProvenStage: EvidenceStage | "none";
  readonly terminalStage: "terminal_success" | "terminal_failure";
  readonly exitClassification:
    | "SUCCESS"
    | "RUNNER_FAILURE"
    | "EVIDENCE_PERSISTENCE_FAILURE";
  readonly requestSent: RequestSentState;
  readonly initialResponsesRequestSent: RequestSentState;
}

const RUN_STAGE_SEQUENCE: readonly EvidenceStage[] = [
  "runner_started",
  "settings_validated",
  "internal_health_1_attempted",
  "internal_health_1_received",
  "internal_health_1_passed",
  "model_catalog_attempted",
  "model_catalog_received",
  "model_catalog_passed",
  "internal_health_2_attempted",
  "internal_health_2_received",
  "internal_health_2_passed",
  "ac1_context_created",
  "initial_responses_attempted",
  "initial_responses_received",
  "initial_responses_stream_ended",
  "tool_call_observed",
  "controlled_fixture_read_attempted",
  "controlled_fixture_result_prepared",
  "continuation_responses_attempted",
  "continuation_responses_received",
  "continuation_responses_stream_ended",
  "final_correlation_validated",
  "post_ac1_health_attempted",
  "post_ac1_health_received",
  "post_ac1_health_passed",
];

const NETWORK_ATTEMPT_STAGES = new Set<EvidenceStage>([
  "internal_health_1_attempted",
  "model_catalog_attempted",
  "internal_health_2_attempted",
  "initial_responses_attempted",
  "continuation_responses_attempted",
  "post_ac1_health_attempted",
]);

/** Opens a precreated private ledger whose identity was fixed by the host wrapper before spawn. */
export function createStageEvidenceRecorderFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): FileStageEvidenceRecorder {
  return new FileStageEvidenceRecorder(
    requiredEnvironment("BRIDGE_SPIKE_EVIDENCE_PATH", environment),
    requiredEnvironment("BRIDGE_SPIKE_EVIDENCE_RUN_ID", environment),
    requiredEnvironment("BRIDGE_SPIKE_PR_HEAD_SHA", environment),
  );
}

/** Rejects malformed, reordered, unsafe, or terminally incomplete records before a host receipt is issued. */
export function validateStageLedger(
  contents: string,
  expectedEvidenceRunId: string,
  expectedPrHeadSha: string,
): StageLedgerSummary {
  if (!contents.endsWith("\n")) throw new EvidenceWriterError();
  const lines = contents.slice(0, -1).split("\n");
  const events: Array<Record<string, unknown>> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) throw new EvidenceWriterError();
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new EvidenceWriterError();
    }
    const event =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    if (
      !event ||
      event.schemaVersion !== EVIDENCE_STAGE_SCHEMA ||
      event.evidenceRunId !== expectedEvidenceRunId ||
      event.prHeadSha !== expectedPrHeadSha ||
      event.sequence !== index + 1 ||
      typeof event.timestampUtc !== "string" ||
      !isCanonicalUtc(event.timestampUtc) ||
      typeof event.stage !== "string" ||
      !EVIDENCE_STAGES.has(event.stage as EvidenceStage)
    ) {
      throw new EvidenceWriterError();
    }
    for (const key of Object.keys(event)) {
      if (
        [
          "schemaVersion",
          "evidenceRunId",
          "prHeadSha",
          "sequence",
          "timestampUtc",
          "stage",
        ].includes(key)
      )
        continue;
      const value = event[key];
      if (
        !EVIDENCE_FIELDS.has(key) ||
        (typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean") ||
        !isSafeEvidenceValue(key, value)
      ) {
        throw new EvidenceWriterError();
      }
    }
    const stage = event.stage as EvidenceStage;
    if (NETWORK_ATTEMPT_STAGES.has(stage)) {
      const endpointClass = stage.includes("health")
        ? "health"
        : stage === "model_catalog_attempted"
          ? "models"
          : "responses";
      const method = endpointClass === "responses" ? "POST" : "GET";
      if (
        event.endpointClass !== endpointClass ||
        event.method !== method ||
        event.requestAttempted !== true
      ) {
        throw new EvidenceWriterError();
      }
    }
    if (stage.endsWith("_received")) {
      const endpointClass = stage.includes("health")
        ? "health"
        : stage === "model_catalog_received"
          ? "models"
          : "responses";
      if (
        event.endpointClass !== endpointClass ||
        typeof event.httpStatus !== "number" ||
        event.responseReceived !== true
      ) {
        throw new EvidenceWriterError();
      }
    }
    events.push(event);
  }
  const terminalIndexes = events.flatMap((event, index) =>
    event.stage === "terminal_success" || event.stage === "terminal_failure"
      ? [index]
      : [],
  );
  if (
    terminalIndexes.length !== 1 ||
    terminalIndexes[0] !== events.length - 1
  ) {
    throw new EvidenceWriterError();
  }
  const terminal = events.at(-1);
  const terminalStage = terminal?.stage as
    | StageLedgerSummary["terminalStage"]
    | undefined;
  const preceding = events.slice(0, -1);
  const precedingStages = preceding.map(
    (event) => event.stage as EvidenceStage,
  );
  if (
    precedingStages.some((stage, index) => RUN_STAGE_SEQUENCE[index] !== stage)
  ) {
    throw new EvidenceWriterError();
  }
  if (
    terminalStage === "terminal_success" &&
    precedingStages.length !== RUN_STAGE_SEQUENCE.length
  ) {
    throw new EvidenceWriterError();
  }
  const lastProvenStage = precedingStages.at(-1) ?? "none";
  if (terminal?.lastProvenStage !== lastProvenStage)
    throw new EvidenceWriterError();
  const exitClassification = terminal?.exitClassification;
  if (
    exitClassification !== "SUCCESS" &&
    exitClassification !== "RUNNER_FAILURE" &&
    exitClassification !== "EVIDENCE_PERSISTENCE_FAILURE"
  ) {
    throw new EvidenceWriterError();
  }
  if (
    (terminalStage === "terminal_success") !==
    (exitClassification === "SUCCESS")
  ) {
    throw new EvidenceWriterError();
  }
  const attempts = precedingStages.filter((stage) =>
    NETWORK_ATTEMPT_STAGES.has(stage),
  ).length;
  const responses = precedingStages.filter((stage) =>
    stage.endsWith("_received"),
  ).length;
  const requestSent: RequestSentState =
    responses > 0 ? true : attempts > 0 ? "UNKNOWN" : false;
  const initialAttempted = precedingStages.includes(
    "initial_responses_attempted",
  );
  const initialReceived = precedingStages.includes(
    "initial_responses_received",
  );
  const initialResponsesRequestSent: RequestSentState = initialReceived
    ? true
    : initialAttempted
      ? "UNKNOWN"
      : false;
  if (
    terminal?.requestSent !== requestSent ||
    terminal?.initialResponsesRequestSent !== initialResponsesRequestSent
  ) {
    throw new EvidenceWriterError();
  }
  return {
    eventCount: events.length,
    lastProvenStage,
    terminalStage: terminalStage as StageLedgerSummary["terminalStage"],
    exitClassification,
    requestSent,
    initialResponsesRequestSent,
  };
}

/** Accepts only canonical millisecond UTC timestamps written by the durable recorder. */
function isCanonicalUtc(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

type ModelCatalogFailureStage =
  | "config"
  | "transport"
  | "request"
  | "catalog"
  | "upstream";

/** Carries the small, source-owned health classification allowed in failure evidence. */
interface SafeHealthCatalogResult {
  readonly status: number;
  readonly failureStage?: ModelCatalogFailureStage;
  readonly failureCode?: string;
}

/** Carries only the catalog status and allowlisted health classification, never response content. */
export class ModelCatalogHttpError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly healthLastModelCatalogResult?: SafeHealthCatalogResult,
  ) {
    super("Model discovery returned a non-success HTTP status.");
    this.name = "ModelCatalogHttpError";
  }

  toSanitizedReceipt(): Record<string, unknown> {
    return {
      check: "bridge-model-catalog",
      status: "fail",
      httpStatus: this.httpStatus,
      ...(this.healthLastModelCatalogResult
        ? { healthLastModelCatalogResult: this.healthLastModelCatalogResult }
        : {}),
    };
  }
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

/** Separates the runner's two external boundaries so offline tests never use global fetch or paths. */
export interface FreshContextDependencies {
  readonly evidence?: StageEvidenceRecorder;
  readonly fetcher?: BridgeFetch;
  readonly readFixture?: () => Promise<Uint8Array>;
}

type FreshContextExecutor = (
  settings: BridgeSettings,
  canaryId: string,
  dependencies: FreshContextDependencies,
) => Promise<SessionReceipt>;

/** Reads only the one allowlisted local fixture; tests inject this boundary to fail at that stage. */
async function readControlledFixture(): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(FIXTURE_PATH).arrayBuffer());
}

/** Missing settings stop the run before any key or prompt can be printed or sent. */
function requiredEnvironment(
  name: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required; no request was sent.`);
  return value;
}

/** Parses process and port guards before the unavailable route can use fetch. */
function requiredUnavailableInteger(
  name: string,
  environment: Readonly<Record<string, string | undefined>>,
  maximum: number,
): number {
  const rawValue = environment[name];
  if (!rawValue || !/^[1-9]\d*$/.test(rawValue)) {
    throw new Error(`${name} must be a positive decimal integer.`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new Error(`${name} is outside its allowed range.`);
  }
  return value;
}

/** Keeps unprefixed native models off the pinned release's non-connector passthrough route. */
function requireAc1Model(value: string): string {
  if (value !== EXPECTED_AC1_MODEL) {
    throw new Error(
      `BRIDGE_SPIKE_MODEL must equal ${EXPECTED_AC1_MODEL}; no request was sent.`,
    );
  }
  return value;
}

/** Prevents local release metadata from becoming arbitrary URL query text. */
export function validateReleaseClientVersion(value: string): string {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(
      "BRIDGE_SPIKE_CLIENT_VERSION must be release semver major.minor.patch; no request was sent.",
    );
  }
  return value;
}

/** Shares one loopback-only boundary while keeping each probe's auth/catalog contract separate. */
function loadLoopbackBaseUrl(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): URL {
  const rawBaseUrl = requiredEnvironment("BRIDGE_SPIKE_BASE_URL", environment);
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
  return baseUrl;
}

/** Loads exact isolation guards before any network-capable unavailable-probe action. */
export function loadUnavailableBridgeSettings(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): UnavailableBridgeSettings {
  const expectedPid = requiredUnavailableInteger(
    "BRIDGE_SPIKE_EXPECTED_ISOLATED_PID",
    environment,
    Number.MAX_SAFE_INTEGER,
  );
  const expectedPort = requiredUnavailableInteger(
    "BRIDGE_SPIKE_EXPECTED_ISOLATED_PORT",
    environment,
    65_535,
  );
  const productionPort = requiredUnavailableInteger(
    "BRIDGE_SPIKE_PRODUCTION_PORT",
    environment,
    65_535,
  );
  if (expectedPort === productionPort) {
    throw new Error(
      "The isolated bridge port must differ from the production port; no request was sent.",
    );
  }
  if (environment.BRIDGE_SPIKE_MODEL !== EXPECTED_AC1_MODEL) {
    throw new Error(
      `BRIDGE_SPIKE_MODEL must equal ${EXPECTED_AC1_MODEL}; no request was sent.`,
    );
  }
  const expectedBaseUrl = `http://127.0.0.1:${expectedPort}/`;
  if (environment.BRIDGE_SPIKE_BASE_URL !== expectedBaseUrl) {
    throw new Error(
      "BRIDGE_SPIKE_BASE_URL must exactly match the guarded isolated loopback port; no request was sent.",
    );
  }
  const evidencePath = requiredEnvironment(
    "BRIDGE_SPIKE_UNAVAILABLE_EVIDENCE_PATH",
    environment,
  );
  if (!isAbsolute(evidencePath)) {
    throw new UnavailableEvidenceError();
  }
  return {
    baseUrl: new URL(expectedBaseUrl),
    model: EXPECTED_AC1_MODEL,
    expectedPid,
    expectedPort,
    productionPort,
    evidencePath,
  };
}

/** Writes fsynced sanitized snapshots only into an existing private ignored evidence directory. */
class FileUnavailableEvidenceWriter {
  readonly #fd: number;
  #closed = false;

  constructor(evidencePath: string) {
    try {
      if (!isAbsolute(evidencePath)) throw new Error();
      const privateRoot = realpathSync(resolve(".nightreviewer"));
      const rootStat = statSync(privateRoot);
      const resolvedEvidencePath = resolve(evidencePath);
      const parentPath = realpathSync(dirname(resolvedEvidencePath));
      const relativeParent = relative(privateRoot, parentPath);
      const parentStat = statSync(parentPath);
      const currentUid = process.getuid?.();
      if (
        currentUid === undefined ||
        !rootStat.isDirectory() ||
        rootStat.uid !== currentUid ||
        (rootStat.mode & 0o077) !== 0 ||
        (relativeParent !== "" &&
          (relativeParent.startsWith("..") || isAbsolute(relativeParent))) ||
        !parentStat.isDirectory() ||
        parentStat.uid !== currentUid ||
        (parentStat.mode & 0o077) !== 0
      ) {
        throw new Error();
      }
      const safePath = resolve(parentPath, basename(resolvedEvidencePath));
      try {
        const existing = lstatSync(safePath);
        if (
          !existing.isFile() ||
          existing.uid !== currentUid ||
          existing.nlink !== 1 ||
          (existing.mode & 0o077) !== 0
        ) {
          throw new Error();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      this.#fd = openSync(
        safePath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_TRUNC |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(this.#fd, 0o600);
      fsyncSync(this.#fd);
    } catch {
      throw new UnavailableEvidenceError();
    }
  }

  record(evidence: UnavailableProbeEvidence): void {
    if (this.#closed) throw new UnavailableEvidenceError();
    const bytes = Buffer.from(`${JSON.stringify(evidence)}\n`, "utf8");
    try {
      ftruncateSync(this.#fd, 0);
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(
          this.#fd,
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (written <= 0) throw new Error();
        offset += written;
      }
      fsyncSync(this.#fd);
    } catch {
      throw new UnavailableEvidenceError();
    }
  }

  close(): void {
    if (this.#closed) return;
    try {
      fsyncSync(this.#fd);
      closeSync(this.#fd);
      this.#closed = true;
    } catch {
      throw new UnavailableEvidenceError();
    }
  }
}

/** Keeps AC1 and cancellation on their existing bearer/catalog contract. */
export function loadBridgeSettings(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BridgeSettings {
  const baseUrl = loadLoopbackBaseUrl(environment);
  const model = requireAc1Model(
    requiredEnvironment("BRIDGE_SPIKE_MODEL", environment),
  );
  return {
    baseUrl,
    apiKey: requiredEnvironment("BRIDGE_SPIKE_API_KEY", environment),
    model,
    clientVersion: validateReleaseClientVersion(
      requiredEnvironment("BRIDGE_SPIKE_CLIENT_VERSION", environment),
    ),
  };
}

/** Resolves API paths only after loadBridgeSettings has restricted the destination to loopback. */
function endpoint(settings: LoopbackBridgeSettings, path: string): URL {
  return new URL(path, settings.baseUrl);
}

/** Projects the bridge-owned catalog diagnostic into an allowlisted receipt shape. */
function safeHealthCatalogResult(
  value: unknown,
): SafeHealthCatalogResult | undefined {
  const result = asRecord(value);
  if (
    !result ||
    typeof result.status !== "number" ||
    !Number.isInteger(result.status) ||
    result.status < 100 ||
    result.status > 599
  ) {
    return undefined;
  }

  const failure = asRecord(result.failure);
  const stage = failure?.stage;
  const safeStage =
    stage === "config" ||
    stage === "transport" ||
    stage === "request" ||
    stage === "catalog" ||
    stage === "upstream"
      ? stage
      : undefined;
  const code = failure?.code;
  const safeCode =
    typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code)
      ? code
      : undefined;

  return {
    status: result.status,
    ...(safeStage ? { failureStage: safeStage } : {}),
    ...(safeCode ? { failureCode: safeCode } : {}),
  };
}

/** Verifies identity and catalog through an injectable fetch boundary for deterministic offline tests. */
export async function verifyBridge(
  settings: BridgeSettings,
  fetcher: BridgeFetch = fetch,
  evidence?: StageEvidenceRecorder,
): Promise<BridgeProcessIdentity> {
  requireAc1Model(settings.model);
  evidence?.record("internal_health_1_attempted", {
    endpointClass: "health",
    method: "GET",
    requestAttempted: true,
  });
  const healthResponse = await fetcher(endpoint(settings, "/healthz"));
  evidence?.record("internal_health_1_received", {
    endpointClass: "health",
    httpStatus: healthResponse.status,
    responseReceived: true,
  });
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
  evidence?.record("internal_health_1_passed", {
    service: "codex-chatgpt-web",
    status: "ok",
    pid: health.pid,
    version: EXPECTED_UPSTREAM_VERSION,
    mode: "full",
    acceptingTurns: true,
    activeHttpTurns: 0,
    activeBrowserTurns: 0,
  });

  const catalogUrl = endpoint(settings, "/v1/models");
  catalogUrl.searchParams.set("client_version", settings.clientVersion);
  evidence?.record("model_catalog_attempted", {
    endpointClass: "models",
    method: "GET",
    requestAttempted: true,
  });
  const catalogResponse = await fetcher(catalogUrl, {
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
      accept: "application/json",
    },
  });
  evidence?.record("model_catalog_received", {
    endpointClass: "models",
    httpStatus: catalogResponse.status,
    responseReceived: true,
  });
  if (!catalogResponse.ok)
    throw new ModelCatalogHttpError(
      catalogResponse.status,
      safeHealthCatalogResult(health.last_model_catalog_result),
    );
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

  evidence?.record("model_catalog_passed", {
    model: settings.model,
    reasoningEffort: "high",
  });
  evidence?.record("internal_health_2_attempted", {
    endpointClass: "health",
    method: "GET",
    requestAttempted: true,
  });
  const confirmedHealthResponse = await fetcher(endpoint(settings, "/healthz"));
  evidence?.record("internal_health_2_received", {
    endpointClass: "health",
    httpStatus: confirmedHealthResponse.status,
    responseReceived: true,
  });
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
  evidence?.record("internal_health_2_passed", {
    service: "codex-chatgpt-web",
    status: "ok",
    pid: confirmedHealth.pid,
    version: EXPECTED_UPSTREAM_VERSION,
    mode: "full",
    acceptingTurns: true,
    activeHttpTurns: 0,
    activeBrowserTurns: 0,
    successfulModelCatalogRequests: successfulCatalogRequests,
  });
  console.log(
    JSON.stringify({
      check: "bridge-ready",
      version: health.version,
      pid: health.pid,
      mode: health.mode,
      activeHttpTurns: health.active_http_turns,
      activeBrowserTurns: health.active_browser_turns,
      model: settings.model,
      clientVersion: settings.clientVersion,
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

/** Keeps all required local inputs fail-closed before the first preflight network request. */
export async function runPreflight(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetcher: BridgeFetch = fetch,
): Promise<BridgeProcessIdentity> {
  return verifyBridge(loadBridgeSettings(environment), fetcher);
}

/** Supplies explicit unknown fields when a health response was not observed. */
// ❌ Удалены browser-only health guards и UnavailableBridgeIdentity: D73 pins full mode and exact PID/port.
function emptyUnavailableHealth(observed = false): SanitizedUnavailableHealth {
  return {
    observed,
    httpStatus: null,
    service: null,
    status: null,
    pid: null,
    port: null,
    version: null,
    mode: null,
    acceptingTurns: null,
    activeHttpTurns: null,
    activeBrowserTurns: null,
    idle: null,
  };
}

/** Projects health replies onto fixed scalar fields so diagnostics cannot retain arbitrary payloads. */
function sanitizeUnavailableHealth(
  httpStatus: number,
  value: unknown,
): SanitizedUnavailableHealth {
  const health = asRecord(value);
  const positiveInteger = (field: unknown, maximum: number): number | null =>
    typeof field === "number" &&
    Number.isSafeInteger(field) &&
    field > 0 &&
    field <= maximum
      ? field
      : null;
  const nonNegativeInteger = (field: unknown): number | null =>
    typeof field === "number" && Number.isSafeInteger(field) && field >= 0
      ? field
      : null;
  const activeHttpTurns = nonNegativeInteger(health?.active_http_turns);
  const activeBrowserTurns = nonNegativeInteger(health?.active_browser_turns);
  return {
    observed: true,
    httpStatus,
    service:
      health?.service === "codex-chatgpt-web" ? "codex-chatgpt-web" : "other",
    status: health?.status === "ok" ? "ok" : "other",
    pid: positiveInteger(health?.pid, Number.MAX_SAFE_INTEGER),
    port: positiveInteger(health?.port, 65_535),
    version:
      health?.version === EXPECTED_UPSTREAM_VERSION
        ? EXPECTED_UPSTREAM_VERSION
        : "other",
    mode:
      health?.mode === "full" || health?.mode === "browser-only"
        ? health.mode
        : "other",
    acceptingTurns:
      typeof health?.accepting_turns === "boolean"
        ? health.accepting_turns
        : null,
    activeHttpTurns,
    activeBrowserTurns,
    idle:
      activeHttpTurns === null || activeBrowserTurns === null
        ? null
        : activeHttpTurns === 0 && activeBrowserTurns === 0,
  };
}

/** Owns one health side effect and returns only evidence-safe scalar fields. */
async function readUnavailableBridgeHealth(
  settings: UnavailableBridgeSettings,
  fetcher: BridgeFetch,
): Promise<SanitizedUnavailableHealth> {
  const response = await fetcher(endpoint(settings, "/healthz"), {
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => undefined);
  return sanitizeUnavailableHealth(response.status, body);
}

/** Applies the same pinned identity and idle contract to pre-health and post-health. */
function isExpectedUnavailableHealth(
  settings: UnavailableBridgeSettings,
  health: SanitizedUnavailableHealth,
): boolean {
  return (
    health.observed &&
    health.httpStatus !== null &&
    health.httpStatus >= 200 &&
    health.httpStatus < 300 &&
    health.service === "codex-chatgpt-web" &&
    health.status === "ok" &&
    health.pid === settings.expectedPid &&
    health.port === settings.expectedPort &&
    health.version === EXPECTED_UPSTREAM_VERSION &&
    health.mode === "full" &&
    health.acceptingTurns === true &&
    health.idle === true
  );
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
  fetcher: BridgeFetch = fetch,
  evidence?: StageEvidenceRecorder,
): Promise<void> {
  evidence?.record("post_ac1_health_attempted", {
    endpointClass: "health",
    method: "GET",
    requestAttempted: true,
  });
  const healthResponse = await fetcher(endpoint(settings, "/healthz"));
  evidence?.record("post_ac1_health_received", {
    endpointClass: "health",
    httpStatus: healthResponse.status,
    responseReceived: true,
  });
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
  evidence?.record("post_ac1_health_passed", {
    service: "codex-chatgpt-web",
    status: "ok",
    pid: health.pid,
    version: identity.version,
    mode: identity.mode,
    acceptingTurns: true,
    activeHttpTurns: 0,
    activeBrowserTurns: 0,
  });
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
  settings: { readonly model: string },
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
  readonly evidence?: StageEvidenceRecorder;
  readonly responseLeg?: "initial" | "continuation";
  readonly requestIdentity?: TurnIdentity & { readonly canaryId: string };
  readonly fetcher?: BridgeFetch;
}

/** Sends only to the validated local endpoint and leaves SSE outcome semantics to the contract parser. */
async function sendTurn(
  settings: BridgeSettings,
  body: Record<string, unknown>,
  options: SendTurnOptions = {},
): Promise<BridgeSseOutcome> {
  requireAc1Model(settings.model);
  const attemptedStage =
    options.responseLeg === "initial"
      ? "initial_responses_attempted"
      : "continuation_responses_attempted";
  const receivedStage =
    options.responseLeg === "initial"
      ? "initial_responses_received"
      : "continuation_responses_received";
  const endedStage =
    options.responseLeg === "initial"
      ? "initial_responses_stream_ended"
      : "continuation_responses_stream_ended";
  if (options.evidence && options.responseLeg) {
    options.evidence.record(attemptedStage, {
      endpointClass: "responses",
      method: "POST",
      requestAttempted: true,
      ...(options.requestIdentity ?? {}),
    });
  }
  const response = await (options.fetcher ?? fetch)(
    endpoint(settings, "/v1/responses"),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    },
  );
  options.evidence?.record(receivedStage, {
    endpointClass: "responses",
    httpStatus: response.status,
    responseReceived: true,
    ...(options.requestIdentity ?? {}),
  });
  const outcome = await readBridgeSse(response, {
    captureSanitizedTrace: options.captureSanitizedTrace ?? false,
  });
  const traceBytes = outcome.sanitizedTrace
    ? Buffer.from(JSON.stringify(outcome.sanitizedTrace), "utf8")
    : undefined;
  options.evidence?.record(endedStage, {
    streamDisposition: outcome.kind,
    ...("responseId" in outcome && outcome.responseId
      ? { responseId: outcome.responseId }
      : {}),
    ...(traceBytes
      ? {
          sanitizedTraceBytes: traceBytes.byteLength,
          sanitizedTraceSha256: createHash("sha256")
            .update(traceBytes)
            .digest("hex"),
        }
      : {}),
    ...(options.requestIdentity ?? {}),
  });
  return outcome;
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
export async function runFreshContext(
  settings: BridgeSettings,
  canaryId: string,
  dependencies: FreshContextDependencies = {},
): Promise<SessionReceipt> {
  const sessionStartedAt = new Date().toISOString();
  const sessionStartedMs = performance.now();
  const identity = { threadId: randomUUID(), turnId: randomUUID() };
  dependencies.evidence?.record("ac1_context_created", {
    ...identity,
    canaryId,
  });
  const initialBody = makeTurnBody(
    settings,
    identity,
    [makeEnvironmentMessage(identity), makeUserMessage(identity, canaryId)],
    true,
  );
  const firstStartedAt = new Date().toISOString();
  const firstStartedMs = performance.now();
  const first = requireCompleted(
    await sendTurn(settings, initialBody, {
      captureSanitizedTrace: true,
      responseLeg: "initial",
      requestIdentity: { ...identity, canaryId },
      ...(dependencies.evidence ? { evidence: dependencies.evidence } : {}),
      ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
    }),
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
  dependencies.evidence?.record("tool_call_observed", {
    toolName: "read_fixture",
    itemId: call.itemId,
    callId: call.callId,
    argumentsSha256: createHash("sha256").update(call.arguments).digest("hex"),
    ...identity,
    canaryId,
  });
  const fixtureReadStartedAt = new Date().toISOString();
  const fixtureReadStartedMs = performance.now();
  dependencies.evidence?.record("controlled_fixture_read_attempted", {
    fixtureName: FIXTURE_KEY,
    ...identity,
    canaryId,
  });
  const fixtureBytes = Buffer.from(
    await (dependencies.readFixture ?? readControlledFixture)(),
  );
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
  dependencies.evidence?.record("controlled_fixture_result_prepared", {
    fixtureName: FIXTURE_KEY,
    fixtureByteLength: fixtureBytes.length,
    fixtureSha256,
    toolOutputByteLength: Buffer.byteLength(toolOutput),
    toolOutputSha256: createHash("sha256").update(toolOutput).digest("hex"),
    ...identity,
    canaryId,
  });
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
    await sendTurn(settings, followUpBody, {
      captureSanitizedTrace: true,
      responseLeg: "continuation",
      requestIdentity: { ...identity, canaryId },
      ...(dependencies.evidence ? { evidence: dependencies.evidence } : {}),
      ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
    }),
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
  dependencies.evidence?.record("final_correlation_validated", {
    responseId: final.responseId,
    canaryId,
    fixtureSha256,
    ...identity,
  });
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
  executeFreshContext: FreshContextExecutor = runFreshContext,
  dependencies: FreshContextDependencies = {},
) {
  const canaryId = randomUUID();
  const receipt = await executeFreshContext(settings, canaryId, dependencies);
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

/** Maps arbitrary runner exceptions to a bounded receipt without serializing their messages. */
function safeRunnerFailure(error: unknown): {
  readonly errorClass: string;
  readonly errorCode: string;
  readonly exitClassification: string;
  readonly httpStatus?: number;
} {
  if (error instanceof EvidenceWriterError) {
    return {
      errorClass: "EvidenceWriterError",
      errorCode: "EVIDENCE_PERSISTENCE_FAILED",
      exitClassification: "EVIDENCE_PERSISTENCE_FAILURE",
    };
  }
  if (error instanceof ModelCatalogHttpError) {
    return {
      errorClass: "ModelCatalogHttpError",
      errorCode: "MODEL_CATALOG_HTTP",
      exitClassification: "RUNNER_FAILURE",
      httpStatus: error.httpStatus,
    };
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return {
      errorClass: "TimeoutError",
      errorCode: "TIMEOUT",
      exitClassification: "RUNNER_FAILURE",
    };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      errorClass: "AbortError",
      errorCode: "TRANSPORT_ERROR",
      exitClassification: "RUNNER_FAILURE",
    };
  }
  if (error instanceof TypeError) {
    return {
      errorClass: "TypeError",
      errorCode: "TRANSPORT_ERROR",
      exitClassification: "RUNNER_FAILURE",
    };
  }
  return {
    errorClass: error instanceof Error ? "Error" : "UnknownError",
    errorCode: "RUNNER_ERROR",
    exitClassification: "RUNNER_FAILURE",
  };
}

/** Owns the one-shot AC1 transaction so terminal evidence covers guards, both legs, and post-check. */
export async function runAc1OnlyWithEvidence(
  environment: Readonly<Record<string, string | undefined>>,
  evidence: StageEvidenceRecorder,
  fetcher: BridgeFetch = fetch,
  dependencies: Omit<FreshContextDependencies, "evidence" | "fetcher"> = {},
) {
  evidence.record("runner_started");
  try {
    const settings = loadBridgeSettings(environment);
    evidence.record("settings_validated", { model: settings.model });
    const bridgeIdentity = await verifyBridge(settings, fetcher, evidence);
    const receipt = await runAc1Only(settings, runFreshContext, {
      ...dependencies,
      evidence,
      fetcher,
    });
    await verifyBridgeStillIdle(settings, bridgeIdentity, fetcher, evidence);
    evidence.record("terminal_success", {
      exitClassification: "SUCCESS",
      lastProvenStage: evidence.lastProvenStage ?? "none",
      requestSent: evidence.requestSent,
      initialResponsesRequestSent: evidence.initialResponsesRequestSent,
      threadId: receipt.threadId,
      turnId: receipt.turnId,
      canaryId: receipt.canaryId,
      responseId: receipt.responseIds.continuation,
      fixtureSha256: receipt.fixture.sha256,
    });
    return receipt;
  } catch (error) {
    const failure = safeRunnerFailure(error);
    try {
      evidence.record("terminal_failure", {
        ...failure,
        lastProvenStage: evidence.lastProvenStage ?? "none",
        requestSent: evidence.requestSent,
        initialResponsesRequestSent: evidence.initialResponsesRequestSent,
      });
    } catch {
      throw new EvidenceWriterError();
    }
    throw error;
  }
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
  const controlToken = requiredEnvironment(
    "BRIDGE_SPIKE_CONTROL_TOKEN",
    process.env,
  );
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

/** Initializes every contract field so the first fsynced snapshot is self-describing. */
function emptyUnavailableProbeEvidence(
  settings: UnavailableBridgeSettings,
): UnavailableProbeEvidence {
  return {
    schemaVersion: "nr02-unavailable-evidence/1",
    expectedIsolatedPid: settings.expectedPid,
    expectedIsolatedPort: settings.expectedPort,
    productionPortGuard: settings.productionPort,
    model: settings.model,
    preHealth: emptyUnavailableHealth(),
    responsesRequestAttempted: false,
    outerHttpStatus: null,
    outerContentTypeClass: "not_received",
    sanitizedSseTrace: {
      schemaVersion: "nr02-sanitized-sse/1",
      complete: false,
      frameCount: 0,
      observedFrames: 0,
      frames: [],
    },
    terminalOutcomeKind: "not_observed",
    typedStatus: null,
    typedErrorType: null,
    typedCode: null,
    responseFailedObserved: false,
    responseCompletedObserved: false,
    responseIncompleteObserved: false,
    functionOrToolEvidenceObserved: false,
    readFixtureEvidenceObserved: false,
    continuationRequests: 0,
    fixtureReadsExecuted: 0,
    postHealth: {
      attempted: false,
      observed: false,
      sameProcess: null,
      idle: null,
      health: emptyUnavailableHealth(),
    },
    terminalClassification: "IN_PROGRESS",
  };
}

/** Copies only the parser's bounded allowlisted trace into the durable receipt. */
function storeUnavailableTrace(
  evidence: UnavailableProbeEvidence,
  trace: BridgeSseTrace,
): void {
  evidence.sanitizedSseTrace = {
    schemaVersion: trace.schemaVersion,
    complete: trace.complete,
    frameCount: trace.frames.length,
    observedFrames: trace.observedFrames,
    frames: trace.frames,
  };
  const terminalEvents = trace.frames.map((frame) => frame.event);
  evidence.responseFailedObserved = terminalEvents.includes("response.failed");
  evidence.responseCompletedObserved =
    terminalEvents.includes("response.completed");
  evidence.responseIncompleteObserved = terminalEvents.includes(
    "response.incomplete",
  );
  evidence.readFixtureEvidenceObserved = trace.frames.some(
    (frame) => frame.toolName === "read_fixture",
  );
  evidence.functionOrToolEvidenceObserved = trace.frames.some(
    (frame) =>
      frame.itemId !== undefined ||
      frame.callId !== undefined ||
      frame.toolName !== undefined ||
      frame.event === "response.output_item.added" ||
      frame.event === "response.output_item.done" ||
      frame.event === "response.function_call_arguments.delta" ||
      frame.event === "response.function_call_arguments.done",
  );
}

/** Projects parsed outcomes into typed flags without serializing output or arguments. */
function storeUnavailableOutcome(
  evidence: UnavailableProbeEvidence,
  outcome: BridgeSseOutcome,
): void {
  evidence.terminalOutcomeKind = outcome.kind;
  const observedEvents = outcome.events;
  evidence.responseFailedObserved ||=
    observedEvents.includes("response.failed");
  evidence.responseCompletedObserved ||=
    observedEvents.includes("response.completed");
  evidence.responseIncompleteObserved ||= observedEvents.includes(
    "response.incomplete",
  );
  if (outcome.kind === "failed") {
    evidence.typedStatus =
      Number.isInteger(outcome.status) &&
      outcome.status >= 100 &&
      outcome.status <= 599
        ? outcome.status
        : null;
    evidence.typedErrorType =
      outcome.errorType === "connector_error" ? "connector_error" : "other";
    evidence.typedCode =
      outcome.code === "connector_not_found" ? "connector_not_found" : "other";
  }
  if (outcome.kind === "completed" && outcome.functionCalls.length > 0) {
    evidence.functionOrToolEvidenceObserved = true;
    if (outcome.functionCalls.some((call) => call.name === "read_fixture")) {
      evidence.readFixtureEvidenceObserved = true;
    }
  }
}

// ❌ Удалён hasUnprovenUnavailableOutcome: D73 must persist the full mismatch before rejection.
/** Rejects incomplete, contradictory, completed, or tool-bearing negative-path outcomes. */
function isExactUnavailableOutcome(
  evidence: UnavailableProbeEvidence,
  outcome: BridgeSseOutcome | undefined,
): boolean {
  const terminalFrames = evidence.sanitizedSseTrace.frames.filter((frame) =>
    ["response.completed", "response.incomplete", "response.failed"].includes(
      frame.event,
    ),
  );
  return (
    outcome?.kind === "failed" &&
    outcome.status === 424 &&
    outcome.errorType === "connector_error" &&
    outcome.code === "connector_not_found" &&
    evidence.sanitizedSseTrace.complete &&
    terminalFrames.length === 1 &&
    terminalFrames[0]?.event === "response.failed" &&
    evidence.responseFailedObserved &&
    !evidence.responseCompletedObserved &&
    !evidence.responseIncompleteObserved &&
    !evidence.functionOrToolEvidenceObserved
  );
}

/** Maps internal failure stages to fixed text so raw provider errors never escape. */
function unavailableFailureMessage(
  stage: UnavailableProbeEvidence["failureStage"],
): string {
  switch (stage) {
    case "pre_health":
    case "pre_health_validation":
      return "The guarded isolated full-mode bridge failed its pre-health check.";
    case "responses_request":
      return "The isolated Responses request failed before an HTTP outcome was received.";
    case "responses_http":
      return "The isolated Responses request did not return HTTP 200 text/event-stream.";
    case "sse_read":
      return "The isolated Responses stream could not be read completely.";
    case "terminal_validation":
      return "The isolated Responses stream did not satisfy the typed connector_not_found contract.";
    case "post_health":
      return "The guarded isolated full-mode bridge failed its post-health check.";
    case "evidence_persistence":
      return "Sanitized unavailable-probe evidence could not be persisted.";
    default:
      return "The isolated unavailable-connector probe failed.";
  }
}

/** Runs the one-shot full-mode negative route with exact isolation and durable sanitized evidence. */
export async function runUnavailableConnectorProbe(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetcher: BridgeFetch = fetch,
) {
  const settings = loadUnavailableBridgeSettings(environment);
  const evidence = emptyUnavailableProbeEvidence(settings);
  const evidenceWriter = new FileUnavailableEvidenceWriter(
    settings.evidencePath,
  );
  let evidencePersistenceFailed = false;
  let phase: NonNullable<UnavailableProbeEvidence["failureStage"]> =
    "pre_health";
  const persist = (): boolean => {
    try {
      evidenceWriter.record(evidence);
      return true;
    } catch {
      evidencePersistenceFailed = true;
      evidence.failureStage = "evidence_persistence";
      return false;
    }
  };
  const noteFailure = (
    stage: NonNullable<UnavailableProbeEvidence["failureStage"]>,
  ): void => {
    if (!evidence.failureStage) evidence.failureStage = stage;
  };

  try {
    if (!persist()) throw new UnavailableEvidenceError();

    phase = "pre_health";
    try {
      evidence.preHealth = await readUnavailableBridgeHealth(settings, fetcher);
    } catch {
      noteFailure("pre_health");
      evidence.terminalClassification = "FAIL";
      if (!persist()) throw new UnavailableEvidenceError();
      throw new Error(unavailableFailureMessage(evidence.failureStage));
    }
    if (!persist()) throw new UnavailableEvidenceError();
    if (!isExpectedUnavailableHealth(settings, evidence.preHealth)) {
      noteFailure("pre_health_validation");
      evidence.terminalClassification = "FAIL";
      if (!persist()) throw new UnavailableEvidenceError();
      throw new Error(unavailableFailureMessage(evidence.failureStage));
    }

    phase = "responses_request";
    const identity = { threadId: randomUUID(), turnId: randomUUID() };
    const canaryId = randomUUID();
    const body = makeTurnBody(
      settings,
      identity,
      [makeEnvironmentMessage(identity), makeUserMessage(identity, canaryId)],
      true,
    );
    evidence.responsesRequestAttempted = true;
    if (!persist()) throw new UnavailableEvidenceError();

    let response: Response;
    try {
      response = await fetcher(endpoint(settings, "/v1/responses"), {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
    } catch {
      noteFailure("responses_request");
      evidence.terminalClassification = "FAIL";
      if (!persist()) throw new UnavailableEvidenceError();
      throw new Error(unavailableFailureMessage(evidence.failureStage));
    }

    evidence.outerHttpStatus = response.status;
    const rawContentType = response.headers.get("content-type");
    const contentType = rawContentType?.split(";", 1)[0]?.trim().toLowerCase();
    evidence.outerContentTypeClass =
      contentType === "text/event-stream"
        ? "text/event-stream"
        : contentType === "application/json"
          ? "application/json"
          : rawContentType
            ? "other"
            : "missing";
    persist();

    phase = "responses_http";
    let outcome: BridgeSseOutcome | undefined;
    let streamReadFailed = false;
    if (response.status === 200 && contentType === "text/event-stream") {
      phase = "sse_read";
      let tracePersisted = false;
      try {
        outcome = await readBridgeSse(response, {
          captureSanitizedTrace: true,
          onSanitizedTrace: (trace) => {
            storeUnavailableTrace(evidence, trace);
            tracePersisted = true;
            persist();
          },
        });
      } catch {
        streamReadFailed = true;
        try {
          await response.body?.cancel();
        } catch {
          // The post-health observation still runs if a failed stream cannot be cancelled.
        }
        evidence.terminalOutcomeKind = "stream_error";
        noteFailure("sse_read");
        if (!tracePersisted) {
          storeUnavailableTrace(evidence, {
            schemaVersion: "nr02-sanitized-sse/1",
            complete: false,
            observedFrames: 0,
            frames: [],
          });
        }
      }
      if (outcome) storeUnavailableOutcome(evidence, outcome);
      if (!persist()) evidencePersistenceFailed = true;
    } else {
      try {
        await response.body?.cancel();
      } catch {
        // A mismatched outer response must not suppress the post-health check.
      }
      noteFailure("responses_http");
      persist();
    }

    const outcomeMatches =
      !streamReadFailed && isExactUnavailableOutcome(evidence, outcome);
    if (!outcomeMatches && !streamReadFailed) {
      noteFailure(
        evidence.outerContentTypeClass === "text/event-stream" &&
          evidence.outerHttpStatus === 200
          ? "terminal_validation"
          : "responses_http",
      );
    }
    persist();

    phase = "post_health";
    evidence.postHealth.attempted = true;
    persist();
    try {
      const postHealth = await readUnavailableBridgeHealth(settings, fetcher);
      evidence.postHealth.observed = postHealth.observed;
      evidence.postHealth.health = postHealth;
      evidence.postHealth.sameProcess = postHealth.observed
        ? postHealth.pid === settings.expectedPid &&
          postHealth.port === settings.expectedPort
        : null;
      evidence.postHealth.idle = postHealth.observed ? postHealth.idle : null;
      if (
        !isExpectedUnavailableHealth(settings, postHealth) ||
        evidence.postHealth.sameProcess !== true
      ) {
        noteFailure("post_health");
      }
    } catch {
      evidence.postHealth.observed = false;
      evidence.postHealth.sameProcess = null;
      evidence.postHealth.idle = null;
      evidence.postHealth.health = emptyUnavailableHealth();
      noteFailure("post_health");
    }
    persist();

    if (evidencePersistenceFailed) noteFailure("evidence_persistence");
    evidence.terminalClassification = evidence.failureStage ? "FAIL" : "PASS";
    if (!persist()) evidencePersistenceFailed = true;
    if (evidencePersistenceFailed) throw new UnavailableEvidenceError();
    if (evidence.terminalClassification !== "PASS") {
      throw new Error(unavailableFailureMessage(evidence.failureStage));
    }

    const receipt = {
      check: "unavailable-connector",
      status: "pass",
      model: settings.model,
      isolatedBridge: {
        service: "codex-chatgpt-web",
        pid: settings.expectedPid,
        port: settings.expectedPort,
        version: EXPECTED_UPSTREAM_VERSION,
        mode: "full",
      },
      outcome: {
        kind: "failed",
        status: 424,
        errorType: "connector_error",
        code: "connector_not_found",
      },
      postHealth: "same-process-idle",
    };
    console.log(JSON.stringify(receipt));
    return receipt;
  } catch (error) {
    if (evidence.terminalClassification === "IN_PROGRESS") {
      noteFailure(phase);
      evidence.terminalClassification = "FAIL";
      persist();
    }
    if (error instanceof UnavailableEvidenceError) throw error;
    throw new Error(unavailableFailureMessage(evidence.failureStage));
  } finally {
    evidenceWriter.close();
  }
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
  if (mode === "--preflight-only") {
    await runPreflight();
    return;
  }
  if (mode === "--ac1-only") {
    const evidence = createStageEvidenceRecorderFromEnvironment();
    try {
      const receipt = await runAc1OnlyWithEvidence(process.env, evidence);
      console.log(JSON.stringify(receipt));
    } catch (error) {
      console.error(
        JSON.stringify({
          check: "bridge-live-runner",
          status: "fail",
          ...safeRunnerFailure(error),
        }),
      );
      process.exitCode = 1;
    } finally {
      evidence.close();
    }
    return;
  }
  if (mode === "--connector-unavailable-only") {
    await runUnavailableConnectorProbe();
    return;
  }
  const settings = loadBridgeSettings();
  await verifyBridge(settings);
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
    if (error instanceof EvidenceWriterError) {
      console.error(
        JSON.stringify({
          check: "bridge-live-runner",
          status: "fail",
          ...safeRunnerFailure(error),
        }),
      );
    } else if (error instanceof ModelCatalogHttpError) {
      console.error(JSON.stringify(error.toSanitizedReceipt()));
    } else {
      console.error(
        error instanceof Error ? error.message : "Bridge spike failed.",
      );
    }
    process.exitCode = 1;
  });
}
