import type {
  ApprovalEvidence,
  IdempotencyBinding,
  ProtocolJsonValue,
  ReviewCycleState,
  ReviewSubmitInput,
  VersionHashBinding,
  WorkerDirection,
} from "../protocol";

export const STORAGE_SCHEMA_VERSION = 2;

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
