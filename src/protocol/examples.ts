import { defaultStrictPolicy, strictRuntimeConfigExample } from "./policy";
import type {
  ApprovalEvidence,
  CandidateDisposition,
  CanonicalFinding,
  FixVerificationInput,
  FixVerificationResult,
  IdempotencyBinding,
  ProtocolError,
  ProtocolSchemaName,
  ReviewCancelInput,
  ReviewCancelResult,
  ReviewCycleState,
  ReviewStatusInput,
  ReviewStatusResult,
  ReviewSubmitFixInput,
  ReviewSubmitFixResult,
  ReviewSubmitInput,
  ReviewSubmitResult,
  ReviewTransitionCommand,
  ReviewTransitionResult,
  StrictPolicy,
  StrictRuntimeConfig,
  VersionHashBinding,
  WorkerOutput,
} from "./schemas";

const sha1 = "a".repeat(40);
const sha256 = "b".repeat(64);

export const versionHashBindingExample = {
  protocolVersion: "nr-review/1",
  schemaVersion: "nr-review/1",
  schemaHash: sha256,
  promptVersion: "review-prompt/1",
  promptHash: sha256,
  policyVersion: "strict/1",
  policyHash: sha256,
} satisfies VersionHashBinding;

const revisionPair = {
  objectFormat: "sha1",
  baseSha: sha1,
  headSha: "c".repeat(40),
} as const;

const sourceEvidence = {
  kind: "source",
  path: "src/index.ts",
  revision: { objectFormat: "sha1", sha: revisionPair.headSha },
  startLine: 1,
  endLine: 2,
} as const;

const provenance = {
  runId: "run-1",
  attemptId: "attempt-1",
  localId: "finding-1",
  direction: "correctness",
} as const;

export const canonicalFindingExample = {
  canonicalId: "canonical-1",
  direction: "correctness",
  severity: "low",
  title: "Example finding",
  claim: "This is a deterministic protocol example.",
  evidence: [sourceEvidence],
  blocksApproval: false,
  sources: [provenance],
  validation: "CONFIRMED",
  rationale: "Included to exercise the public finding contract.",
} satisfies CanonicalFinding;

export const approvalEvidenceExample = {
  requiredRuns: [
    {
      runId: "correctness-1",
      direction: "correctness",
      replicaIndex: 1,
      status: "SUCCEEDED",
    },
    {
      runId: "correctness-2",
      direction: "correctness",
      replicaIndex: 2,
      status: "SUCCEEDED",
    },
    {
      runId: "correctness-3",
      direction: "correctness",
      replicaIndex: 3,
      status: "SUCCEEDED",
    },
    {
      runId: "tests-1",
      direction: "tests",
      replicaIndex: 1,
      status: "SUCCEEDED",
    },
    {
      runId: "tests-2",
      direction: "tests",
      replicaIndex: 2,
      status: "SUCCEEDED",
    },
    {
      runId: "tests-3",
      direction: "tests",
      replicaIndex: 3,
      status: "SUCCEEDED",
    },
    {
      runId: "design-1",
      direction: "design",
      replicaIndex: 1,
      status: "SUCCEEDED",
    },
    {
      runId: "design-2",
      direction: "design",
      replicaIndex: 2,
      status: "SUCCEEDED",
    },
    {
      runId: "design-3",
      direction: "design",
      replicaIndex: 3,
      status: "SUCCEEDED",
    },
  ],
  coverageComplete: true,
  allRequiredAdjudicationsResolved: true,
  canonicalValidation: "VALID",
  bindingsValid: true,
  blockingSeverities: [],
} satisfies ApprovalEvidence;

export const reviewCycleStateExample = {
  cycleId: "cycle-1",
  parentCycleId: null,
  cycleNumber: 1,
  repoId: "example/nightreviewer",
  revisions: revisionPair,
  state: "QUEUED",
  stateVersion: 0,
  reviewContextHash: sha256,
  manifestHash: null,
  versionBinding: versionHashBindingExample,
} satisfies ReviewCycleState;

export const validProtocolExamples = {
  protocolError: {
    code: "INTERNAL_ERROR",
    message: "An internal error occurred.",
    retryable: false,
    correlationId: "request-1",
  } satisfies ProtocolError,
  versionHashBinding: versionHashBindingExample,
  approvalEvidence: approvalEvidenceExample,
  reviewSubmitInput: {
    repoId: "example/nightreviewer",
    objectFormat: "sha1",
    baseSha: sha1,
    headSha: revisionPair.headSha,
    task: "Validate the protocol example.",
    acceptanceCriteria: [{ id: "AC1", requirement: "Validate schemas." }],
    profile: "strict/1",
    idempotencyKey: "submit-1",
  } satisfies ReviewSubmitInput,
  reviewSubmitResult: {
    reviewId: "review-1",
    cycleId: "cycle-1",
    revisions: revisionPair,
    state: "QUEUED",
    stateVersion: 0,
    versionBinding: versionHashBindingExample,
  } satisfies ReviewSubmitResult,
  reviewStatusInput: {
    reviewId: "review-1",
  } satisfies ReviewStatusInput,
  reviewStatusResult: {
    reviewId: "review-1",
    cycleId: "cycle-1",
    revisions: revisionPair,
    state: "REVIEWING",
    stateVersion: 2,
    progress: { completedRuns: 0, requiredRuns: 9, activeRuns: 3 },
    findings: [canonicalFindingExample],
    coverage: { complete: true, paths: ["src/index.ts"], limitations: [] },
    nextAction: "WAIT",
    errors: [],
    events: [],
    nextCursor: null,
    versionBinding: versionHashBindingExample,
  } satisfies ReviewStatusResult,
  reviewSubmitFixInput: {
    reviewId: "review-1",
    objectFormat: "sha1",
    previousSha: revisionPair.headSha,
    headSha: "d".repeat(40),
    resolutions: [{ findingId: "canonical-1", note: "Applied the fix." }],
    idempotencyKey: "fix-1",
  } satisfies ReviewSubmitFixInput,
  reviewSubmitFixResult: {
    fixId: "fix-1",
    cycleId: "cycle-1",
    reviewId: "review-1",
    state: "VERIFYING_FIX",
    stateVersion: 4,
    revisions: {
      objectFormat: "sha1",
      baseSha: revisionPair.headSha,
      headSha: "d".repeat(40),
    },
  } satisfies ReviewSubmitFixResult,
  reviewCancelInput: {
    reviewId: "review-1",
    reason: "Operator requested cancellation.",
    idempotencyKey: "cancel-1",
  } satisfies ReviewCancelInput,
  reviewCancelResult: {
    reviewId: "review-1",
    cycleId: "cycle-1",
    state: "CANCEL_REQUESTED",
    stateVersion: 3,
  } satisfies ReviewCancelResult,
  workerOutput: {
    schemaVersion: "nr-review/1",
    reviewId: "review-1",
    cycleId: "cycle-1",
    runId: "run-1",
    attemptId: "attempt-1",
    objectFormat: "sha1",
    reviewedBaseSha: sha1,
    reviewedHeadSha: revisionPair.headSha,
    promptHash: sha256,
    direction: "correctness",
    verdict: "NO_FINDINGS",
    coverage: { complete: true, paths: ["src/index.ts"], limitations: [] },
    findings: [],
  } satisfies WorkerOutput,
  canonicalFinding: canonicalFindingExample,
  candidateDisposition: {
    source: provenance,
    disposition: "REJECTED",
    reason: "The candidate was not confirmed.",
  } satisfies CandidateDisposition,
  fixVerificationInput: {
    schemaVersion: "nr-review/1",
    reviewId: "review-1",
    cycleId: "cycle-1",
    fixId: "fix-1",
    revisions: {
      objectFormat: "sha1",
      baseSha: revisionPair.headSha,
      headSha: "d".repeat(40),
    },
    canonicalFindings: [canonicalFindingExample],
    resolutions: [{ findingId: "canonical-1", note: "Applied the fix." }],
    versionBinding: versionHashBindingExample,
  } satisfies FixVerificationInput,
  fixVerificationResult: {
    schemaVersion: "nr-review/1",
    reviewId: "review-1",
    cycleId: "cycle-1",
    fixId: "fix-1",
    outcomes: [
      {
        findingId: "canonical-1",
        status: "FIXED",
        evidence: [sourceEvidence],
        requiresFreshReview: false,
      },
    ],
    requiresFreshReview: false,
    versionBinding: versionHashBindingExample,
  } satisfies FixVerificationResult,
  reviewCycleState: reviewCycleStateExample,
  reviewTransitionCommand: {
    type: "ADVANCE",
    target: "SNAPSHOTTING",
    expectedVersion: 0,
    idempotencyKey: "advance-1",
  } satisfies ReviewTransitionCommand,
  reviewTransitionResult: {
    ok: true,
    replayed: false,
    state: reviewCycleStateExample,
  } satisfies ReviewTransitionResult,
  strictPolicy: defaultStrictPolicy,
  strictRuntimeConfig: strictRuntimeConfigExample,
  idempotencyBinding: {
    idempotencyKey: "submit-1",
    normalizedPayloadHash: sha256,
  } satisfies IdempotencyBinding,
} satisfies Record<ProtocolSchemaName, unknown>;

function addUnknownAuthorityField(value: unknown): Record<string, unknown> {
  return {
    ...(value as Record<string, unknown>),
    authorityOverride: "reject unknown authority-bearing fields",
  };
}

export const invalidProtocolExamples = Object.fromEntries(
  Object.entries(validProtocolExamples).map(([name, value]) => [
    name,
    addUnknownAuthorityField(value),
  ]),
) as Record<ProtocolSchemaName, Record<string, unknown>>;

export const protocolExampleSha256 = sha256;
export const protocolExampleSha1 = sha1;
export const protocolExamplePolicy = defaultStrictPolicy satisfies StrictPolicy;
export const protocolExampleRuntimeConfig =
  strictRuntimeConfigExample satisfies StrictRuntimeConfig;
