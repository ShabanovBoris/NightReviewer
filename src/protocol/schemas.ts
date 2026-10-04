import Type, { type TProperties, type TSchema } from "typebox";

export const RUNTIME_PROTOCOL_VERSION = "nr-review/1" as const;
export const JSON_SCHEMA_DRAFT_2020_12 =
  "https://json-schema.org/draft/2020-12/schema" as const;

const SCHEMA_URN = "urn:nightreviewer:schema:nr-review-1";

function schemaOptions(name: string, closeProperties = true) {
  return {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: `${SCHEMA_URN}:${name}`,
    title: name,
    ...(closeProperties ? { additionalProperties: false } : {}),
  };
}

function closedObject<const Properties extends TProperties>(
  properties: Properties,
  options: Record<string, unknown> = {},
) {
  return Type.Object(properties, {
    additionalProperties: false,
    ...options,
  });
}

function documentObject<const Properties extends TProperties>(
  name: string,
  properties: Properties,
) {
  return Type.Object(properties, schemaOptions(name));
}

function documentUnion<const Members extends TSchema[]>(
  name: string,
  members: [...Members],
) {
  return Type.Union(members, schemaOptions(name, false));
}

function stringEnum<const Values extends readonly [string, ...string[]]>(
  values: Values,
) {
  return Type.Unsafe<Values[number]>({ type: "string", enum: [...values] });
}

const identifierPattern = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const repoIdPattern = "^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$";
const sha256Pattern = "^[0-9a-f]{64}$";
const sha1Pattern = "^[0-9a-f]{40}$";

export const GitObjectFormatSchema = stringEnum(["sha1", "sha256"] as const);
export type GitObjectFormat = Type.Static<typeof GitObjectFormatSchema>;

export const GitSha1Schema = Type.String({ pattern: sha1Pattern });
export const GitSha256Schema = Type.String({ pattern: sha256Pattern });
export const Sha256Schema = GitSha256Schema;
export const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: identifierPattern,
});

const severityValues = ["critical", "high", "medium", "low"] as const;
export const FindingSeveritySchema = stringEnum(severityValues);
export type FindingSeverity = Type.Static<typeof FindingSeveritySchema>;

export const ReviewStateSchema = stringEnum([
  "QUEUED",
  "SNAPSHOTTING",
  "REVIEWING",
  "AGGREGATING",
  "NEEDS_FIX",
  "VERIFYING_FIX",
  "PAUSED",
  "REQUIRES_FRESH_REVIEW",
  "CANCEL_REQUESTED",
  "APPROVED",
  "FAILED",
  "CANCELLED",
] as const);
export type ReviewState = Type.Static<typeof ReviewStateSchema>;

export const ProtocolErrorCodeSchema = stringEnum([
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "FORBIDDEN",
  "CONFLICT",
  "RESOURCE_EXHAUSTED",
  "BACKEND_UNAVAILABLE",
  "AUTH_REQUIRED",
  "RATE_LIMITED",
  "CONTEXT_TOO_LARGE",
  "SCHEMA_INVALID",
  "NEEDS_RECONCILIATION",
  "INTERNAL_ERROR",
] as const);
export type ProtocolErrorCode = Type.Static<typeof ProtocolErrorCodeSchema>;

export const ProtocolErrorSchema = documentObject("protocol-error", {
  code: ProtocolErrorCodeSchema,
  message: Type.String({ minLength: 1, maxLength: 1024 }),
  retryable: Type.Boolean(),
  retryAfterMs: Type.Optional(
    Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  correlationId: IdentifierSchema,
});
export type ProtocolError = Type.Static<typeof ProtocolErrorSchema>;

export const ValidationIssueSchema = closedObject({
  path: Type.String({ minLength: 1, maxLength: 2048 }),
  classification: Type.String({ minLength: 1, maxLength: 64 }),
  message: Type.String({ minLength: 1, maxLength: 256 }),
});
export type ValidationIssue = Type.Static<typeof ValidationIssueSchema>;

export const VersionHashBindingSchema = documentObject("version-hash-binding", {
  protocolVersion: Type.Literal(RUNTIME_PROTOCOL_VERSION),
  schemaVersion: Type.Literal(RUNTIME_PROTOCOL_VERSION),
  schemaHash: Sha256Schema,
  promptVersion: Type.String({ minLength: 1, maxLength: 128 }),
  promptHash: Sha256Schema,
  policyVersion: Type.String({ minLength: 1, maxLength: 128 }),
  policyHash: Sha256Schema,
});
export type VersionHashBinding = Type.Static<typeof VersionHashBindingSchema>;

export const GitRevisionPairSchema = Type.Union([
  closedObject({
    objectFormat: Type.Literal("sha1"),
    baseSha: GitSha1Schema,
    headSha: GitSha1Schema,
  }),
  closedObject({
    objectFormat: Type.Literal("sha256"),
    baseSha: GitSha256Schema,
    headSha: GitSha256Schema,
  }),
]);
export type GitRevisionPair = Type.Static<typeof GitRevisionPairSchema>;

export const GitRevisionBindingSchema = Type.Union([
  closedObject({ objectFormat: Type.Literal("sha1"), sha: GitSha1Schema }),
  closedObject({
    objectFormat: Type.Literal("sha256"),
    sha: GitSha256Schema,
  }),
]);
export type GitRevisionBinding = Type.Static<typeof GitRevisionBindingSchema>;

const AcceptanceCriterionSchema = closedObject({
  id: IdentifierSchema,
  requirement: Type.String({ minLength: 1, maxLength: 4096 }),
});

const submitCommonProperties = {
  repoId: Type.String({ minLength: 1, maxLength: 255, pattern: repoIdPattern }),
  task: Type.String({ minLength: 1, maxLength: 2048 }),
  acceptanceCriteria: Type.Array(AcceptanceCriterionSchema, {
    minItems: 1,
    maxItems: 100,
  }),
  profile: Type.Literal("strict/1"),
  idempotencyKey: Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[A-Za-z0-9._:-]+$",
  }),
};

export const ReviewSubmitInputSchema = documentUnion("review-submit-input", [
  closedObject({
    ...submitCommonProperties,
    objectFormat: Type.Literal("sha1"),
    baseSha: GitSha1Schema,
    headSha: GitSha1Schema,
  }),
  closedObject({
    ...submitCommonProperties,
    objectFormat: Type.Literal("sha256"),
    baseSha: GitSha256Schema,
    headSha: GitSha256Schema,
  }),
]);
export type ReviewSubmitInput = Type.Static<typeof ReviewSubmitInputSchema>;

export const ReviewSubmitResultSchema = documentObject("review-submit-result", {
  reviewId: IdentifierSchema,
  cycleId: IdentifierSchema,
  revisions: GitRevisionPairSchema,
  state: ReviewStateSchema,
  stateVersion: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  versionBinding: VersionHashBindingSchema,
});
export type ReviewSubmitResult = Type.Static<typeof ReviewSubmitResultSchema>;

export const ReviewStatusInputSchema = documentObject("review-status-input", {
  reviewId: IdentifierSchema,
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
});
export type ReviewStatusInput = Type.Static<typeof ReviewStatusInputSchema>;

export const ReviewNextActionSchema = stringEnum([
  "WAIT",
  "SUBMIT_FIX",
  "VERIFY_FIX",
  "CANCEL",
  "START_FRESH_REVIEW",
  "CONTACT_LEAD",
  "NONE",
] as const);

export const ReviewProgressSchema = closedObject({
  completedRuns: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  requiredRuns: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  activeRuns: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});

export const CoverageSchema = closedObject({
  complete: Type.Boolean(),
  paths: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
    maxItems: 100_000,
  }),
  limitations: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
    maxItems: 1_000,
  }),
});
export type Coverage = Type.Static<typeof CoverageSchema>;

export const ReviewEventSchema = closedObject({
  eventId: IdentifierSchema,
  state: ReviewStateSchema,
  stateVersion: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  occurredAt: Type.String({ minLength: 1, maxLength: 64 }),
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
});
export type ReviewEvent = Type.Static<typeof ReviewEventSchema>;

const FixResolutionSchema = closedObject({
  findingId: IdentifierSchema,
  note: Type.String({ minLength: 1, maxLength: 4096 }),
});

export const ReviewSubmitFixInputSchema = documentUnion(
  "review-submit-fix-input",
  [
    closedObject({
      reviewId: IdentifierSchema,
      objectFormat: Type.Literal("sha1"),
      previousSha: GitSha1Schema,
      headSha: GitSha1Schema,
      resolutions: Type.Array(FixResolutionSchema, {
        minItems: 1,
        maxItems: 1000,
      }),
      idempotencyKey: submitCommonProperties.idempotencyKey,
    }),
    closedObject({
      reviewId: IdentifierSchema,
      objectFormat: Type.Literal("sha256"),
      previousSha: GitSha256Schema,
      headSha: GitSha256Schema,
      resolutions: Type.Array(FixResolutionSchema, {
        minItems: 1,
        maxItems: 1000,
      }),
      idempotencyKey: submitCommonProperties.idempotencyKey,
    }),
  ],
);
export type ReviewSubmitFixInput = Type.Static<
  typeof ReviewSubmitFixInputSchema
>;

export const ReviewSubmitFixResultSchema = documentObject(
  "review-submit-fix-result",
  {
    fixId: IdentifierSchema,
    cycleId: IdentifierSchema,
    reviewId: IdentifierSchema,
    state: ReviewStateSchema,
    stateVersion: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
    revisions: GitRevisionPairSchema,
  },
);
export type ReviewSubmitFixResult = Type.Static<
  typeof ReviewSubmitFixResultSchema
>;

export const ReviewCancelInputSchema = documentObject("review-cancel-input", {
  reviewId: IdentifierSchema,
  reason: Type.String({ minLength: 1, maxLength: 1024 }),
  idempotencyKey: submitCommonProperties.idempotencyKey,
});
export type ReviewCancelInput = Type.Static<typeof ReviewCancelInputSchema>;

export const ReviewCancelResultSchema = documentObject("review-cancel-result", {
  reviewId: IdentifierSchema,
  cycleId: IdentifierSchema,
  state: Type.Union([
    Type.Literal("CANCEL_REQUESTED"),
    Type.Literal("CANCELLED"),
  ]),
  stateVersion: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
export type ReviewCancelResult = Type.Static<typeof ReviewCancelResultSchema>;

export const EvidenceReferenceSchema = Type.Union([
  closedObject({
    kind: Type.Literal("source"),
    path: Type.String({ minLength: 1, maxLength: 2048 }),
    revision: GitRevisionBindingSchema,
    startLine: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    endLine: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  }),
  closedObject({
    kind: Type.Literal("test_artifact"),
    artifactSha256: Sha256Schema,
    artifactSizeBytes: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    }),
  }),
]);
export type EvidenceReference = Type.Static<typeof EvidenceReferenceSchema>;

export const WorkerDirectionSchema = stringEnum([
  "correctness",
  "tests",
  "design",
] as const);
export type WorkerDirection = Type.Static<typeof WorkerDirectionSchema>;

const WorkerFindingSchema = closedObject({
  localId: IdentifierSchema,
  severity: FindingSeveritySchema,
  title: Type.String({ minLength: 1, maxLength: 512 }),
  claim: Type.String({ minLength: 1, maxLength: 8192 }),
  evidence: Type.Array(EvidenceReferenceSchema, { minItems: 1, maxItems: 100 }),
  impact: Type.String({ minLength: 1, maxLength: 4096 }),
  location: Type.String({ minLength: 1, maxLength: 2048 }),
  reproduction: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  suggestedFix: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});
export type WorkerFinding = Type.Static<typeof WorkerFindingSchema>;

export const SchedulerProvisionalFindingSchema = closedObject({
  runId: IdentifierSchema,
  direction: WorkerDirectionSchema,
  replicaIndex: Type.Integer({ minimum: 1, maximum: 3 }),
  localId: IdentifierSchema,
  finding: WorkerFindingSchema,
});

export const SchedulerStatusSchema = closedObject({
  backend: Type.Literal("FAKE"),
  qualification: Type.Literal("OFFLINE_ONLY"),
  state: stringEnum([
    "QUEUED",
    "RUNNING",
    "RECONCILIATION_REQUIRED",
    "AGGREGATING",
    "COMPLETE",
    "FAILED",
    "CANCELLED",
  ] as const),
  retryWaitingRuns: Type.Integer({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  }),
  reconciliationRequiredRuns: Type.Integer({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  }),
  failedRuns: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  provisionalFindings: Type.Array(SchedulerProvisionalFindingSchema, {
    maxItems: 100_000,
  }),
});
export type SchedulerStatus = Type.Static<typeof SchedulerStatusSchema>;

const workerOutputCommon = {
  schemaVersion: Type.Literal(RUNTIME_PROTOCOL_VERSION),
  reviewId: IdentifierSchema,
  cycleId: IdentifierSchema,
  runId: IdentifierSchema,
  attemptId: IdentifierSchema,
  promptHash: Sha256Schema,
  direction: WorkerDirectionSchema,
};

const completeCoverageSchema = closedObject({
  complete: Type.Literal(true),
  paths: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
    maxItems: 100_000,
  }),
  limitations: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
    maxItems: 1_000,
  }),
});

const incompleteCoverageSchema = closedObject({
  complete: Type.Literal(false),
  paths: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
    maxItems: 100_000,
  }),
  limitations: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
    minItems: 1,
    maxItems: 1_000,
  }),
});

function workerOutputMember<
  const Format extends "sha1" | "sha256",
  const Verdict extends "FINDINGS" | "NO_FINDINGS" | "INCOMPLETE",
  ShaSchema extends TSchema,
  CoverageSchemaType extends TSchema,
  FindingsSchema extends TSchema,
>(
  format: Format,
  shaSchema: ShaSchema,
  verdict: Verdict,
  coverage: CoverageSchemaType,
  findings: FindingsSchema,
) {
  return closedObject({
    ...workerOutputCommon,
    objectFormat: Type.Literal(format),
    reviewedBaseSha: shaSchema,
    reviewedHeadSha: shaSchema,
    verdict: Type.Literal(verdict),
    coverage,
    findings,
  });
}

export const WorkerOutputSchema = documentUnion("worker-output", [
  workerOutputMember(
    "sha1",
    GitSha1Schema,
    "FINDINGS",
    completeCoverageSchema,
    Type.Array(WorkerFindingSchema, { minItems: 1, maxItems: 1000 }),
  ),
  workerOutputMember(
    "sha256",
    GitSha256Schema,
    "FINDINGS",
    completeCoverageSchema,
    Type.Array(WorkerFindingSchema, { minItems: 1, maxItems: 1000 }),
  ),
  workerOutputMember(
    "sha1",
    GitSha1Schema,
    "NO_FINDINGS",
    completeCoverageSchema,
    Type.Array(WorkerFindingSchema, { maxItems: 0 }),
  ),
  workerOutputMember(
    "sha256",
    GitSha256Schema,
    "NO_FINDINGS",
    completeCoverageSchema,
    Type.Array(WorkerFindingSchema, { maxItems: 0 }),
  ),
  workerOutputMember(
    "sha1",
    GitSha1Schema,
    "INCOMPLETE",
    incompleteCoverageSchema,
    Type.Array(WorkerFindingSchema, { maxItems: 1000 }),
  ),
  workerOutputMember(
    "sha256",
    GitSha256Schema,
    "INCOMPLETE",
    incompleteCoverageSchema,
    Type.Array(WorkerFindingSchema, { maxItems: 1000 }),
  ),
]);
export type WorkerOutput = Type.Static<typeof WorkerOutputSchema>;

export const CanonicalValidationSchema = stringEnum([
  "CONFIRMED",
  "REJECTED",
  "UNCERTAIN",
] as const);
export type CanonicalValidation = Type.Static<typeof CanonicalValidationSchema>;

export const FindingProvenanceSchema = closedObject({
  runId: IdentifierSchema,
  attemptId: IdentifierSchema,
  localId: IdentifierSchema,
  direction: WorkerDirectionSchema,
});
export type FindingProvenance = Type.Static<typeof FindingProvenanceSchema>;

export const CanonicalFindingSchema = documentObject("canonical-finding", {
  canonicalId: IdentifierSchema,
  direction: WorkerDirectionSchema,
  severity: FindingSeveritySchema,
  title: Type.String({ minLength: 1, maxLength: 512 }),
  claim: Type.String({ minLength: 1, maxLength: 8192 }),
  evidence: Type.Array(EvidenceReferenceSchema, { minItems: 1, maxItems: 100 }),
  blocksApproval: Type.Boolean(),
  sources: Type.Array(FindingProvenanceSchema, { minItems: 1, maxItems: 100 }),
  validation: CanonicalValidationSchema,
  rationale: Type.String({ minLength: 1, maxLength: 4096 }),
});
export type CanonicalFinding = Type.Static<typeof CanonicalFindingSchema>;

export const ReviewStatusResultSchema = documentObject("review-status-result", {
  reviewId: IdentifierSchema,
  cycleId: IdentifierSchema,
  revisions: GitRevisionPairSchema,
  state: ReviewStateSchema,
  stateVersion: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  progress: ReviewProgressSchema,
  scheduler: Type.Optional(SchedulerStatusSchema),
  findings: Type.Array(CanonicalFindingSchema, { maxItems: 100_000 }),
  coverage: CoverageSchema,
  nextAction: ReviewNextActionSchema,
  errors: Type.Array(ProtocolErrorSchema, { maxItems: 100 }),
  events: Type.Array(ReviewEventSchema, { maxItems: 100 }),
  nextCursor: Type.Union([
    Type.String({ minLength: 1, maxLength: 512 }),
    Type.Null(),
  ]),
  versionBinding: VersionHashBindingSchema,
});
export type ReviewStatusResult = Type.Static<typeof ReviewStatusResultSchema>;

export const CandidateDispositionSchema = documentUnion(
  "candidate-disposition",
  [
    closedObject({
      source: FindingProvenanceSchema,
      disposition: Type.Literal("CANONICALIZED"),
      canonicalFindingId: IdentifierSchema,
      reason: Type.String({ minLength: 1, maxLength: 2048 }),
    }),
    closedObject({
      source: FindingProvenanceSchema,
      disposition: Type.Literal("REJECTED"),
      reason: Type.String({ minLength: 1, maxLength: 2048 }),
    }),
    closedObject({
      source: FindingProvenanceSchema,
      disposition: Type.Literal("DUPLICATE"),
      canonicalFindingId: IdentifierSchema,
      reason: Type.String({ minLength: 1, maxLength: 2048 }),
    }),
  ],
);
export type CandidateDisposition = Type.Static<
  typeof CandidateDispositionSchema
>;

export const FixVerificationStatusSchema = stringEnum([
  "FIXED",
  "NOT_FIXED",
  "REGRESSION",
  "UNCERTAIN",
] as const);
export type FixVerificationStatus = Type.Static<
  typeof FixVerificationStatusSchema
>;

const FixVerificationOutcomeSchema = Type.Union([
  closedObject({
    findingId: IdentifierSchema,
    status: Type.Literal("FIXED"),
    evidence: Type.Array(EvidenceReferenceSchema, {
      minItems: 1,
      maxItems: 100,
    }),
    requiresFreshReview: Type.Boolean(),
  }),
  closedObject({
    findingId: IdentifierSchema,
    status: Type.Literal("NOT_FIXED"),
    evidence: Type.Array(EvidenceReferenceSchema, {
      minItems: 1,
      maxItems: 100,
    }),
    requiresFreshReview: Type.Boolean(),
  }),
  closedObject({
    findingId: IdentifierSchema,
    status: Type.Literal("REGRESSION"),
    evidence: Type.Array(EvidenceReferenceSchema, {
      minItems: 1,
      maxItems: 100,
    }),
    regressionFindingId: IdentifierSchema,
    requiresFreshReview: Type.Boolean(),
  }),
  closedObject({
    findingId: IdentifierSchema,
    status: Type.Literal("UNCERTAIN"),
    evidence: Type.Array(EvidenceReferenceSchema, {
      minItems: 1,
      maxItems: 100,
    }),
    requiresFreshReview: Type.Boolean(),
  }),
]);
export type FixVerificationOutcome = Type.Static<
  typeof FixVerificationOutcomeSchema
>;

export const FixVerificationInputSchema = documentObject(
  "fix-verification-input",
  {
    schemaVersion: Type.Literal(RUNTIME_PROTOCOL_VERSION),
    reviewId: IdentifierSchema,
    cycleId: IdentifierSchema,
    fixId: IdentifierSchema,
    revisions: GitRevisionPairSchema,
    canonicalFindings: Type.Array(CanonicalFindingSchema, {
      maxItems: 10_000,
    }),
    resolutions: Type.Array(FixResolutionSchema, {
      minItems: 1,
      maxItems: 1000,
    }),
    versionBinding: VersionHashBindingSchema,
  },
);
export type FixVerificationInput = Type.Static<
  typeof FixVerificationInputSchema
>;

export const FixVerificationResultSchema = documentObject(
  "fix-verification-result",
  {
    schemaVersion: Type.Literal(RUNTIME_PROTOCOL_VERSION),
    reviewId: IdentifierSchema,
    cycleId: IdentifierSchema,
    fixId: IdentifierSchema,
    outcomes: Type.Array(FixVerificationOutcomeSchema, {
      minItems: 1,
      maxItems: 10_000,
    }),
    requiresFreshReview: Type.Boolean(),
    versionBinding: VersionHashBindingSchema,
  },
);
export type FixVerificationResult = Type.Static<
  typeof FixVerificationResultSchema
>;

export const ApprovalRunStatusSchema = stringEnum([
  "SUCCEEDED",
  "FAILED",
  "MISSING",
  "INCOMPLETE",
  "UNCERTAIN",
] as const);

export const ApprovalEvidenceSchema = documentObject("approval-evidence", {
  requiredRuns: Type.Array(
    closedObject({
      runId: IdentifierSchema,
      direction: WorkerDirectionSchema,
      replicaIndex: Type.Integer({ minimum: 1, maximum: 3 }),
      status: ApprovalRunStatusSchema,
    }),
    { minItems: 9, maxItems: 9 },
  ),
  coverageComplete: Type.Boolean(),
  allRequiredAdjudicationsResolved: Type.Boolean(),
  canonicalValidation: stringEnum(["VALID", "UNCERTAIN"] as const),
  bindingsValid: Type.Boolean(),
  blockingSeverities: Type.Array(FindingSeveritySchema, { maxItems: 10_000 }),
  fixOutcomes: Type.Optional(
    Type.Array(FixVerificationOutcomeSchema, { maxItems: 10_000 }),
  ),
});
export type ApprovalEvidence = Type.Static<typeof ApprovalEvidenceSchema>;

const requiredFindingIdsSchema = Type.Array(IdentifierSchema, {
  minItems: 1,
  maxItems: 10_000,
  uniqueItems: true,
});

export const PauseReasonSchema = closedObject({
  code: stringEnum([
    "BLOCKED",
    "NEEDS_RECONCILIATION",
    "RATE_LIMITED",
    "CONTEXT_REQUIRED",
    "EXTERNAL_DEPENDENCY",
    "USER_REQUEST",
  ] as const),
  message: Type.String({ minLength: 1, maxLength: 1024 }),
});
export type PauseReason = Type.Static<typeof PauseReasonSchema>;

const cycleBaseProperties = {
  cycleId: IdentifierSchema,
  parentCycleId: Type.Union([IdentifierSchema, Type.Null()]),
  cycleNumber: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  repoId: Type.String({ minLength: 1, maxLength: 255, pattern: repoIdPattern }),
  revisions: GitRevisionPairSchema,
  stateVersion: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  reviewContextHash: Sha256Schema,
  manifestHash: Type.Union([Sha256Schema, Type.Null()]),
  versionBinding: VersionHashBindingSchema,
};

const freshChildSeedSchema = closedObject({
  cycleId: IdentifierSchema,
  repoId: Type.String({ minLength: 1, maxLength: 255, pattern: repoIdPattern }),
  revisions: GitRevisionPairSchema,
  reviewContextHash: Sha256Schema,
  versionBinding: VersionHashBindingSchema,
});

const idempotencyReceiptSchema = closedObject({
  idempotencyKey: submitCommonProperties.idempotencyKey,
  normalizedPayloadHash: Sha256Schema,
});

const lastCommandProperty = {
  lastCommand: Type.Optional(idempotencyReceiptSchema),
};

const freshCycleCommandProperty = {
  lastCommand: Type.Optional(
    closedObject({
      idempotencyKey: submitCommonProperties.idempotencyKey,
      normalizedPayloadHash: Sha256Schema,
      freshChild: Type.Optional(freshChildSeedSchema),
    }),
  ),
};

function activeCycleStateSchema<
  const State extends "QUEUED" | "SNAPSHOTTING" | "REVIEWING" | "AGGREGATING",
>(state: State) {
  return closedObject({
    ...cycleBaseProperties,
    state: Type.Literal(state),
    ...lastCommandProperty,
  });
}

function fixCycleStateSchema<const State extends "NEEDS_FIX" | "VERIFYING_FIX">(
  state: State,
) {
  return closedObject({
    ...cycleBaseProperties,
    state: Type.Literal(state),
    requiredFindingIds: requiredFindingIdsSchema,
    ...lastCommandProperty,
  });
}

export const ReviewCycleStateSchema = documentUnion("review-cycle-state", [
  activeCycleStateSchema("QUEUED"),
  activeCycleStateSchema("SNAPSHOTTING"),
  activeCycleStateSchema("REVIEWING"),
  activeCycleStateSchema("AGGREGATING"),
  fixCycleStateSchema("NEEDS_FIX"),
  fixCycleStateSchema("VERIFYING_FIX"),
  closedObject({
    ...cycleBaseProperties,
    state: Type.Literal("REQUIRES_FRESH_REVIEW"),
    ...freshCycleCommandProperty,
  }),
  closedObject({
    ...cycleBaseProperties,
    state: Type.Literal("CANCEL_REQUESTED"),
    cancelReason: Type.String({ minLength: 1, maxLength: 1024 }),
    ...lastCommandProperty,
  }),
  closedObject({
    ...cycleBaseProperties,
    state: Type.Literal("PAUSED"),
    pauseInfo: closedObject({
      reason: PauseReasonSchema,
      resumeStage: stringEnum(["REVIEWING", "AGGREGATING"] as const),
    }),
    ...lastCommandProperty,
  }),
  closedObject({
    ...cycleBaseProperties,
    state: Type.Literal("PAUSED"),
    requiredFindingIds: requiredFindingIdsSchema,
    pauseInfo: closedObject({
      reason: PauseReasonSchema,
      resumeStage: Type.Literal("VERIFYING_FIX"),
    }),
    ...lastCommandProperty,
  }),
  closedObject({
    ...cycleBaseProperties,
    state: Type.Literal("APPROVED"),
    approvalReceipt: closedObject({
      revisions: GitRevisionPairSchema,
      manifestHash: Sha256Schema,
      policyVersion: Type.String({ minLength: 1, maxLength: 128 }),
      policyHash: Sha256Schema,
      evidenceDigest: Sha256Schema,
      approvedAt: Type.String({ minLength: 1, maxLength: 64 }),
    }),
    terminalReceipt: closedObject({
      idempotencyKey: submitCommonProperties.idempotencyKey,
      normalizedPayloadHash: Sha256Schema,
    }),
  }),
  closedObject({
    ...cycleBaseProperties,
    state: Type.Literal("FAILED"),
    failureCode: ProtocolErrorCodeSchema,
    terminalReceipt: closedObject({
      idempotencyKey: submitCommonProperties.idempotencyKey,
      normalizedPayloadHash: Sha256Schema,
    }),
  }),
  closedObject({
    ...cycleBaseProperties,
    state: Type.Literal("CANCELLED"),
    cancelReason: Type.String({ minLength: 1, maxLength: 1024 }),
    terminalReceipt: closedObject({
      idempotencyKey: submitCommonProperties.idempotencyKey,
      normalizedPayloadHash: Sha256Schema,
    }),
  }),
]);
export type ReviewCycleState = Type.Static<typeof ReviewCycleStateSchema>;

const transitionEvidenceSchema = closedObject({
  durableManifestRecorded: Type.Optional(Type.Boolean()),
  allRequiredRunsSucceeded: Type.Optional(Type.Boolean()),
  allAdjudicationsComplete: Type.Optional(Type.Boolean()),
  hasBlockingFindings: Type.Optional(Type.Boolean()),
  requiredFindingIds: Type.Optional(requiredFindingIdsSchema),
  fixOutcomes: Type.Optional(
    Type.Array(FixVerificationOutcomeSchema, {
      minItems: 1,
      maxItems: 10_000,
    }),
  ),
  atomicFixSubmissionValidated: Type.Optional(Type.Boolean()),
  fixRevisions: Type.Optional(GitRevisionPairSchema),
  freshReviewRequired: Type.Optional(Type.Boolean()),
  failureCode: Type.Optional(ProtocolErrorCodeSchema),
  approval: Type.Optional(ApprovalEvidenceSchema),
  manifestHash: Type.Optional(Sha256Schema),
  approvedAt: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
});

const transitionCommandBase = {
  expectedVersion: Type.Integer({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  }),
  idempotencyKey: submitCommonProperties.idempotencyKey,
};

export const ReviewTransitionCommandSchema = documentUnion(
  "review-transition-command",
  [
    closedObject({
      ...transitionCommandBase,
      type: Type.Literal("ADVANCE"),
      target: ReviewStateSchema,
      evidence: Type.Optional(transitionEvidenceSchema),
    }),
    closedObject({
      ...transitionCommandBase,
      type: Type.Literal("PAUSE"),
      reason: PauseReasonSchema,
    }),
    closedObject({
      ...transitionCommandBase,
      type: Type.Literal("RESUME"),
      reasonCleared: Type.Literal(true),
    }),
    closedObject({
      ...transitionCommandBase,
      type: Type.Literal("REQUEST_CANCEL"),
      reason: Type.String({ minLength: 1, maxLength: 1024 }),
    }),
    closedObject({
      ...transitionCommandBase,
      type: Type.Literal("CONFIRM_CANCEL"),
      fencingAndRevocationConfirmed: Type.Literal(true),
    }),
    closedObject({
      ...transitionCommandBase,
      type: Type.Literal("CREATE_FRESH_CYCLE"),
      childCycleId: IdentifierSchema,
      childRepoId: Type.String({
        minLength: 1,
        maxLength: 255,
        pattern: repoIdPattern,
      }),
      childRevisions: GitRevisionPairSchema,
      childReviewContextHash: Sha256Schema,
      childVersionBinding: VersionHashBindingSchema,
    }),
  ],
);
export type ReviewTransitionCommand = Type.Static<
  typeof ReviewTransitionCommandSchema
>;

export const ReviewTransitionResultSchema = documentUnion(
  "review-transition-result",
  [
    closedObject({
      ok: Type.Literal(true),
      replayed: Type.Boolean(),
      state: ReviewCycleStateSchema,
      childCycle: Type.Optional(ReviewCycleStateSchema),
    }),
    closedObject({
      ok: Type.Literal(false),
      error: ProtocolErrorSchema,
      state: Type.Optional(ReviewCycleStateSchema),
    }),
  ],
);
export type ReviewTransitionResult = Type.Static<
  typeof ReviewTransitionResultSchema
>;

export const StrictPolicySchema = documentObject("strict-policy", {
  policyVersion: Type.Literal("strict/1"),
  directions: Type.Array(WorkerDirectionSchema, {
    minItems: 3,
    maxItems: 3,
    uniqueItems: true,
  }),
  replicasPerDirection: Type.Literal(3),
  globalWorkerAndAdjudicatorConcurrency: Type.Literal(3),
  blockingSeverities: Type.Array(
    stringEnum(["critical", "high", "medium"] as const),
    { minItems: 3, maxItems: 3, uniqueItems: true },
  ),
  lowSeverityBlocksApproval: Type.Literal(false),
  schemaRepairAttempts: Type.Literal(1),
  failClosedOnUnknownCoverage: Type.Literal(true),
  failClosedOnUnresolvedValidation: Type.Literal(true),
  failClosedOnMalformedMandatoryWork: Type.Literal(true),
  quotas: closedObject({
    maxOpenReviews: Type.Integer({ minimum: 1, maximum: 100 }),
    maxRunsPerCycle: Type.Integer({ minimum: 1, maximum: 100 }),
    maxWorkerAttemptsPerRun: Type.Integer({ minimum: 1, maximum: 10 }),
    maxModelRequestsPerRun: Type.Integer({ minimum: 1, maximum: 20 }),
    maxFixRounds: Type.Integer({ minimum: 1, maximum: 10 }),
    maxFindingsPerRun: Type.Integer({ minimum: 1, maximum: 10_000 }),
    maxEvidencePerFinding: Type.Integer({ minimum: 1, maximum: 1_000 }),
    maxFilesPerSnapshot: Type.Integer({ minimum: 1, maximum: 100_000 }),
    maxFileBytes: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
    maxContextBytes: Type.Integer({ minimum: 1, maximum: 1_000_000_000 }),
    maxEventsPerPage: Type.Integer({ minimum: 1, maximum: 10_000 }),
  }),
  deadlinesMs: closedObject({
    review: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
    worker: Type.Integer({ minimum: 1, maximum: 3_600_000 }),
    adjudicator: Type.Integer({ minimum: 1, maximum: 3_600_000 }),
    fixVerification: Type.Integer({ minimum: 1, maximum: 3_600_000 }),
    cancellationFence: Type.Integer({ minimum: 1, maximum: 60_000 }),
  }),
});
export type StrictPolicy = Type.Static<typeof StrictPolicySchema>;

const RepositoryConfigSchema = closedObject({
  remote: Type.String({ minLength: 1, maxLength: 2048 }),
  objectFormat: GitObjectFormatSchema,
  targetBranch: Type.String({ minLength: 1, maxLength: 255 }),
});

const RepositoryConfigMapSchema = Type.Record(
  Type.String({ minLength: 1, maxLength: 255, pattern: repoIdPattern }),
  RepositoryConfigSchema,
  { additionalProperties: false, minProperties: 1, maxProperties: 1000 },
);

export const StrictRuntimeConfigSchema = documentObject(
  "strict-runtime-config",
  {
    schemaVersion: Type.Literal(RUNTIME_PROTOCOL_VERSION),
    defaultProfile: Type.Literal("strict/1"),
    repositories: RepositoryConfigMapSchema,
    policy: StrictPolicySchema,
  },
);
export type StrictRuntimeConfig = Type.Static<typeof StrictRuntimeConfigSchema>;

export const IdempotencyBindingSchema = documentObject("idempotency-binding", {
  idempotencyKey: submitCommonProperties.idempotencyKey,
  normalizedPayloadHash: Sha256Schema,
});
export type IdempotencyBinding = Type.Static<typeof IdempotencyBindingSchema>;

export const protocolSchemas = {
  protocolError: ProtocolErrorSchema,
  versionHashBinding: VersionHashBindingSchema,
  reviewSubmitInput: ReviewSubmitInputSchema,
  reviewSubmitResult: ReviewSubmitResultSchema,
  reviewStatusInput: ReviewStatusInputSchema,
  reviewStatusResult: ReviewStatusResultSchema,
  reviewSubmitFixInput: ReviewSubmitFixInputSchema,
  reviewSubmitFixResult: ReviewSubmitFixResultSchema,
  reviewCancelInput: ReviewCancelInputSchema,
  reviewCancelResult: ReviewCancelResultSchema,
  workerOutput: WorkerOutputSchema,
  canonicalFinding: CanonicalFindingSchema,
  candidateDisposition: CandidateDispositionSchema,
  approvalEvidence: ApprovalEvidenceSchema,
  fixVerificationInput: FixVerificationInputSchema,
  fixVerificationResult: FixVerificationResultSchema,
  reviewCycleState: ReviewCycleStateSchema,
  reviewTransitionCommand: ReviewTransitionCommandSchema,
  reviewTransitionResult: ReviewTransitionResultSchema,
  strictPolicy: StrictPolicySchema,
  strictRuntimeConfig: StrictRuntimeConfigSchema,
  idempotencyBinding: IdempotencyBindingSchema,
} as const;

export type ProtocolSchemaName = keyof typeof protocolSchemas;
export type ProtocolValueBySchema = {
  protocolError: ProtocolError;
  versionHashBinding: VersionHashBinding;
  reviewSubmitInput: ReviewSubmitInput;
  reviewSubmitResult: ReviewSubmitResult;
  reviewStatusInput: ReviewStatusInput;
  reviewStatusResult: ReviewStatusResult;
  reviewSubmitFixInput: ReviewSubmitFixInput;
  reviewSubmitFixResult: ReviewSubmitFixResult;
  reviewCancelInput: ReviewCancelInput;
  reviewCancelResult: ReviewCancelResult;
  workerOutput: WorkerOutput;
  canonicalFinding: CanonicalFinding;
  candidateDisposition: CandidateDisposition;
  approvalEvidence: ApprovalEvidence;
  fixVerificationInput: FixVerificationInput;
  fixVerificationResult: FixVerificationResult;
  reviewCycleState: ReviewCycleState;
  reviewTransitionCommand: ReviewTransitionCommand;
  reviewTransitionResult: ReviewTransitionResult;
  strictPolicy: StrictPolicy;
  strictRuntimeConfig: StrictRuntimeConfig;
  idempotencyBinding: IdempotencyBinding;
};
