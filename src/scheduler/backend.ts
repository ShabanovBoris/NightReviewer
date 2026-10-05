import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { ProtocolValueBySchema } from "../protocol";
import { RUNTIME_PROTOCOL_VERSION } from "../protocol";
import type {
  BackendFailureClass,
  BackendInvocationInput,
  BackendInvocationResult,
  BackendReconciliationResult,
  FakeReviewerBackendOptions,
  FakeScenarioPlan,
  ReviewerBackend,
  SchedulerClock,
  SchedulerPromptContext,
  SchedulerRunContext,
} from "./types";

export const NR08_FAKE_PROMPT =
  "NR-08 deterministic offline scheduler fixture; no semantic review.";

export const NR08_FAKE_BACKEND_PROFILE = {
  backend: "FAKE",
  backendProtocol: "nr-fake-scheduler/1",
  bridgeVersionPin: "not_applicable",
  model: "deterministic-fake",
  reasoningEffort: "offline",
  qualification: "OFFLINE_ONLY",
  configurationDigest: createHash("sha256")
    .update("nr08-fake-scheduler-profile/1", "utf8")
    .digest("hex"),
  runPlan: "NR08_FAKE_3X3",
  requiredRuns: 9,
} as const;

export const systemSchedulerClock: SchedulerClock = {
  nowMs: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const timer = setTimeout(
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        Math.max(0, ms),
      );
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

export class FakeReviewerBackend implements ReviewerBackend {
  readonly backend = "FAKE" as const;
  readonly profile = NR08_FAKE_BACKEND_PROFILE;
  readonly clock: SchedulerClock;
  activeInvocations = 0;
  maxObservedConcurrency = 0;
  readonly invocationOrder: string[] = [];
  readonly invocationContexts: Array<{
    readonly runId: string;
    readonly cycleId: string;
    readonly reviewId: string;
  }> = [];
  readonly invocationInputs: BackendInvocationInput[] = [];
  readonly reconciliationContexts: Array<{
    readonly runId: string;
    readonly cycleId: string;
    readonly reviewId: string;
  }> = [];
  reconciliationCount = 0;
  private readonly plans: ReadonlyMap<string, FakeScenarioPlan>;
  private readonly acceptedOutputs = new Map<
    string,
    {
      readonly output: ProtocolValueBySchema["workerOutput"];
      readonly rawBytes: Uint8Array;
    }
  >();

  constructor(options: FakeReviewerBackendOptions = {}) {
    this.plans = options.plans ?? new Map();
    this.clock = options.clock ?? systemSchedulerClock;
  }

  promptForRun(_context: SchedulerPromptContext): string {
    return NR08_FAKE_PROMPT;
  }

  async invoke(
    input: BackendInvocationInput,
  ): Promise<BackendInvocationResult> {
    const plan = this.planFor(input);
    this.begin(input, "INVOKE");
    try {
      if (plan.scenario === "DELAYED") {
        await this.clock.sleep(plan.delayMs ?? 25, input.signal);
      }
      if (plan.scenario === "PARTIAL_OR_MALFORMED") {
        return {
          kind: "MALFORMED",
          errorClass: "INVALID_SCHEMA",
          rawBytes: Buffer.from(
            'FAKE/OFFLINE\n{"status":"partial","output":',
            "utf8",
          ),
        };
      }
      if (plan.scenario === "TRANSIENT_ERROR") {
        return this.failure(
          input,
          "RETRYABLE_FAILURE",
          plan.errorClass ?? "TRANSIENT",
          plan.sendState ?? "UNSENT",
        );
      }
      if (plan.scenario === "PERMANENT_ERROR") {
        return this.failure(input, "PERMANENT_FAILURE", "PERMANENT");
      }
      if (plan.scenario === "AUTHENTICATION_ERROR") {
        return this.failure(input, "PERMANENT_FAILURE", "AUTHENTICATION");
      }
      if (plan.scenario === "POLICY_ERROR") {
        return this.failure(input, "PERMANENT_FAILURE", "POLICY");
      }
      const output = fakeWorkerOutput(
        input.context,
        input.claim,
        plan.scenario === "COMPLETE_WITH_FINDING",
      );
      const rawBytes = markedBytes(output);
      this.acceptedOutputs.set(attemptKey(input), { output, rawBytes });
      if (plan.scenario === "UNKNOWN_SEND") {
        return {
          kind: "UNKNOWN_SEND",
          errorClass: "UNKNOWN_SEND",
          rawBytes: markedBytes({
            backend: "FAKE",
            qualification: "OFFLINE_ONLY",
            runId: input.claim.runId,
            attemptId: input.claim.attemptId,
            sendState: "UNKNOWN",
          }),
        };
      }
      return { kind: "SUCCESS", output, rawBytes };
    } finally {
      this.finish();
    }
  }

  async reconcile(
    input: BackendInvocationInput,
  ): Promise<BackendReconciliationResult> {
    const plan = this.planFor(input);
    this.reconciliationCount += 1;
    this.begin(input, "RECONCILE");
    try {
      if (plan.scenario === "DELAYED") return { kind: "PROVEN_UNSENT" };
      const outcome =
        plan.reconciliation ??
        (plan.scenario === "UNKNOWN_SEND" ? "STILL_UNKNOWN" : "PROVEN_UNSENT");
      if (outcome === "STILL_UNKNOWN") return { kind: "STILL_UNKNOWN" };
      if (outcome === "PROVEN_UNSENT") return { kind: "PROVEN_UNSENT" };
      const accepted =
        this.acceptedOutputs.get(attemptKey(input)) ??
        (() => {
          const output = fakeWorkerOutput(
            input.context,
            input.claim,
            plan.scenario === "COMPLETE_WITH_FINDING",
          );
          return { output, rawBytes: markedBytes(output) };
        })();
      return {
        kind: "PROVEN_ACCEPTED_WITH_RESULT",
        output: accepted.output,
        rawBytes: accepted.rawBytes,
      };
    } finally {
      this.finish();
    }
  }

  private planFor(input: BackendInvocationInput): FakeScenarioPlan {
    const plan = this.plans.get(input.context.runId) ?? {
      scenario: "COMPLETE_NO_FINDINGS",
    };
    const sequence = plan.sequence;
    const scenario =
      sequence === undefined || sequence.length === 0
        ? plan.scenario
        : (sequence[
            Math.min(input.claim.attemptNumber - 1, sequence.length - 1)
          ] ?? plan.scenario);
    return { ...plan, scenario };
  }

  private begin(
    input: BackendInvocationInput,
    kind: "INVOKE" | "RECONCILE",
  ): void {
    if (input.signal.aborted) throw abortError();
    this.activeInvocations += 1;
    this.maxObservedConcurrency = Math.max(
      this.maxObservedConcurrency,
      this.activeInvocations,
    );
    const context = {
      runId: input.claim.runId,
      cycleId: input.claim.cycleId,
      reviewId: input.claim.reviewId,
    };
    if (kind === "INVOKE") {
      this.invocationOrder.push(input.claim.runId);
      this.invocationContexts.push(context);
      this.invocationInputs.push(input);
    } else {
      this.reconciliationContexts.push(context);
    }
  }

  private finish(): void {
    this.activeInvocations = Math.max(0, this.activeInvocations - 1);
  }

  private failure(
    input: BackendInvocationInput,
    kind: "RETRYABLE_FAILURE" | "PERMANENT_FAILURE",
    errorClass: BackendFailureClass,
    sendState: "UNSENT" | "SENT" | "UNKNOWN" = "UNSENT",
  ): BackendInvocationResult {
    const rawBytes = markedBytes({
      backend: "FAKE",
      qualification: "OFFLINE_ONLY",
      runId: input.claim.runId,
      attemptId: input.claim.attemptId,
      outcome: kind,
      errorClass,
      sendState,
    });
    return kind === "RETRYABLE_FAILURE"
      ? { kind, errorClass, sendState, rawBytes }
      : { kind, errorClass, rawBytes };
  }
}

export function fakeWorkerOutput(
  context: SchedulerRunContext,
  claim: BackendInvocationInput["claim"],
  withFinding = false,
): ProtocolValueBySchema["workerOutput"] {
  const findings = withFinding
    ? [
        {
          localId: "fake-fixture-finding",
          severity: "low" as const,
          title: "Deterministic fake finding",
          claim:
            "This fixture finding is visible for scheduler-flow verification only.",
          evidence: [
            {
              kind: "source" as const,
              path: "README.md",
              revision: {
                objectFormat: context.objectFormat,
                sha: context.headSha,
              },
              startLine: 1,
              endLine: 1,
            },
          ],
          impact:
            "No product correctness claim is made by this FAKE/OFFLINE finding.",
          location: "README.md:1",
          confidence: 1,
        },
      ]
    : [];
  return {
    schemaVersion: RUNTIME_PROTOCOL_VERSION,
    reviewId: claim.reviewId,
    cycleId: claim.cycleId,
    runId: claim.runId,
    attemptId: claim.attemptId,
    promptHash: context.promptHash,
    direction: claim.direction,
    objectFormat: context.objectFormat,
    reviewedBaseSha: context.baseSha,
    reviewedHeadSha: context.headSha,
    verdict: findings.length === 0 ? "NO_FINDINGS" : "FINDINGS",
    coverage: {
      complete: true,
      paths: ["README.md"],
      limitations: ["FAKE/OFFLINE scheduler fixture; not a semantic review."],
    },
    findings,
  } as ProtocolValueBySchema["workerOutput"];
}

function markedBytes(output: unknown): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      backend: "FAKE",
      qualification: "OFFLINE_ONLY",
      output,
    }),
    "utf8",
  );
}

function attemptKey(input: BackendInvocationInput): string {
  return `${input.claim.runId}:${input.claim.attemptId}`;
}

function abortError(): Error {
  const error = new Error("Fake backend turn was aborted.");
  error.name = "AbortError";
  return error;
}
