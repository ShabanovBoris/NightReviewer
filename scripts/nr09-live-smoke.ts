import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CHATGPT_WEB_BRIDGE_PIN,
  ChatGptWebReviewerBackend,
} from "../src/backends/chatgpt-web";
import { DaemonOwner, DaemonReviewRuntime } from "../src/daemon";
import { validProtocolExamples } from "../src/protocol";
import type {
  BackendInvocationInput,
  BackendInvocationResult,
  BackendTurnReceipt,
  SchedulerPromptContext,
} from "../src/scheduler";
import { DurableScheduler } from "../src/scheduler";
import { createSnapshotService } from "../src/snapshot";
import {
  type ArtifactReference,
  openStorage,
  type SqliteStorage,
} from "../src/storage";

const REPOSITORY = "ShabanovBoris/NightReviewer";
const PR_URL = "https://github.com/ShabanovBoris/NightReviewer/pull/10";
const TASK_ID = "NR-09";
const SESSION_ID = "d52c4dc6-1aa6-4a14-b880-8b8f66f2bbd0";
const ASSIGNED_BASE_SHA = "04fa7282d347f02f7c110b9707d87e41a3d40ff0";
const PHASE_B_OPTION = "AUTHORIZE_D141_PHASE_B_BOUNDED_LIVE_SMOKES";
const ACTION_LIMITS = {
  compatibilityPreflight: 1,
  completeSchedulerManagedReviewerRun: 1,
  cancellationSchedulerManagedTurn: 1,
} as const;
const QUALIFICATION_REPO_ID = "ShabanovBoris/NightReviewer";
const RESPONSE_ROUTE = "/v1/responses";
const ALLOWED_ROUTES = new Set(["/healthz", "/v1/models", RESPONSE_ROUTE]);
const OUTPUT_ROOT = path.join(
  ".nightreviewer",
  "dev",
  SESSION_ID,
  "evidence",
  "nr09-phase-b",
);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA1 = /^[0-9a-f]{40}$/;

export type SmokeMode = "preflight" | "complete" | "cancel";

export interface SmokeArguments {
  readonly mode: SmokeMode;
  readonly expectedHeadSha: string;
  readonly phaseBRequestId: string;
  readonly phaseBReceiptPath: string;
}

export class SmokeHarnessError extends Error {
  constructor(readonly code: string) {
    super("NR-09 smoke harness stopped safely.");
    this.name = "SmokeHarnessError";
  }
}

interface PhaseBAuthorization {
  readonly messageId: string;
  readonly decisionId: string;
  readonly authorizationId: string;
  readonly runtime: {
    readonly bridgeOrigin: string;
    readonly bridgeVersion: string;
    readonly clientVersion: string;
    readonly credentialProfileId: string;
    readonly model: string;
    readonly reasoningEffort: string;
  };
}

interface RuntimeConfig {
  readonly mode: SmokeMode;
  readonly repoRoot: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly bridgeBaseUrl: URL;
  readonly apiKey: string;
  readonly clientVersion: string;
  readonly credentialProfileId: string;
  readonly phaseB: PhaseBAuthorization;
  readonly phaseBReceipt: {
    readonly messageId: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  };
}

interface HealthObservation {
  readonly pid: number | null;
  readonly version: string | null;
  readonly mode: string | null;
  readonly acceptingTurns: boolean | null;
  readonly activeHttpTurns: number | null;
  readonly activeBrowserTurns: number | null;
}

interface ResponsesRequestObservation {
  readonly method: "POST";
  readonly route: typeof RESPONSE_ROUTE;
  readonly invokedAtUtc: string;
}

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface InvocationObservation {
  readonly reviewId: string;
  readonly cycleId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly direction: string;
  resultKind?: BackendInvocationResult["kind"];
  sendState?: BackendInvocationResult["sendState"];
  outputSha256?: string;
  receipt?: BackendTurnReceipt;
  rawArtifacts?: readonly { purpose: string; reference: ArtifactReference }[];
}

export function parseSmokeArguments(argv: readonly string[]): SmokeArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      throw new SmokeHarnessError("HELP_REQUESTED");
    }
    if (!argument?.startsWith("--")) {
      throw new SmokeHarnessError("INVALID_ARGUMENTS");
    }
    const equal = argument.indexOf("=");
    const name = equal < 0 ? argument : argument.slice(0, equal);
    let value: string | undefined;
    if (equal < 0) {
      index += 1;
      value = argv[index];
    } else {
      value = argument.slice(equal + 1);
    }
    if (
      value === undefined ||
      value.length === 0 ||
      ![
        "--mode",
        "--expected-head-sha",
        "--phase-b-request-id",
        "--phase-b-receipt",
      ].includes(name) ||
      values.has(name)
    ) {
      throw new SmokeHarnessError("INVALID_ARGUMENTS");
    }
    values.set(name, value);
  }
  const mode = values.get("--mode");
  const expectedHeadSha = values.get("--expected-head-sha");
  const phaseBRequestId = values.get("--phase-b-request-id");
  const phaseBReceiptPath = values.get("--phase-b-receipt");
  if (
    (mode !== "preflight" && mode !== "complete" && mode !== "cancel") ||
    expectedHeadSha === undefined ||
    !SHA1.test(expectedHeadSha) ||
    phaseBRequestId === undefined ||
    !SAFE_IDENTIFIER.test(phaseBRequestId) ||
    phaseBReceiptPath === undefined
  ) {
    throw new SmokeHarnessError("INVALID_ARGUMENTS");
  }
  return { mode, expectedHeadSha, phaseBRequestId, phaseBReceiptPath };
}

export function validatePhaseBDecision(
  rawText: string,
  expected: {
    readonly requestId: string;
    readonly baseSha: string;
    readonly headSha: string;
  },
): PhaseBAuthorization {
  const decision = extractDecision(rawText);
  const payload = asRecord(decision.payload);
  if (
    decision.protocol !== "nr-dev/1" ||
    decision.role !== "lead" ||
    decision.type !== "DECISION" ||
    decision.repository !== REPOSITORY ||
    decision.sessionId !== SESSION_ID ||
    decision.taskId !== TASK_ID ||
    decision.cycle !== 1 ||
    decision.inReplyTo !== expected.requestId ||
    payload?.selectedOption !== PHASE_B_OPTION
  ) {
    throw new SmokeHarnessError("PHASE_B_DECISION_MISMATCH");
  }
  const authorization = asRecord(payload.phaseBAuthorization);
  const identity = asRecord(authorization?.identity);
  const limits = asRecord(authorization?.maximumQualifyingActionsAuthorized);
  const runtime = asRecord(authorization?.runtime);
  const messageId = decision.messageId;
  const decisionId = payload.decisionId;
  const authorizationId = authorization?.authorizationId;
  const bridgeOrigin = runtime?.bridgeOrigin;
  const bridgeVersion = runtime?.bridgeVersion;
  const clientVersion = runtime?.clientVersion;
  const credentialProfileId = runtime?.credentialProfileId;
  const model = runtime?.model;
  const reasoningEffort = runtime?.reasoningEffort;
  if (
    typeof messageId !== "string" ||
    !SAFE_IDENTIFIER.test(messageId) ||
    typeof decisionId !== "string" ||
    !SAFE_IDENTIFIER.test(decisionId) ||
    typeof authorizationId !== "string" ||
    !SAFE_IDENTIFIER.test(authorizationId) ||
    identity === undefined ||
    authorization === undefined ||
    limits === undefined ||
    runtime === undefined ||
    identity.prUrl !== PR_URL ||
    identity.baseSha !== expected.baseSha ||
    identity.headSha !== expected.headSha ||
    authorization.route !==
      "EXISTING_RUNNING_PINNED_BRIDGE_WITH_PRIVATE_EXISTING_CREDENTIAL_PROFILE" ||
    limits?.compatibilityPreflight !== ACTION_LIMITS.compatibilityPreflight ||
    limits.completeSchedulerManagedReviewerRun !==
      ACTION_LIMITS.completeSchedulerManagedReviewerRun ||
    limits.cancellationSchedulerManagedTurn !==
      ACTION_LIMITS.cancellationSchedulerManagedTurn ||
    bridgeVersion !== CHATGPT_WEB_BRIDGE_PIN.upstreamVersion ||
    model !== CHATGPT_WEB_BRIDGE_PIN.model ||
    reasoningEffort !== CHATGPT_WEB_BRIDGE_PIN.reasoningEffort ||
    typeof bridgeOrigin !== "string" ||
    typeof clientVersion !== "string" ||
    typeof credentialProfileId !== "string"
  ) {
    throw new SmokeHarnessError("PHASE_B_SCOPE_MISMATCH");
  }
  return {
    messageId,
    decisionId,
    authorizationId,
    runtime: {
      bridgeOrigin,
      bridgeVersion: CHATGPT_WEB_BRIDGE_PIN.upstreamVersion,
      clientVersion,
      credentialProfileId,
      model: CHATGPT_WEB_BRIDGE_PIN.model,
      reasoningEffort: CHATGPT_WEB_BRIDGE_PIN.reasoningEffort,
    },
  };
}

export function createGuardedFetcher(options: {
  readonly fetcher: Fetcher;
  readonly mode: SmokeMode;
  readonly expectedOrigin: string;
  readonly expectedClientVersion: string;
  readonly onHealth: (health: HealthObservation) => void;
  readonly persistUnsafeHealth: (bytes: Uint8Array) => Promise<void>;
  readonly onResponseAttempt: (
    observation: ResponsesRequestObservation,
  ) => void;
}): typeof fetch {
  let responseCount = 0;
  const guardedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const validQuery =
      url.pathname === "/v1/models"
        ? url.searchParams.size === 1 &&
          url.searchParams.getAll("client_version").length === 1 &&
          url.searchParams.get("client_version") ===
            options.expectedClientVersion
        : url.search.length === 0;
    if (
      url.origin !== options.expectedOrigin ||
      !isLoopbackOrigin(url) ||
      !ALLOWED_ROUTES.has(url.pathname) ||
      !validQuery ||
      url.hash.length !== 0
    ) {
      throw new SmokeHarnessError("OUT_OF_SCOPE_HTTP_REQUEST");
    }
    if (url.pathname === RESPONSE_ROUTE) {
      if (method !== "POST" || options.mode === "preflight") {
        throw new SmokeHarnessError("TURN_NOT_ALLOWED_IN_MODE");
      }
      const maxRequests = options.mode === "complete" ? 2 : 1;
      if (responseCount >= maxRequests) {
        throw new SmokeHarnessError("LIVE_REQUEST_LIMIT_EXCEEDED");
      }
      const responsePromise = options.fetcher(input, {
        ...init,
        redirect: "error",
      });
      responseCount += 1;
      options.onResponseAttempt({
        method: "POST",
        route: RESPONSE_ROUTE,
        invokedAtUtc: new Date().toISOString(),
      });
      return responsePromise;
    }
    if (
      (url.pathname === "/healthz" && method !== "GET") ||
      (url.pathname === "/v1/models" && method !== "GET")
    ) {
      throw new SmokeHarnessError("OUT_OF_SCOPE_HTTP_METHOD");
    }
    const response = await options.fetcher(input, {
      ...init,
      redirect: "error",
    });
    if (url.pathname !== "/healthz" || response.status !== 200) return response;
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      await options.persistUnsafeHealth(bytes);
      throw new SmokeHarnessError("HEALTH_RESPONSE_NOT_JSON");
    }
    const value = asRecord(body);
    const health: HealthObservation = {
      pid: safeInteger(value?.pid),
      version: stringOrNull(value?.version),
      mode: stringOrNull(value?.mode),
      acceptingTurns:
        typeof value?.accepting_turns === "boolean"
          ? value.accepting_turns
          : null,
      activeHttpTurns: safeInteger(value?.active_http_turns) ?? null,
      activeBrowserTurns: safeInteger(value?.active_browser_turns) ?? null,
    };
    options.onHealth(health);
    if (health.activeHttpTurns !== 0 || health.activeBrowserTurns !== 0) {
      await options.persistUnsafeHealth(bytes);
      throw new SmokeHarnessError("UNRELATED_BRIDGE_TURN_ACTIVE_OR_UNKNOWN");
    }
    return response;
  };
  return Object.assign(guardedFetch, {
    preconnect: (
      _url: string | URL,
      _options?: {
        dns?: boolean;
        tcp?: boolean;
        http?: boolean;
        https?: boolean;
      },
    ) => {
      throw new SmokeHarnessError("OUT_OF_SCOPE_HTTP_REQUEST");
    },
  });
}

export function buildQualificationPrompt(
  context: SchedulerPromptContext,
): string {
  return [
    "NR-09 LIVE transport qualification only. This is not a code-quality review.",
    "Do not claim repository coverage, make findings, approve code, or adjudicate semantics.",
    "Return exactly one schema-valid nr-review/1 workerOutput with verdict INCOMPLETE,",
    "coverage.complete false, empty paths, empty findings, and one limitation stating",
    "that this turn proves transport only and performs no semantic review.",
    "Qualification acceptance criterion: NR09_LIVE_QUALIFICATION.",
    "Echo the exact run-bound identity appended by the caller. Do not add prose outside JSON.",
    "Qualification identity: " +
      JSON.stringify({
        reviewId: context.reviewId,
        cycleId: context.cycleId,
        runId: context.runId,
        direction: context.direction,
        objectFormat: context.objectFormat,
        reviewedBaseSha: context.baseSha,
        reviewedHeadSha: context.headSha,
      }),
  ].join("\n");
}

function extractDecision(rawText: string): Record<string, unknown> {
  const fence = String.fromCharCode(96).repeat(3);
  const pattern = new RegExp(fence + "json\\s*([\\s\\S]*?)" + fence, "g");
  const values: unknown[] = [];
  for (const match of rawText.matchAll(pattern)) {
    try {
      const encoded = match[1];
      if (encoded === undefined) throw new Error("Missing JSON capture.");
      values.push(JSON.parse(encoded));
    } catch {
      throw new SmokeHarnessError("PHASE_B_DECISION_INVALID_JSON");
    }
  }
  if (values.length === 0) {
    try {
      values.push(JSON.parse(rawText));
    } catch {
      throw new SmokeHarnessError("PHASE_B_DECISION_MISSING_JSON");
    }
  }
  const decisions = values.filter((value) => {
    const record = asRecord(value);
    return record?.type === "DECISION" && record.role === "lead";
  });
  const record = asRecord(decisions[0]);
  if (
    decisions.length !== 1 ||
    record === undefined ||
    asRecord(record.payload) === undefined
  ) {
    throw new SmokeHarnessError("PHASE_B_DECISION_MISSING");
  }
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requestUrl(input: RequestInfo | URL): URL {
  try {
    if (input instanceof URL) return input;
    return new URL(input instanceof Request ? input.url : input);
  } catch {
    throw new SmokeHarnessError("INVALID_REQUEST_URL");
  }
}

function isLoopbackUrl(url: URL): boolean {
  return (
    isLoopbackOrigin(url) &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
  );
}

function isLoopbackOrigin(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1") &&
    url.username.length === 0 &&
    url.password.length === 0
  );
}

function validateBaseUrl(raw: string): URL {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new SmokeHarnessError("INVALID_BRIDGE_URL");
  }
  if (
    !isLoopbackUrl(value) ||
    (value.pathname !== "/" && value.pathname.length !== 0)
  ) {
    throw new SmokeHarnessError("BRIDGE_URL_MUST_BE_LOOPBACK_ORIGIN");
  }
  return value;
}

async function loadRuntimeConfig(args: SmokeArguments): Promise<RuntimeConfig> {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const branch = execFileSync("git", ["branch", "--show-current"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const worktree = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (
    branch !== "nr-09-production-bridge-adapter" ||
    headSha !== args.expectedHeadSha ||
    worktree.length !== 0 ||
    !SHA1.test(headSha)
  ) {
    throw new SmokeHarnessError("EXACT_HEAD_OR_CLEAN_TREE_MISMATCH");
  }
  if (!SHA1.test(ASSIGNED_BASE_SHA)) {
    throw new SmokeHarnessError("INVALID_ASSIGNED_BASE");
  }
  execFileSync("git", ["cat-file", "-e", ASSIGNED_BASE_SHA + "^{commit}"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  const receiptPath = path.resolve(repoRoot, args.phaseBReceiptPath);
  const allowedReceiptRoot = path.resolve(
    repoRoot,
    ".nightreviewer",
    "dev",
    SESSION_ID,
    "messages",
    "nr09",
  );
  const receiptRelative = path.relative(allowedReceiptRoot, receiptPath);
  if (receiptRelative.startsWith("..") || path.isAbsolute(receiptRelative)) {
    throw new SmokeHarnessError("PHASE_B_RECEIPT_OUTSIDE_PRIVATE_JOURNAL");
  }
  const receiptStat = await lstat(receiptPath);
  if (
    !receiptStat.isFile() ||
    receiptStat.isSymbolicLink() ||
    (receiptStat.mode & 0o077) !== 0
  ) {
    throw new SmokeHarnessError("PHASE_B_RECEIPT_NOT_PRIVATE_REGULAR_FILE");
  }
  const receiptBytes = await readFile(receiptPath);
  const receiptText = receiptBytes.toString("utf8");
  const phaseB = validatePhaseBDecision(receiptText, {
    requestId: args.phaseBRequestId,
    baseSha: ASSIGNED_BASE_SHA,
    headSha,
  });

  const bridgeBaseUrl = validateBaseUrl(
    process.env.BRIDGE_SPIKE_BASE_URL ?? "",
  );
  const apiKey = process.env.BRIDGE_SPIKE_API_KEY ?? "";
  const clientVersion = process.env.BRIDGE_SPIKE_CLIENT_VERSION ?? "";
  const credentialProfileId = process.env.NR09_CREDENTIAL_PROFILE_ID ?? "";
  if (
    apiKey.trim().length === 0 ||
    clientVersion.length === 0 ||
    !SAFE_IDENTIFIER.test(credentialProfileId)
  ) {
    throw new SmokeHarnessError("PRIVATE_BRIDGE_PROFILE_UNAVAILABLE");
  }
  if (
    bridgeBaseUrl.origin !== phaseB.runtime.bridgeOrigin ||
    clientVersion !== phaseB.runtime.clientVersion ||
    credentialProfileId !== phaseB.runtime.credentialProfileId
  ) {
    throw new SmokeHarnessError("RUNTIME_IDENTITY_DIFFERS_FROM_PHASE_B");
  }
  return {
    mode: args.mode,
    repoRoot,
    baseSha: ASSIGNED_BASE_SHA,
    headSha,
    bridgeBaseUrl,
    apiKey,
    clientVersion,
    credentialProfileId,
    phaseB,
    phaseBReceipt: {
      messageId: phaseB.messageId,
      sha256: createHash("sha256").update(receiptBytes).digest("hex"),
      sizeBytes: receiptBytes.byteLength,
    },
  };
}

class ObservedChatGptWebReviewerBackend extends ChatGptWebReviewerBackend {
  readonly invocations: InvocationObservation[] = [];

  override async invoke(
    input: BackendInvocationInput,
  ): Promise<BackendInvocationResult> {
    const observation: InvocationObservation = {
      reviewId: input.context.reviewId,
      cycleId: input.context.cycleId,
      runId: input.context.runId,
      attemptId: input.claim.attemptId,
      direction: input.context.direction,
    };
    this.invocations.push(observation);
    const result = await super.invoke(input);
    observation.resultKind = result.kind;
    observation.sendState = result.sendState ?? result.receipt?.sendState;
    if (result.receipt !== undefined) observation.receipt = result.receipt;
    if (result.rawArtifacts !== undefined)
      observation.rawArtifacts = result.rawArtifacts;
    if (result.kind === "SUCCESS") {
      observation.outputSha256 = createHash("sha256")
        .update(JSON.stringify(result.output), "utf8")
        .digest("hex");
    }
    return result;
  }
}

function buildBackend(
  config: RuntimeConfig,
  store: SqliteStorage,
  runMode: SmokeMode,
  healthObservations: HealthObservation[],
  responseAttempts: ResponsesRequestObservation[],
  unsafeHealthArtifacts: ArtifactReference[],
): ObservedChatGptWebReviewerBackend {
  const guardedFetch = createGuardedFetcher({
    fetcher: fetch,
    mode: runMode,
    expectedOrigin: config.bridgeBaseUrl.origin,
    expectedClientVersion: config.clientVersion,
    onHealth: (health) => healthObservations.push(health),
    persistUnsafeHealth: async (bytes) => {
      unsafeHealthArtifacts.push(await store.persistRawArtifact(bytes));
    },
    onResponseAttempt: (observation) => responseAttempts.push(observation),
  });
  return new ObservedChatGptWebReviewerBackend({
    baseUrl: config.bridgeBaseUrl,
    apiKey: config.apiKey,
    clientVersion: config.clientVersion,
    credentialProfileId: config.credentialProfileId,
    buildPrompt: buildQualificationPrompt,
    persistRawArtifact: (bytes) => store.persistRawArtifact(bytes),
    fetcher: guardedFetch,
    requestTimeoutMs: 120_000,
  });
}

async function runPreflight(config: RuntimeConfig): Promise<void> {
  const run = await createEvidenceRun(config, "preflight");
  let store: SqliteStorage | undefined;
  const healthObservations: HealthObservation[] = [];
  const responseAttempts: ResponsesRequestObservation[] = [];
  const unsafeHealthArtifacts: ArtifactReference[] = [];
  let backend: ObservedChatGptWebReviewerBackend | undefined;
  try {
    store = await openStorage({ rootDir: path.join(run.directory, "storage") });
    backend = buildBackend(
      config,
      store,
      "preflight",
      healthObservations,
      responseAttempts,
      unsafeHealthArtifacts,
    );
    await reservePhaseBAction(run.directory, config, "preflight");
    const compatibility = await backend.checkCompatibility();
    if (
      compatibility.version !== CHATGPT_WEB_BRIDGE_PIN.upstreamVersion ||
      compatibility.model !== CHATGPT_WEB_BRIDGE_PIN.model ||
      compatibility.reasoningEffort !==
        CHATGPT_WEB_BRIDGE_PIN.reasoningEffort ||
      compatibility.activeHttpTurns !== 0 ||
      compatibility.activeBrowserTurns !== 0 ||
      responseAttempts.length !== 0
    ) {
      throw new SmokeHarnessError("PREFLIGHT_INCOMPATIBLE");
    }
    await writePrivateJson(path.join(run.directory, "sanitized-receipt.json"), {
      schemaVersion: "nr09-live-smoke-receipt/1",
      status: "PREFLIGHT_PASS",
      mode: "preflight",
      prUrl: PR_URL,
      baseSha: config.baseSha,
      headSha: config.headSha,
      phaseBDecisionId: config.phaseB.decisionId,
      phaseBAuthorizationId: config.phaseB.authorizationId,
      phaseBDecisionReceipt: config.phaseBReceipt,
      runtime: safeRuntimeIdentity(config),
      compatibility: {
        pid: compatibility.pid,
        version: compatibility.version,
        mode: compatibility.mode,
        acceptingTurns: compatibility.acceptingTurns,
        activeHttpTurns: compatibility.activeHttpTurns,
        activeBrowserTurns: compatibility.activeBrowserTurns,
        model: compatibility.model,
        reasoningEffort: compatibility.reasoningEffort,
        advertisedReasoningEfforts: compatibility.advertisedReasoningEfforts,
        capabilities: compatibility.capabilities,
      },
      rawArtifacts: compatibility.rawArtifacts,
      unsafeHealthArtifacts,
      reviewerResponseRequests: responseAttempts.length,
      storageIntegrity: store.integrityCheck(),
    });
    console.log(
      JSON.stringify({
        status: "PREFLIGHT_PASS",
        mode: "preflight",
        evidenceDir: path.relative(config.repoRoot, run.directory),
        pid: compatibility.pid,
        bridgeVersion: compatibility.version,
        model: compatibility.model,
        reasoningEffort: compatibility.reasoningEffort,
        reviewerResponseRequests: 0,
      }),
    );
  } finally {
    store?.close();
  }
}

async function runSchedulerSmoke(config: RuntimeConfig): Promise<void> {
  const run = await createEvidenceRun(config, config.mode);
  const healthObservations: HealthObservation[] = [];
  const responseAttempts: ResponsesRequestObservation[] = [];
  const unsafeHealthArtifacts: ArtifactReference[] = [];
  let store: SqliteStorage | undefined;
  let owner: DaemonOwner | undefined;
  let reviews: DaemonReviewRuntime | undefined;
  try {
    store = await openStorage({ rootDir: path.join(run.directory, "storage") });
    const activeStore = store;
    owner = DaemonOwner.acquire(activeStore, {
      ownerId: "nr09-" + config.mode + "-" + randomUUID(),
    });
    const activeOwner = owner;
    const backend = buildBackend(
      config,
      activeStore,
      config.mode,
      healthObservations,
      responseAttempts,
      unsafeHealthArtifacts,
    );
    const scheduler = new DurableScheduler({
      store: activeStore,
      owner: activeOwner,
      backend,
      concurrency: 1,
      maxAttempts: 1,
      attemptTimeoutMs: 135_000,
      leaseTtlMs: 165_000,
      reviewDeadlineMs: 180_000,
      maxBackoffMs: 1_000,
    });
    const snapshotService = await createSnapshotService({
      store: activeStore,
      repositoryPaths: new Map([[QUALIFICATION_REPO_ID, config.repoRoot]]),
      fencingProvider: () => activeOwner.fencingToken(),
    });
    reviews = new DaemonReviewRuntime({
      store: activeStore,
      owner: activeOwner,
      snapshotService,
      trustedRepositoryIds: new Set([QUALIFICATION_REPO_ID]),
      scheduler,
      drainTimeoutMs: 10_000,
    });

    await reservePhaseBAction(run.directory, config, config.mode);
    const submitted = (await reviews.invoke(
      "review_submit",
      {
        ...validProtocolExamples.reviewSubmitInput,
        repoId: QUALIFICATION_REPO_ID,
        baseSha: config.baseSha,
        headSha: config.headSha,
        task: "NR-09 transport qualification only; no semantic review or approval.",
        acceptanceCriteria: [
          {
            id: "NR09_LIVE_QUALIFICATION",
            requirement:
              "Qualify exactly one scheduler-managed ChatGPT Web transport turn for this exact PR SHA pair.",
          },
        ],
        idempotencyKey: "nr09-" + config.mode + "-" + randomUUID(),
      },
      "nr09-" + config.mode + "-" + randomUUID(),
    )) as { readonly reviewId: string; readonly cycleId: string };

    let result: Record<string, unknown>;
    await scheduler.start();
    reviews.start();
    if (config.mode === "complete") {
      await waitFor(() => {
        const state = scheduler.progress(submitted.cycleId).state;
        return state !== "QUEUED" && state !== "RUNNING";
      }, 180_000);
      result = validateCompleteRun(
        config,
        submitted,
        activeStore,
        scheduler,
        backend,
        healthObservations,
        responseAttempts,
        unsafeHealthArtifacts,
      );
    } else {
      await waitFor(
        () =>
          responseAttempts.length > 0 ||
          scheduler.progress(submitted.cycleId).state === "FAILED" ||
          scheduler.progress(submitted.cycleId).state ===
            "RECONCILIATION_REQUIRED",
        120_000,
      );
      const beforeCancel = scheduler.progress(submitted.cycleId);
      if (
        responseAttempts.length !== 1 ||
        beforeCancel.state !== "RUNNING" ||
        beforeCancel.activeRuns !== 1 ||
        beforeCancel.completedRuns !== 0
      ) {
        throw new SmokeHarnessError("CANCELLATION_NOT_SENT_WHILE_ACTIVE");
      }
      const cancelResult = (await reviews.invoke(
        "review_cancel",
        {
          reviewId: submitted.reviewId,
          reason: "NR-09 bounded cancellation qualification.",
          idempotencyKey: "nr09-cancel-" + randomUUID(),
        },
        "nr09-cancel-" + randomUUID(),
      )) as { readonly state: string };
      await waitFor(
        () =>
          backend.invocations[0]?.resultKind !== undefined ||
          activeStore.readReview(submitted.reviewId).state === "FAILED",
        15_000,
      );
      result = validateCancellation(
        config,
        submitted,
        cancelResult,
        activeStore,
        scheduler,
        backend,
        healthObservations,
        responseAttempts,
        unsafeHealthArtifacts,
      );
    }
    const integrity = activeStore.integrityCheck();
    if (integrity.integrity !== "ok" || integrity.foreignKeyViolations !== 0) {
      throw new SmokeHarnessError("STORAGE_INTEGRITY_FAILED");
    }
    result.storageIntegrity = integrity;
    result.evidenceDir = path.relative(config.repoRoot, run.directory);
    await writePrivateJson(
      path.join(run.directory, "sanitized-receipt.json"),
      result,
    );
    console.log(
      JSON.stringify({
        status: result.status,
        mode: config.mode,
        evidenceDir: result.evidenceDir,
        reviewId: submitted.reviewId,
        cycleId: submitted.cycleId,
        runId: backend.invocations[0]?.runId ?? null,
        attemptId: backend.invocations[0]?.attemptId ?? null,
      }),
    );
  } finally {
    await reviews?.drain(10_000).catch(() => undefined);
    try {
      owner?.release();
    } finally {
      store?.close();
    }
  }
}

function validateCompleteRun(
  config: RuntimeConfig,
  submitted: { readonly reviewId: string; readonly cycleId: string },
  store: SqliteStorage,
  scheduler: DurableScheduler,
  backend: ObservedChatGptWebReviewerBackend,
  health: readonly HealthObservation[],
  responseRequests: readonly ResponsesRequestObservation[],
  unsafeHealthArtifacts: readonly ArtifactReference[],
): Record<string, unknown> {
  const progress = scheduler.progress(submitted.cycleId);
  const review = store.readReview(submitted.reviewId);
  const invocation = backend.invocations[0];
  if (
    invocation === undefined ||
    backend.invocations.length !== 1 ||
    responseRequests.length < 1 ||
    responseRequests.length > 2 ||
    invocation.resultKind !== "SUCCESS" ||
    invocation.receipt?.outcome !== "COMPLETED" ||
    invocation.receipt.sendState !== "SENT" ||
    progress.state !== "COMPLETE" ||
    progress.completedRuns !== 1 ||
    progress.requiredRuns !== 1 ||
    progress.failedRuns !== 0 ||
    progress.reconciliationRequiredRuns !== 0 ||
    review.state !== "REVIEWING" ||
    store.readCanonicalFindings(submitted.cycleId).length !== 0 ||
    invocation.receipt.reviewId !== submitted.reviewId ||
    invocation.receipt.cycleId !== submitted.cycleId ||
    invocation.receipt.runId !== invocation.runId ||
    invocation.receipt.attemptId !== invocation.attemptId ||
    invocation.receipt.reviewedBaseSha !== config.baseSha ||
    invocation.receipt.reviewedHeadSha !== config.headSha ||
    invocation.receipt.bridge.version !==
      CHATGPT_WEB_BRIDGE_PIN.upstreamVersion ||
    invocation.receipt.model.observed !== CHATGPT_WEB_BRIDGE_PIN.model ||
    invocation.receipt.model.reasoningEffortObserved !==
      CHATGPT_WEB_BRIDGE_PIN.reasoningEffort
  ) {
    throw new SmokeHarnessError("COMPLETE_SMOKE_INVARIANT_FAILED");
  }
  const selected = store.readSchedulerSelectedRuns(submitted.cycleId);
  const selectedRun = selected[0];
  const selectedOutput = asRecord(selectedRun?.output);
  if (
    selected.length !== 1 ||
    selectedRun?.runId !== invocation.runId ||
    selectedOutput === undefined ||
    selectedOutput.reviewId !== submitted.reviewId ||
    selectedOutput.cycleId !== submitted.cycleId ||
    selectedOutput.runId !== invocation.runId ||
    selectedOutput.attemptId !== invocation.attemptId ||
    selectedOutput.reviewedHeadSha !== config.headSha
  ) {
    throw new SmokeHarnessError("COMPLETE_RUN_BINDING_MISMATCH");
  }
  const provenance = store.readSchedulerAttemptProvenance(invocation.attemptId);
  if (
    provenance.sendState !== "SENT" ||
    provenance.receiptArtifact === undefined ||
    !provenance.artifacts.some((item) => item.purpose === "TURN_RESPONSE")
  ) {
    throw new SmokeHarnessError("COMPLETE_RUN_PROVENANCE_MISSING");
  }
  return {
    schemaVersion: "nr09-live-smoke-receipt/1",
    status: "COMPLETE_TRANSPORT_QUALIFIED",
    mode: "complete",
    prUrl: PR_URL,
    baseSha: config.baseSha,
    headSha: config.headSha,
    phaseBDecisionId: config.phaseB.decisionId,
    phaseBAuthorizationId: config.phaseB.authorizationId,
    phaseBDecisionReceipt: config.phaseBReceipt,
    runtime: safeRuntimeIdentity(config),
    healthObservations: health,
    reviewerResponseRequests: responseRequests,
    backendBinding: backend.profile,
    review: {
      reviewId: submitted.reviewId,
      cycleId: submitted.cycleId,
      state: review.state,
      schedulerState: progress.state,
      completedRuns: progress.completedRuns,
      requiredRuns: progress.requiredRuns,
      failedRuns: progress.failedRuns,
      canonicalFindingCount: 0,
      selectedRunCount: selected.length,
      approvalCredit: false,
      semanticReviewCredit: false,
    },
    invocation: safeInvocation(invocation),
    attemptProvenance: provenance,
    unsafeHealthArtifacts,
  };
}

function validateCancellation(
  config: RuntimeConfig,
  submitted: { readonly reviewId: string; readonly cycleId: string },
  cancelResult: { readonly state: string },
  store: SqliteStorage,
  scheduler: DurableScheduler,
  backend: ObservedChatGptWebReviewerBackend,
  health: readonly HealthObservation[],
  responseRequests: readonly ResponsesRequestObservation[],
  unsafeHealthArtifacts: readonly ArtifactReference[],
): Record<string, unknown> {
  const progress = scheduler.progress(submitted.cycleId);
  const review = store.readReview(submitted.reviewId);
  const invocation = backend.invocations[0];
  if (
    invocation === undefined ||
    backend.invocations.length !== 1 ||
    responseRequests.length !== 1 ||
    cancelResult.state !== "CANCELLED" ||
    review.state !== "CANCELLED" ||
    progress.state !== "CANCELLED" ||
    progress.completedRuns !== 0 ||
    progress.activeRuns !== 0 ||
    invocation.resultKind === "SUCCESS" ||
    invocation.receipt?.outcome !== "ABORTED" ||
    invocation.receipt.sendState !== "UNKNOWN" ||
    invocation.receipt.runId !== invocation.runId ||
    invocation.receipt.attemptId !== invocation.attemptId ||
    invocation.receipt.reviewedHeadSha !== config.headSha
  ) {
    throw new SmokeHarnessError("CANCELLATION_SMOKE_INVARIANT_FAILED");
  }
  let provenance: ReturnType<SqliteStorage["readSchedulerAttemptProvenance"]>;
  try {
    provenance = store.readSchedulerAttemptProvenance(invocation.attemptId);
  } catch {
    throw new SmokeHarnessError("CANCELLATION_PROVENANCE_MISSING");
  }
  if (provenance.sendState !== "UNKNOWN") {
    throw new SmokeHarnessError("CANCELLATION_SEND_STATE_NOT_UNKNOWN");
  }
  return {
    schemaVersion: "nr09-live-smoke-receipt/1",
    status: "CANCELLED_AFTER_RESPONSE_REQUEST",
    mode: "cancel",
    prUrl: PR_URL,
    baseSha: config.baseSha,
    headSha: config.headSha,
    phaseBDecisionId: config.phaseB.decisionId,
    phaseBAuthorizationId: config.phaseB.authorizationId,
    phaseBDecisionReceipt: config.phaseBReceipt,
    runtime: safeRuntimeIdentity(config),
    healthObservations: health,
    reviewerResponseRequests: responseRequests,
    backendBinding: backend.profile,
    review: {
      reviewId: submitted.reviewId,
      cycleId: submitted.cycleId,
      state: review.state,
      schedulerState: progress.state,
      completedRuns: progress.completedRuns,
      requiredRuns: progress.requiredRuns,
      failedRuns: progress.failedRuns,
      selectedRunCount: 0,
      approvalCredit: false,
      semanticReviewCredit: false,
    },
    invocation: safeInvocation(invocation),
    attemptProvenance: provenance,
    unsafeHealthArtifacts,
  };
}

function safeInvocation(
  invocation: InvocationObservation,
): Record<string, unknown> {
  return {
    reviewId: invocation.reviewId,
    cycleId: invocation.cycleId,
    runId: invocation.runId,
    attemptId: invocation.attemptId,
    direction: invocation.direction,
    resultKind: invocation.resultKind,
    sendState: invocation.sendState,
    outputSha256: invocation.outputSha256,
    receipt: invocation.receipt,
    rawArtifacts: invocation.rawArtifacts,
  };
}

function safeRuntimeIdentity(config: RuntimeConfig): Record<string, unknown> {
  return {
    bridgeOrigin: config.bridgeBaseUrl.origin,
    bridgeVersionPin: CHATGPT_WEB_BRIDGE_PIN.upstreamVersion,
    model: CHATGPT_WEB_BRIDGE_PIN.model,
    reasoningEffort: CHATGPT_WEB_BRIDGE_PIN.reasoningEffort,
    clientVersion: config.clientVersion,
    credentialProfileId: config.credentialProfileId,
  };
}

async function createEvidenceRun(
  config: RuntimeConfig,
  mode: SmokeMode,
): Promise<{ readonly directory: string }> {
  const evidenceRoot = path.resolve(config.repoRoot, OUTPUT_ROOT);
  await secureDirectory(evidenceRoot);
  const directory = path.join(
    evidenceRoot,
    new Date().toISOString().replaceAll(":", "") +
      "-" +
      mode +
      "-" +
      randomUUID(),
  );
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  await mkdir(path.join(directory, "storage"), { mode: 0o700 });
  await chmod(path.join(directory, "storage"), 0o700);
  return { directory };
}

async function reservePhaseBAction(
  runDirectory: string,
  config: RuntimeConfig,
  mode: SmokeMode,
): Promise<void> {
  const reservations = path.join(
    config.repoRoot,
    OUTPUT_ROOT,
    "reservations",
    config.phaseB.decisionId,
  );
  await secureDirectory(reservations);
  const actionDirectory = path.join(reservations, mode);
  try {
    await mkdir(actionDirectory, { mode: 0o700 });
    await chmod(actionDirectory, 0o700);
  } catch {
    throw new SmokeHarnessError("PHASE_B_ACTION_ALREADY_RESERVED");
  }
  await writePrivateJson(path.join(actionDirectory, "reservation.json"), {
    schemaVersion: "nr09-phase-b-action-reservation/1",
    mode,
    phaseBDecisionId: config.phaseB.decisionId,
    phaseBAuthorizationId: config.phaseB.authorizationId,
    baseSha: config.baseSha,
    headSha: config.headSha,
    evidenceDirectory: path.relative(config.repoRoot, runDirectory),
    reservedAtUtc: new Date().toISOString(),
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new SmokeHarnessError("BOUNDED_WAIT_EXPIRED");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

async function writePrivateJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  await writeFile(filePath, bytes, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function secureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function main(): Promise<void> {
  const args = parseSmokeArguments(process.argv.slice(2));
  const config = await loadRuntimeConfig(args);
  if (
    config.bridgeBaseUrl.origin !== config.phaseB.runtime.bridgeOrigin ||
    config.clientVersion !== config.phaseB.runtime.clientVersion ||
    config.credentialProfileId !== config.phaseB.runtime.credentialProfileId
  ) {
    throw new SmokeHarnessError("RUNTIME_IDENTITY_DIFFERS_FROM_PHASE_B");
  }
  if (config.mode === "preflight") {
    await runPreflight(config);
  } else {
    await runSchedulerSmoke(config);
  }
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    const code =
      error instanceof SmokeHarnessError
        ? error.code
        : error instanceof Error
          ? error.name
          : "UNKNOWN_FAILURE";
    console.error(
      JSON.stringify({ status: "BLOCKED_OR_FAILED", errorCode: code }),
    );
    process.exitCode = 1;
  });
}
