import type {
  ProtocolValueBySchema,
  WorkerDirection,
  WorkerFinding,
} from "../protocol";
import type {
  ArtifactReference,
  ClaimedSchedulerJob,
  SchedulerAttemptArtifact,
  SchedulerBackendProfile,
} from "../storage";

export type ReviewerBackendScenario =
  | "COMPLETE_NO_FINDINGS"
  | "COMPLETE_WITH_FINDING"
  | "TRANSIENT_ERROR"
  | "PERMANENT_ERROR"
  | "AUTHENTICATION_ERROR"
  | "POLICY_ERROR"
  | "PARTIAL_OR_MALFORMED"
  | "DELAYED"
  | "UNKNOWN_SEND";

export type BackendFailureClass =
  | "TRANSIENT"
  | "RATE_LIMIT"
  | "AUTHENTICATION"
  | "POLICY"
  | "INVALID_SCHEMA"
  | "PERMANENT"
  | "DEADLINE";

export interface SchedulerRunContext {
  readonly runId: string;
  readonly reviewId: string;
  readonly cycleId: string;
  readonly direction: WorkerDirection;
  readonly replicaIndex: number;
  readonly objectFormat: "sha1" | "sha256";
  readonly baseSha: string;
  readonly headSha: string;
  readonly promptHash: string;
  readonly schemaHash: string;
  readonly policyHash: string;
}

export type SchedulerPromptContext = Omit<SchedulerRunContext, "promptHash">;

export interface BackendInvocationInput {
  readonly claim: ClaimedSchedulerJob;
  readonly context: SchedulerRunContext;
  readonly signal: AbortSignal;
  readonly reportSendState?: (state: "UNSENT" | "UNKNOWN") => void;
}

export interface BackendTurnReceipt {
  readonly schemaVersion: "nr-backend-turn-receipt/1";
  readonly backend: "LIVE";
  readonly qualification: "LIVE_PRODUCTION_BRIDGE";
  readonly reviewId: string;
  readonly cycleId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly direction: WorkerDirection;
  readonly objectFormat: "sha1" | "sha256";
  readonly reviewedBaseSha: string;
  readonly reviewedHeadSha: string;
  readonly promptHash: string;
  readonly schemaHash: string;
  readonly policyHash: string;
  readonly bridge: {
    readonly service: "codex-chatgpt-web";
    readonly pid: number;
    readonly version: string;
    readonly mode: "full";
  };
  readonly model: {
    readonly requested: string;
    readonly observed: string | null;
    readonly reasoningEffortRequested: string;
    readonly reasoningEffortObserved: string | null;
    readonly advertisedReasoningEfforts: readonly string[];
  };
  readonly session: {
    readonly threadId: string;
    readonly turnIds: readonly string[];
    readonly responseIds: readonly string[];
    readonly freshForAttempt: true;
  };
  readonly outcome:
    | "COMPLETED"
    | "INCOMPLETE"
    | "FAILED"
    | "DISCONNECTED"
    | "ABORTED"
    | "AMBIGUOUS"
    | "MALFORMED";
  readonly sendState: "UNSENT" | "SENT" | "UNKNOWN";
  readonly rawArtifacts: readonly SchedulerAttemptArtifact[];
  readonly generatedAtUtc: string;
}

export interface BackendResultEvidence {
  readonly receipt?: BackendTurnReceipt;
  readonly receiptArtifact?: ArtifactReference;
  readonly primaryRawArtifact?: ArtifactReference;
  readonly rawArtifacts?: readonly SchedulerAttemptArtifact[];
  readonly sendState?: "UNSENT" | "SENT" | "UNKNOWN";
}

export type BackendInvocationResult = (
  | {
      readonly kind: "SUCCESS";
      readonly rawBytes: Uint8Array;
      readonly output: ProtocolValueBySchema["workerOutput"];
    }
  | {
      readonly kind: "RETRYABLE_FAILURE";
      readonly rawBytes: Uint8Array;
      readonly errorClass: BackendFailureClass;
      readonly sendState: "UNSENT" | "SENT" | "UNKNOWN";
    }
  | {
      readonly kind: "PERMANENT_FAILURE";
      readonly rawBytes: Uint8Array;
      readonly errorClass: BackendFailureClass;
    }
  | {
      readonly kind: "MALFORMED";
      readonly rawBytes: Uint8Array;
      readonly errorClass: "INVALID_SCHEMA";
    }
  | {
      readonly kind: "UNKNOWN_SEND";
      readonly rawBytes: Uint8Array;
      readonly errorClass: "UNKNOWN_SEND";
    }
) &
  BackendResultEvidence;

export type BackendReconciliationResult =
  | { readonly kind: "PROVEN_UNSENT" }
  | {
      readonly kind: "PROVEN_ACCEPTED_WITH_RESULT";
      readonly rawBytes: Uint8Array;
      readonly output: ProtocolValueBySchema["workerOutput"];
    }
  | { readonly kind: "STILL_UNKNOWN" };

export interface ReviewerBackend {
  readonly backend: "FAKE" | "LIVE";
  readonly profile: SchedulerBackendProfile;
  promptForRun(context: SchedulerPromptContext): string;
  invoke(input: BackendInvocationInput): Promise<BackendInvocationResult>;
  reconcile(
    input: BackendInvocationInput,
  ): Promise<BackendReconciliationResult>;
}

export interface FakeScenarioPlan {
  readonly scenario: ReviewerBackendScenario;
  readonly sequence?: readonly ReviewerBackendScenario[];
  readonly delayMs?: number;
  readonly errorClass?: BackendFailureClass;
  readonly sendState?: "UNSENT" | "SENT" | "UNKNOWN";
  readonly reconciliation?: BackendReconciliationResult["kind"];
}

export interface FakeReviewerBackendOptions {
  readonly plans?: ReadonlyMap<string, FakeScenarioPlan>;
  readonly clock?: SchedulerClock;
}

export interface SchedulerClock {
  nowMs(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface SchedulerOptions {
  readonly concurrency?: number;
  readonly maxAttempts?: number;
  readonly attemptTimeoutMs?: number;
  readonly leaseTtlMs?: number;
  readonly reviewDeadlineMs?: number;
  readonly maxBackoffMs?: number;
  readonly jitter?: (runId: string, attemptNumber: number) => number;
  readonly clock?: SchedulerClock;
  readonly drainTimeoutMs?: number;
}

export interface SchedulerProgress {
  readonly completedRuns: number;
  readonly requiredRuns: number;
  readonly activeRuns: number;
  readonly retryWaitingRuns: number;
  readonly reconciliationRequiredRuns: number;
  readonly failedRuns: number;
  readonly provisionalFindings: readonly {
    readonly runId: string;
    readonly direction: WorkerDirection;
    readonly replicaIndex: number;
    readonly localId: string;
    readonly finding: WorkerFinding;
  }[];
}

export interface SchedulerRunSeed extends SchedulerRunContext {
  readonly role: "reviewer";
  readonly runId: string;
  readonly schemaHash: string;
  readonly policyHash: string;
  readonly maxAttempts: number;
  readonly deadlineAtUtc: string;
}
