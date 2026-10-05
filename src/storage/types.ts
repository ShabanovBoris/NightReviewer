import type {
  ApprovalEvidence,
  IdempotencyBinding,
  ProtocolJsonValue,
  ReviewCycleState,
  ReviewSubmitInput,
  VersionHashBinding,
  WorkerDirection,
  WorkerFinding,
} from "../protocol";

export const STORAGE_SCHEMA_VERSION = 4;

export interface OpenStorageOptions {
  /** One NightReviewer-owned directory. Database/artifact paths are fixed beneath it. */
  readonly rootDir: string;
  readonly busyTimeoutMs?: number;
}

export interface CreateReviewInput {
  readonly callerId: string;
  readonly submission: ReviewSubmitInput;
  readonly reviewContextHash: string;
  readonly versionBinding: VersionHashBinding;
  readonly createdAtUtc?: string;
  readonly fencing?: FencingToken;
}

export interface CreatedReview {
  readonly reviewId: string;
  readonly cycleId: string;
  readonly state: "QUEUED";
  readonly stateVersion: 0;
  readonly revisions: ReviewCycleState["revisions"];
  readonly versionBinding: VersionHashBinding;
}

export interface ReviewRecord {
  readonly reviewId: string;
  readonly cycleId: string;
  readonly repoId: string;
  readonly task: string;
  readonly acceptanceCriteria: ReviewSubmitInput["acceptanceCriteria"];
  readonly profile: ReviewSubmitInput["profile"];
  readonly state: ReviewCycleState["state"];
  readonly stateVersion: number;
  readonly revisions: ReviewCycleState["revisions"];
  readonly versionBinding: VersionHashBinding;
  readonly cycle: ReviewCycleState;
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
}

export interface ArtifactReference {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly relativePath: string;
}

export type ArtifactIssueKind =
  | "ORPHAN_FILE"
  | "MISSING_FILE"
  | "HASH_MISMATCH"
  | "SIZE_MISMATCH"
  | "TEMPORARY_FILE";

export interface ArtifactIssue {
  readonly kind: ArtifactIssueKind;
  readonly relativePath: string;
  readonly sha256?: string;
  readonly expectedSha256?: string;
  readonly expectedSizeBytes?: number;
  readonly observedSizeBytes?: number;
}

export interface ReconciliationReport {
  readonly schemaVersion: number;
  readonly scannedAtUtc: string;
  readonly issues: readonly ArtifactIssue[];
}

export interface WorkerAttemptInput {
  readonly attemptId: string;
  readonly directionRunId: string;
  readonly attemptNumber: number;
  readonly model?: string;
  readonly effort?: string;
  readonly startedAtUtc?: string;
  readonly metadata?: unknown;
}

export type WorkerResultDisposition =
  | "VALID"
  | "MALFORMED"
  | "REJECTED"
  | "OBSOLETE"
  | "FAILED";

export interface WorkerResultInput {
  readonly attemptId: string;
  readonly rawArtifact: ArtifactReference;
  readonly disposition: WorkerResultDisposition;
  readonly parsedResult?: unknown;
  readonly selected: boolean;
  readonly contentType?: string;
  readonly recordedAtUtc?: string;
}

export interface WorkerResultRecord {
  readonly resultId: string;
  readonly attemptId: string;
  readonly directionRunId: string;
  readonly disposition: WorkerResultDisposition;
  readonly selected: boolean;
  readonly rawArtifact: ArtifactReference;
  readonly parsedResult?: ProtocolJsonValue;
  readonly recordedAtUtc: string;
}

export interface SnapshotInput {
  readonly snapshotId: string;
  readonly cycleId: string;
  readonly objectFormat: "sha1" | "sha256";
  readonly baseSha: string;
  readonly headSha: string;
  readonly manifestHash: string;
  readonly manifest: ProtocolJsonValue;
  readonly createdAtUtc?: string;
}

export interface SnapshotRecord extends SnapshotInput {
  readonly createdAtUtc: string;
}

export interface SnapshotCycleContext {
  readonly reviewId: string;
  readonly cycleId: string;
  readonly repoId: string;
  readonly task: string;
  readonly acceptanceCriteria: ReviewSubmitInput["acceptanceCriteria"];
  readonly cycle: ReviewCycleState;
}

export interface StoredReviewEvent {
  readonly eventId: string;
  readonly eventSeq: number;
  readonly eventType: string;
  readonly payload: unknown;
  readonly occurredAtUtc: string;
}

export interface ReviewEventPage {
  readonly events: readonly StoredReviewEvent[];
  readonly hasMore: boolean;
}

export interface DirectionRunBinding {
  readonly reviewId: string;
  readonly cycleId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly direction: WorkerDirection;
  readonly role: "reviewer" | "adjudicator" | "fix_verifier";
}

export interface DirectionRunInput {
  readonly runId: string;
  readonly cycleId: string;
  readonly direction: WorkerDirection;
  readonly role: "reviewer" | "adjudicator" | "fix_verifier";
  readonly promptHash: string;
  readonly schemaHash: string;
  readonly policyHash: string;
  readonly createdAtUtc?: string;
}

export interface SchedulerRunInput extends DirectionRunInput {
  readonly reviewId: string;
  readonly replicaIndex: number;
  readonly maxAttempts: number;
  readonly deadlineAtUtc: string;
}

export type SchedulerBackendKind = "FAKE" | "LIVE";
export type SchedulerQualification = "OFFLINE_ONLY" | "LIVE_PRODUCTION_BRIDGE";
export type SchedulerRunPlanId = "NR08_FAKE_3X3" | "NR09_LIVE_QUALIFICATION";

/** Non-secret, immutable backend identity stored before any scheduler claim. */
export interface SchedulerBackendProfile {
  readonly backend: SchedulerBackendKind;
  readonly backendProtocol: string;
  readonly bridgeVersionPin: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly qualification: SchedulerQualification;
  readonly configurationDigest: string;
  readonly runPlan: SchedulerRunPlanId;
  readonly requiredRuns: 1 | 9;
}

export interface SchedulerBackendBinding extends SchedulerBackendProfile {
  readonly cycleId: string;
  readonly createdAtUtc: string;
}

export type SchedulerAttemptArtifactPurpose =
  | "HEALTH"
  | "MODEL_CATALOG"
  | "TURN_RESPONSE"
  | "SCHEMA_REPAIR_RESPONSE"
  | "LOCAL_DIAGNOSTIC"
  | "RECEIPT";

export interface SchedulerAttemptArtifact {
  readonly purpose: SchedulerAttemptArtifactPurpose;
  readonly reference: ArtifactReference;
}

export interface SchedulerAttemptProvenance {
  readonly sendState: "UNSENT" | "SENT" | "UNKNOWN" | null;
  readonly receiptArtifact?: ArtifactReference;
  readonly artifacts: readonly SchedulerAttemptArtifact[];
}

export type SchedulerJobState =
  | "QUEUED"
  | "LEASED"
  | "RETRY_WAIT"
  | "RECONCILIATION_REQUIRED"
  | "COMPLETE"
  | "FAILED"
  | "CANCELLED"
  | "OBSOLETE";

export type SchedulerAttemptState =
  | "RUNNING"
  | "SUCCEEDED"
  | "RETRYABLE_FAILURE"
  | "PERMANENT_FAILURE"
  | "MALFORMED"
  | "UNKNOWN_SEND"
  | "RECONCILED_UNSENT"
  | "RECONCILED_ACCEPTED"
  | "RECONCILIATION_UNKNOWN"
  | "OBSOLETE"
  | "CANCELLED";

export interface ClaimedSchedulerJob {
  readonly reviewId: string;
  readonly cycleId: string;
  readonly runId: string;
  readonly direction: WorkerDirection;
  readonly replicaIndex: number;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly workKind: "TURN" | "RECONCILIATION";
  readonly deadlineAtUtc: string;
  readonly attemptDeadlineAtUtc: string;
  readonly lease: FencingToken;
  readonly leaseExpiresAtUtc: string;
}

export interface ClaimSchedulerJobInput {
  readonly ownerFencing: FencingToken;
  readonly nowUtc?: string;
  readonly leaseTtlMs: number;
  readonly attemptTimeoutMs: number;
}

export interface EnsureSchedulerRunsInput {
  readonly cycleId: string;
  readonly backendBinding: SchedulerBackendProfile;
  readonly runs: readonly SchedulerRunInput[];
  readonly ownerFencing: FencingToken;
  readonly nowUtc?: string;
}

export interface SchedulerProvisionalFinding {
  readonly runId: string;
  readonly direction: WorkerDirection;
  readonly replicaIndex: number;
  readonly localId: string;
  readonly finding: WorkerFinding;
}

export interface SchedulerCycleStatus {
  readonly backend: SchedulerBackendKind;
  readonly qualification: SchedulerQualification;
  readonly state:
    | "QUEUED"
    | "RUNNING"
    | "RECONCILIATION_REQUIRED"
    | "AGGREGATING"
    | "COMPLETE"
    | "FAILED"
    | "CANCELLED";
  readonly completedRuns: number;
  readonly requiredRuns: number;
  readonly activeRuns: number;
  readonly retryWaitingRuns: number;
  readonly reconciliationRequiredRuns: number;
  readonly failedRuns: number;
  readonly provisionalFindings: readonly SchedulerProvisionalFinding[];
}

export interface SchedulerSelectedRun {
  readonly runId: string;
  readonly direction: WorkerDirection;
  readonly replicaIndex: number;
  readonly output: ProtocolJsonValue;
}

export interface SchedulerAttemptResultInput {
  readonly runId: string;
  readonly attemptId: string;
  readonly ownerFencing: FencingToken;
  readonly lease: FencingToken;
  readonly outcome:
    | "SUCCESS"
    | "RETRYABLE_FAILURE"
    | "PERMANENT_FAILURE"
    | "MALFORMED"
    | "UNKNOWN_SEND";
  readonly rawArtifact: ArtifactReference;
  readonly sendState?: "UNSENT" | "SENT" | "UNKNOWN";
  readonly receiptArtifact?: ArtifactReference;
  readonly auxiliaryArtifacts?: readonly SchedulerAttemptArtifact[];
  readonly parsedResult?: unknown;
  readonly errorClass?: string;
  readonly retryAtUtc?: string;
  readonly occurredAtUtc?: string;
}

export type SchedulerReconciliationInput =
  | {
      readonly runId: string;
      readonly attemptId: string;
      readonly ownerFencing: FencingToken;
      readonly lease: FencingToken;
      readonly outcome: "PROVEN_UNSENT";
      readonly retryAtUtc?: string;
      readonly occurredAtUtc?: string;
    }
  | {
      readonly runId: string;
      readonly attemptId: string;
      readonly ownerFencing: FencingToken;
      readonly lease: FencingToken;
      readonly outcome: "PROVEN_ACCEPTED_WITH_RESULT";
      readonly rawArtifact: ArtifactReference;
      readonly parsedResult: unknown;
      readonly occurredAtUtc?: string;
    }
  | {
      readonly runId: string;
      readonly attemptId: string;
      readonly ownerFencing: FencingToken;
      readonly lease: FencingToken;
      readonly outcome: "STILL_UNKNOWN";
      readonly retryAtUtc?: string;
      readonly occurredAtUtc?: string;
    };

export interface SchedulerAggregationInput {
  readonly cycleId: string;
  readonly ownerFencing: FencingToken;
  readonly backend: "FAKE";
  readonly qualification: "OFFLINE_ONLY";
  readonly state: "NO_FINDINGS" | "PROVISIONAL_FINDINGS";
  readonly report: ProtocolJsonValue;
  readonly rawArtifact: ArtifactReference;
  readonly occurredAtUtc?: string;
}

export interface CancelSchedulerCycleInput {
  readonly cycleId: string;
  readonly ownerFencing: FencingToken;
  readonly occurredAtUtc?: string;
}

export type DirectionRunStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETE"
  | "FAILED"
  | "OBSOLETE";

export interface FixSubmissionInput {
  readonly callerId: string;
  readonly reviewId: string;
  readonly cycleId: string;
  readonly previousSha: string;
  readonly headSha: string;
  readonly expectedVersion: number;
  readonly resolutions: readonly { findingId: string; note: string }[];
  readonly idempotencyKey: string;
  readonly submittedAtUtc?: string;
}

export interface FixSubmissionResult {
  readonly fixId: string;
  readonly reviewId: string;
  readonly cycleId: string;
  readonly previousSha: string;
  readonly headSha: string;
  readonly state: "VERIFYING_FIX";
  readonly stateVersion: number;
  readonly revisions: ReviewCycleState["revisions"];
}

export interface OutboxRecord {
  readonly outboxSeq: number;
  readonly outboxId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly createdAtUtc: string;
  readonly acknowledgedAtUtc: string | null;
}

export interface FencingToken {
  readonly resourceId: string;
  readonly ownerId: string;
  readonly token: number;
}

export interface LeaseRecord extends FencingToken {
  readonly expiresAtUtc: string;
  readonly updatedAtUtc: string;
}

export interface BackupManifest {
  readonly formatVersion: 1;
  readonly schemaVersion: number;
  readonly database: ArtifactReference & {
    readonly fileName: "database.sqlite";
  };
  readonly artifacts: readonly ArtifactReference[];
}

export interface RecordFindingVerificationInput {
  readonly verificationId: string;
  readonly fixId: string;
  readonly findingId: string;
  readonly status: "FIXED" | "NOT_FIXED" | "REGRESSION" | "UNCERTAIN";
  readonly requiresFreshReview: boolean;
  readonly evidence: readonly string[];
  readonly recordedAtUtc?: string;
}

export interface IdempotencyLookup {
  readonly callerId: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly normalizedPayloadHash?: string;
}

export interface PersistedIdempotencyRecord {
  readonly binding: IdempotencyBinding;
  readonly resultType: string;
  readonly resultId: string;
  readonly result: unknown;
  readonly createdAtUtc: string;
}

export interface RawFindingInput {
  readonly rawFindingId: string;
  readonly resultId: string;
  readonly localId: string;
  readonly payload: unknown;
  readonly createdAtUtc?: string;
}

export interface CanonicalFindingInput {
  readonly findingId: string;
  readonly cycleId: string;
  readonly severity: "critical" | "high" | "medium" | "low";
  readonly validation: "CONFIRMED" | "REJECTED" | "UNCERTAIN";
  readonly blocking: boolean;
  readonly payload: unknown;
  readonly sources: readonly {
    readonly rawFindingId: string;
    readonly directionRunId: string;
    readonly attemptId: string;
    readonly sourceLocalId: string;
  }[];
  readonly createdAtUtc?: string;
}

export interface CanonicalFindingRecord {
  readonly findingId: string;
  readonly cycleId: string;
  readonly severity: CanonicalFindingInput["severity"];
  readonly validation: CanonicalFindingInput["validation"];
  readonly blocking: boolean;
  readonly payload: ProtocolJsonValue;
  readonly sources: CanonicalFindingInput["sources"];
  readonly createdAtUtc: string;
}

export interface AdjudicationDecisionInput {
  readonly decisionId: string;
  readonly cycleId: string;
  readonly findingId: string;
  readonly outcome: "CONFIRMED" | "REJECTED" | "UNCERTAIN";
  readonly rationale: string;
  readonly evidenceDigest: string;
  readonly createdAtUtc?: string;
}

export type ApprovalEvidenceRecord = ApprovalEvidence;
