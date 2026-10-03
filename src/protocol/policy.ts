import type {
  ApprovalEvidence,
  StrictPolicy,
  StrictRuntimeConfig,
} from "./schemas";
import { validateProtocolValue } from "./validation";

const strictPolicyDefaults = {
  policyVersion: "strict/1",
  directions: ["correctness", "tests", "design"],
  replicasPerDirection: 3,
  globalWorkerAndAdjudicatorConcurrency: 3,
  blockingSeverities: ["critical", "high", "medium"],
  lowSeverityBlocksApproval: false,
  schemaRepairAttempts: 1,
  failClosedOnUnknownCoverage: true,
  failClosedOnUnresolvedValidation: true,
  failClosedOnMalformedMandatoryWork: true,
  quotas: {
    maxOpenReviews: 12,
    maxRunsPerCycle: 36,
    maxWorkerAttemptsPerRun: 2,
    maxModelRequestsPerRun: 3,
    maxFixRounds: 3,
    maxFindingsPerRun: 100,
    maxEvidencePerFinding: 20,
    maxFilesPerSnapshot: 10_000,
    maxFileBytes: 1_048_576,
    maxContextBytes: 10_485_760,
    maxEventsPerPage: 100,
  },
  deadlinesMs: {
    review: 900_000,
    worker: 180_000,
    adjudicator: 180_000,
    fixVerification: 600_000,
    cancellationFence: 10_000,
  },
} satisfies StrictPolicy;

Object.freeze(strictPolicyDefaults.directions);
Object.freeze(strictPolicyDefaults.blockingSeverities);
Object.freeze(strictPolicyDefaults.quotas);
Object.freeze(strictPolicyDefaults.deadlinesMs);

export const defaultStrictPolicy = Object.freeze(strictPolicyDefaults);

export const strictRuntimeConfigExample = {
  schemaVersion: "nr-review/1",
  defaultProfile: "strict/1",
  repositories: {
    "example/nightreviewer": {
      remote: "https://github.com/example/nightreviewer",
      objectFormat: "sha1",
      targetBranch: "main",
    },
  },
  policy: defaultStrictPolicy,
} satisfies StrictRuntimeConfig;

export type ApprovalGuardReason =
  | "INVALID_APPROVAL_EVIDENCE"
  | "MISSING_REQUIRED_RUN"
  | "REQUIRED_RUN_FAILED"
  | "COVERAGE_INCOMPLETE"
  | "ADJUDICATION_INCOMPLETE"
  | "VALIDATION_UNCERTAIN"
  | "VERSION_BINDING_INVALID"
  | "BLOCKING_FINDING_PRESENT"
  | "FIX_VERIFICATION_INCOMPLETE";

export interface ApprovalGuardResult {
  readonly approved: boolean;
  readonly reasons: readonly ApprovalGuardReason[];
}

/** Fails closed unless every required run, adjudication, binding, and blocker check passes. */
export function evaluateApprovalEvidence(
  evidence: unknown,
): ApprovalGuardResult {
  const validation = validateProtocolValue("approvalEvidence", evidence);
  if (!validation.ok) {
    return { approved: false, reasons: ["INVALID_APPROVAL_EVIDENCE"] };
  }
  return evaluateValidatedApprovalEvidence(validation.value);
}

export function evaluateValidatedApprovalEvidence(
  evidence: ApprovalEvidence,
): ApprovalGuardResult {
  const reasons: ApprovalGuardReason[] = [];
  const requiredRunCount =
    defaultStrictPolicy.directions.length *
    defaultStrictPolicy.replicasPerDirection;
  const requiredRunSlots = new Set(
    evidence.requiredRuns.map((run) => `${run.direction}:${run.replicaIndex}`),
  );
  const requiredRunIds = new Set(evidence.requiredRuns.map((run) => run.runId));
  if (
    evidence.requiredRuns.length !== requiredRunCount ||
    requiredRunSlots.size !== requiredRunCount ||
    requiredRunIds.size !== requiredRunCount
  ) {
    reasons.push("MISSING_REQUIRED_RUN");
  }
  if (evidence.requiredRuns.some((run) => run.status !== "SUCCEEDED")) {
    reasons.push("REQUIRED_RUN_FAILED");
  }
  if (!evidence.coverageComplete) reasons.push("COVERAGE_INCOMPLETE");
  if (!evidence.allRequiredAdjudicationsResolved) {
    reasons.push("ADJUDICATION_INCOMPLETE");
  }
  if (evidence.canonicalValidation !== "VALID") {
    reasons.push("VALIDATION_UNCERTAIN");
  }
  if (!evidence.bindingsValid) reasons.push("VERSION_BINDING_INVALID");
  const blockingSeverities = new Set<string>(
    defaultStrictPolicy.blockingSeverities,
  );
  if (
    evidence.blockingSeverities.some((severity) =>
      blockingSeverities.has(severity),
    )
  ) {
    reasons.push("BLOCKING_FINDING_PRESENT");
  }
  if (
    evidence.fixOutcomes !== undefined &&
    (evidence.fixOutcomes.length === 0 ||
      evidence.fixOutcomes.some(
        (outcome) => outcome.status !== "FIXED" || outcome.requiresFreshReview,
      ))
  ) {
    reasons.push("FIX_VERIFICATION_INCOMPLETE");
  }
  return { approved: reasons.length === 0, reasons };
}
