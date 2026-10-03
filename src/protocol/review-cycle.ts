import { hashCanonicalJson } from "./canonical";
import {
  compareIdempotencyBindings,
  createIdempotencyBinding,
} from "./idempotency";
import { evaluateApprovalEvidence } from "./policy";
import type {
  ApprovalEvidence,
  FixVerificationOutcome,
  IdempotencyBinding,
  ProtocolError,
  ReviewCycleState,
  ReviewState,
  ReviewTransitionCommand,
  ReviewTransitionResult,
} from "./schemas";
import { validateProtocolValue } from "./validation";

export const allowedReviewStateTransitions = {
  QUEUED: ["SNAPSHOTTING", "CANCEL_REQUESTED", "FAILED"],
  SNAPSHOTTING: ["REVIEWING", "FAILED", "CANCEL_REQUESTED"],
  REVIEWING: ["AGGREGATING", "PAUSED", "FAILED", "CANCEL_REQUESTED"],
  AGGREGATING: [
    "APPROVED",
    "NEEDS_FIX",
    "PAUSED",
    "FAILED",
    "CANCEL_REQUESTED",
  ],
  NEEDS_FIX: ["VERIFYING_FIX", "CANCEL_REQUESTED"],
  VERIFYING_FIX: [
    "APPROVED",
    "NEEDS_FIX",
    "REQUIRES_FRESH_REVIEW",
    "PAUSED",
    "FAILED",
    "CANCEL_REQUESTED",
  ],
  PAUSED: [
    "REVIEWING",
    "AGGREGATING",
    "VERIFYING_FIX",
    "FAILED",
    "CANCEL_REQUESTED",
  ],
  REQUIRES_FRESH_REVIEW: [],
  CANCEL_REQUESTED: ["CANCELLED"],
  APPROVED: [],
  FAILED: [],
  CANCELLED: [],
} as const satisfies Record<ReviewState, readonly ReviewState[]>;

type InitialReviewCycleFields = Pick<
  ReviewCycleState,
  "cycleId" | "repoId" | "revisions" | "reviewContextHash" | "versionBinding"
>;

export function createInitialReviewCycle(
  fields: InitialReviewCycleFields,
): ReviewCycleState {
  const validation = validateProtocolValue("reviewCycleState", {
    ...fields,
    parentCycleId: null,
    cycleNumber: 1,
    state: "QUEUED",
    stateVersion: 0,
    manifestHash: null,
  });
  if (!validation.ok) {
    throw new TypeError(
      "Initial review cycle fields do not satisfy the protocol schema.",
    );
  }
  return validation.value;
}

/** Applies one optimistic, side-effect-free transition to a validated cycle snapshot. */
export function transitionReviewCycle(
  currentInput: unknown,
  commandInput: unknown,
): ReviewTransitionResult {
  const currentValidation = validateProtocolValue(
    "reviewCycleState",
    currentInput,
  );
  if (!currentValidation.ok) {
    return failure(
      protocolError(
        "SCHEMA_INVALID",
        "Current review state is malformed.",
        "review-cycle",
      ),
    );
  }
  const current = currentValidation.value;
  if (
    "requiredFindingIds" in current &&
    !hasCanonicalRequiredFindingIds(current.requiredFindingIds)
  ) {
    return failure(
      protocolError(
        "SCHEMA_INVALID",
        "Cycle required finding IDs are not in canonical ASCII order.",
        current.cycleId,
      ),
      current,
    );
  }

  const commandValidation = validateProtocolValue(
    "reviewTransitionCommand",
    commandInput,
  );
  if (!commandValidation.ok) {
    return failure(
      protocolError(
        "SCHEMA_INVALID",
        "Transition command is malformed.",
        current.cycleId,
      ),
      current,
    );
  }
  const command = commandValidation.value;

  const binding = createIdempotencyBinding(
    command.idempotencyKey,
    commandPayload(command),
    current.cycleId,
  );
  if (!binding.ok) return failure(binding.error, current);

  const previousBinding = lastAppliedBinding(current);
  const idempotency = compareIdempotencyBindings(
    previousBinding,
    binding.binding,
    current.cycleId,
  );
  if (idempotency.kind === "REPLAY") {
    if (command.type === "CREATE_FRESH_CYCLE") {
      const childCycle = replayedFreshCycle(current, command);
      if (childCycle === undefined) {
        return failure(
          protocolError(
            "NEEDS_RECONCILIATION",
            "The stored fresh-cycle replay record is incomplete.",
            current.cycleId,
          ),
          current,
        );
      }
      return success(current, true, childCycle);
    }
    return success(current, true);
  }
  if (idempotency.kind === "CONFLICT") {
    return failure(idempotency.error, current);
  }

  if (isTerminal(current.state)) {
    return failure(
      protocolError(
        "CONFLICT",
        "Terminal review cycles cannot be changed.",
        current.cycleId,
      ),
      current,
    );
  }
  if (command.expectedVersion !== current.stateVersion) {
    return failure(
      protocolError(
        "CONFLICT",
        "Review state version does not match.",
        current.cycleId,
      ),
      current,
    );
  }
  if (current.stateVersion >= Number.MAX_SAFE_INTEGER) {
    return failure(
      protocolError(
        "RESOURCE_EXHAUSTED",
        "Review state version limit reached.",
        current.cycleId,
      ),
      current,
    );
  }

  switch (command.type) {
    case "ADVANCE":
      return advance(current, command, binding.binding);
    case "PAUSE":
      return pause(current, command, binding.binding);
    case "RESUME":
      return resume(current, command, binding.binding);
    case "REQUEST_CANCEL":
      return requestCancel(current, command, binding.binding);
    case "CONFIRM_CANCEL":
      return confirmCancel(current, command, binding.binding);
    case "CREATE_FRESH_CYCLE":
      return createFreshCycle(current, command, binding.binding);
  }
}

function advance(
  current: ReviewCycleState,
  command: Extract<ReviewTransitionCommand, { type: "ADVANCE" }>,
  binding: IdempotencyBinding,
): ReviewTransitionResult {
  const target = command.target;
  if (
    target === "PAUSED" ||
    target === "CANCEL_REQUESTED" ||
    target === "CANCELLED"
  ) {
    return transitionRejected(
      current,
      "Transition requires its guarded command.",
    );
  }
  if (current.state === "PAUSED" && target !== "FAILED") {
    return transitionRejected(
      current,
      "Paused reviews must resume through the guarded command.",
    );
  }
  if (!isAllowed(current.state, target)) {
    return transitionRejected(
      current,
      "Review state transition is not allowed.",
    );
  }

  const evidence = command.evidence;
  let nextManifestHash = current.manifestHash;
  let nextRequiredFindingIds: string[] | undefined;
  if (target === "REVIEWING") {
    if (
      evidence?.durableManifestRecorded !== true ||
      evidence.manifestHash === undefined
    ) {
      return transitionRejected(
        current,
        "A durable snapshot manifest is required.",
      );
    }
    nextManifestHash = evidence.manifestHash;
  }
  if (target === "AGGREGATING" && evidence?.allRequiredRunsSucceeded !== true) {
    return transitionRejected(
      current,
      "All required worker runs must succeed.",
    );
  }
  if (
    target === "NEEDS_FIX" &&
    (evidence?.allAdjudicationsComplete !== true ||
      evidence.hasBlockingFindings !== true)
  ) {
    return transitionRejected(
      current,
      "A fix cycle requires complete adjudication and a confirmed blocker.",
    );
  }
  if (target === "NEEDS_FIX") {
    if (current.state === "AGGREGATING") {
      if (
        evidence === undefined ||
        evidence.requiredFindingIds === undefined ||
        evidence.fixOutcomes !== undefined
      ) {
        return transitionRejected(
          current,
          "A new fix cycle requires the adjudicated finding ID set, not fix outcomes.",
        );
      }
      nextRequiredFindingIds = sortUniqueFindingIds(
        evidence.requiredFindingIds,
      );
    } else if (current.state === "VERIFYING_FIX") {
      const outcomes = evidence?.fixOutcomes;
      if (
        evidence?.requiredFindingIds !== undefined ||
        !hasCompleteFixOutcomeSet(current.requiredFindingIds, outcomes)
      ) {
        return transitionRejected(
          current,
          "A subsequent fix cycle requires one result for every authoritative finding ID.",
        );
      }
      if (outcomes.some((outcome) => outcome.requiresFreshReview)) {
        return transitionRejected(
          current,
          "A fix result requiring fresh review cannot change the current finding set.",
        );
      }
      nextRequiredFindingIds = sortUniqueFindingIds([
        ...current.requiredFindingIds,
        ...outcomes.flatMap((outcome) =>
          outcome.status === "REGRESSION" ? [outcome.regressionFindingId] : [],
        ),
      ]);
    } else {
      return transitionRejected(
        current,
        "A fix cycle can only start from adjudication or continue from fix verification.",
      );
    }
  } else if (
    evidence?.requiredFindingIds !== undefined ||
    evidence?.fixOutcomes !== undefined
  ) {
    return transitionRejected(
      current,
      "Finding-set evidence is only valid when entering NEEDS_FIX.",
    );
  }
  if (
    target === "VERIFYING_FIX" &&
    evidence?.atomicFixSubmissionValidated !== true
  ) {
    return transitionRejected(
      current,
      "Fix submission must be atomically validated.",
    );
  }
  if (target === "VERIFYING_FIX") {
    if (current.state !== "NEEDS_FIX") {
      return transitionRejected(
        current,
        "Fix verification requires a cycle with an authoritative finding set.",
      );
    }
    nextRequiredFindingIds = [...current.requiredFindingIds];
  }
  if (
    target === "REQUIRES_FRESH_REVIEW" &&
    evidence?.freshReviewRequired !== true
  ) {
    return transitionRejected(
      current,
      "A fresh review requires an explicit scope decision.",
    );
  }
  if (target === "FAILED" && evidence?.failureCode === undefined) {
    return transitionRejected(
      current,
      "Failure transitions require a typed failure code.",
    );
  }

  const nextVersion = current.stateVersion + 1;
  if (target === "APPROVED") {
    if (
      evidence?.approval === undefined ||
      evidence.approvedAt === undefined ||
      current.manifestHash === null
    ) {
      return approvalRejected(current);
    }
    const approval = evaluateApprovalEvidence(evidence.approval);
    if (
      !approval.approved ||
      (current.state === "VERIFYING_FIX" &&
        !hasCompleteFixApprovalEvidence(
          current.requiredFindingIds,
          evidence.approval,
        )) ||
      !isUtcTimestamp(evidence.approvedAt)
    ) {
      return approvalRejected(current);
    }
    let evidenceDigest: string;
    try {
      evidenceDigest = hashCanonicalJson(evidence.approval);
    } catch {
      return approvalRejected(current);
    }
    const approvalReceipt = {
      revisions: current.revisions,
      manifestHash: current.manifestHash,
      policyVersion: current.versionBinding.policyVersion,
      policyHash: current.versionBinding.policyHash,
      evidenceDigest,
      approvedAt: evidence.approvedAt,
    };
    return finishState({
      ...cycleFields(current),
      state: "APPROVED",
      stateVersion: nextVersion,
      manifestHash: nextManifestHash,
      approvalReceipt,
      terminalReceipt: binding,
    });
  }

  if (target === "FAILED") {
    return finishState({
      ...cycleFields(current),
      state: "FAILED",
      stateVersion: nextVersion,
      manifestHash: nextManifestHash,
      failureCode: evidence?.failureCode,
      terminalReceipt: binding,
    });
  }

  return finishState({
    ...cycleFields(current),
    ...(nextRequiredFindingIds === undefined
      ? {}
      : { requiredFindingIds: nextRequiredFindingIds }),
    state: target,
    stateVersion: nextVersion,
    manifestHash: nextManifestHash,
    lastCommand: binding,
  });
}

function pause(
  current: ReviewCycleState,
  command: Extract<ReviewTransitionCommand, { type: "PAUSE" }>,
  binding: IdempotencyBinding,
): ReviewTransitionResult {
  if (!isAllowed(current.state, "PAUSED")) {
    return transitionRejected(
      current,
      "Review cycle cannot be paused in this state.",
    );
  }
  const resumeStage = current.state;
  if (
    resumeStage !== "REVIEWING" &&
    resumeStage !== "AGGREGATING" &&
    resumeStage !== "VERIFYING_FIX"
  ) {
    return transitionRejected(current, "Paused resume stage is invalid.");
  }
  return finishState({
    ...cycleFields(current),
    ...fixFindingSetFields(current),
    state: "PAUSED",
    stateVersion: current.stateVersion + 1,
    pauseInfo: { reason: command.reason, resumeStage },
    lastCommand: binding,
  });
}

function resume(
  current: ReviewCycleState,
  command: Extract<ReviewTransitionCommand, { type: "RESUME" }>,
  binding: IdempotencyBinding,
): ReviewTransitionResult {
  if (current.state !== "PAUSED") {
    return transitionRejected(
      current,
      "Only a paused review cycle can be resumed.",
    );
  }
  if (command.reasonCleared !== true) {
    return transitionRejected(
      current,
      "Pause reason must be cleared before resume.",
    );
  }
  const resumeStage = current.pauseInfo.resumeStage;
  if (!isAllowed("PAUSED", resumeStage)) {
    return transitionRejected(current, "Stored resume stage is not allowed.");
  }
  return finishState({
    ...cycleFields(current),
    ...fixFindingSetFields(current),
    state: resumeStage,
    stateVersion: current.stateVersion + 1,
    lastCommand: binding,
  });
}

function requestCancel(
  current: ReviewCycleState,
  command: Extract<ReviewTransitionCommand, { type: "REQUEST_CANCEL" }>,
  binding: IdempotencyBinding,
): ReviewTransitionResult {
  if (!isAllowed(current.state, "CANCEL_REQUESTED")) {
    return transitionRejected(
      current,
      "Review cycle cannot be cancelled in this state.",
    );
  }
  return finishState({
    ...cycleFields(current),
    state: "CANCEL_REQUESTED",
    stateVersion: current.stateVersion + 1,
    cancelReason: command.reason,
    lastCommand: binding,
  });
}

function confirmCancel(
  current: ReviewCycleState,
  _command: Extract<ReviewTransitionCommand, { type: "CONFIRM_CANCEL" }>,
  binding: IdempotencyBinding,
): ReviewTransitionResult {
  if (
    current.state !== "CANCEL_REQUESTED" ||
    !isAllowed(current.state, "CANCELLED")
  ) {
    return transitionRejected(
      current,
      "Cancellation fencing is only valid after cancel request.",
    );
  }
  if (current.cancelReason === undefined) {
    return transitionRejected(
      current,
      "Cancellation request is missing its reason.",
    );
  }
  return finishState({
    ...cycleFields(current),
    state: "CANCELLED",
    stateVersion: current.stateVersion + 1,
    cancelReason: current.cancelReason,
    terminalReceipt: binding,
  });
}

function createFreshCycle(
  current: ReviewCycleState,
  command: Extract<ReviewTransitionCommand, { type: "CREATE_FRESH_CYCLE" }>,
  binding: IdempotencyBinding,
): ReviewTransitionResult {
  if (current.state !== "REQUIRES_FRESH_REVIEW") {
    return transitionRejected(
      current,
      "A child cycle requires REQUIRES_FRESH_REVIEW.",
    );
  }
  if (
    command.childCycleId === current.cycleId ||
    command.childReviewContextHash === current.reviewContextHash
  ) {
    return transitionRejected(
      current,
      "A fresh review requires a distinct cycle and context.",
    );
  }
  if (current.lastCommand?.freshChild !== undefined) {
    return failure(
      protocolError(
        "CONFLICT",
        "A child cycle has already been created for this review cycle.",
        current.cycleId,
      ),
      current,
    );
  }
  if (current.cycleNumber >= Number.MAX_SAFE_INTEGER) {
    return failure(
      protocolError(
        "RESOURCE_EXHAUSTED",
        "Review cycle number limit reached.",
        current.cycleId,
      ),
      current,
    );
  }

  const freshChild = {
    cycleId: command.childCycleId,
    repoId: command.childRepoId,
    revisions: command.childRevisions,
    reviewContextHash: command.childReviewContextHash,
    versionBinding: command.childVersionBinding,
  };

  const parent = finishState({
    ...cycleFields(current),
    state: "REQUIRES_FRESH_REVIEW",
    stateVersion: current.stateVersion + 1,
    lastCommand: { ...binding, freshChild },
  });
  if (!parent.ok) return parent;

  const child = validateProtocolValue("reviewCycleState", {
    cycleId: freshChild.cycleId,
    parentCycleId: current.cycleId,
    cycleNumber: current.cycleNumber + 1,
    repoId: freshChild.repoId,
    revisions: freshChild.revisions,
    state: "QUEUED",
    stateVersion: 0,
    reviewContextHash: freshChild.reviewContextHash,
    manifestHash: null,
    versionBinding: freshChild.versionBinding,
  });
  if (!child.ok) {
    return failure(
      protocolError(
        "INVALID_ARGUMENT",
        "Child cycle identity is invalid.",
        current.cycleId,
      ),
      current,
    );
  }
  return {
    ok: true,
    replayed: false,
    state: parent.state,
    childCycle: child.value,
  };
}

function finishState(candidate: unknown): ReviewTransitionResult {
  const validation = validateProtocolValue("reviewCycleState", candidate);
  if (!validation.ok) {
    return failure(
      protocolError(
        "INTERNAL_ERROR",
        "Transition produced an invalid state.",
        "review-cycle",
      ),
    );
  }
  return success(validation.value, false);
}

function success(
  state: ReviewCycleState,
  replayed: boolean,
  childCycle?: ReviewCycleState,
): ReviewTransitionResult {
  return childCycle === undefined
    ? { ok: true, replayed, state }
    : { ok: true, replayed, state, childCycle };
}

function replayedFreshCycle(
  state: ReviewCycleState,
  command: ReviewTransitionCommand,
): ReviewCycleState | undefined {
  if (
    command.type !== "CREATE_FRESH_CYCLE" ||
    state.state !== "REQUIRES_FRESH_REVIEW"
  ) {
    return undefined;
  }
  const seed = state.lastCommand?.freshChild;
  if (seed === undefined) return undefined;
  const child = validateProtocolValue("reviewCycleState", {
    cycleId: seed.cycleId,
    parentCycleId: state.cycleId,
    cycleNumber: state.cycleNumber + 1,
    repoId: seed.repoId,
    revisions: seed.revisions,
    state: "QUEUED",
    stateVersion: 0,
    reviewContextHash: seed.reviewContextHash,
    manifestHash: null,
    versionBinding: seed.versionBinding,
  });
  return child.ok ? child.value : undefined;
}

function failure(
  error: ProtocolError,
  state?: ReviewCycleState,
): ReviewTransitionResult {
  return state === undefined
    ? { ok: false, error }
    : { ok: false, error, state };
}

function transitionRejected(
  state: ReviewCycleState,
  message: string,
): ReviewTransitionResult {
  return failure(
    protocolError("INVALID_ARGUMENT", message, state.cycleId),
    state,
  );
}

function approvalRejected(state: ReviewCycleState): ReviewTransitionResult {
  return failure(
    protocolError(
      "CONFLICT",
      "Approval guard rejected missing, uncertain, incomplete, stale, or blocking evidence.",
      state.cycleId,
    ),
    state,
  );
}

function protocolError(
  code: ProtocolError["code"],
  message: string,
  correlationId: string,
): ProtocolError {
  return { code, message, retryable: false, correlationId };
}

function lastAppliedBinding(
  state: ReviewCycleState,
): IdempotencyBinding | undefined {
  if ("terminalReceipt" in state) return state.terminalReceipt;
  if ("lastCommand" in state) return state.lastCommand;
  return undefined;
}

function commandPayload(command: ReviewTransitionCommand): unknown {
  const { idempotencyKey: _key, ...payload } = command;
  return payload;
}

function cycleFields(state: ReviewCycleState) {
  return {
    cycleId: state.cycleId,
    parentCycleId: state.parentCycleId,
    cycleNumber: state.cycleNumber,
    repoId: state.repoId,
    revisions: state.revisions,
    reviewContextHash: state.reviewContextHash,
    manifestHash: state.manifestHash,
    versionBinding: state.versionBinding,
  };
}

function isAllowed(from: ReviewState, to: ReviewState): boolean {
  return allowedReviewStateTransitions[from].some(
    (candidate) => candidate === to,
  );
}

function isTerminal(state: ReviewState): boolean {
  return state === "APPROVED" || state === "FAILED" || state === "CANCELLED";
}

function isUtcTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().startsWith(value.slice(0, 19))
  );
}

function hasCompleteFixApprovalEvidence(
  requiredFindingIds: readonly string[],
  evidence: ApprovalEvidence | undefined,
): boolean {
  return (
    evidence !== undefined &&
    hasCompleteFixOutcomeSet(requiredFindingIds, evidence.fixOutcomes) &&
    evidence.fixOutcomes.every(
      (outcome) => outcome.status === "FIXED" && !outcome.requiresFreshReview,
    )
  );
}

function hasCompleteFixOutcomeSet(
  requiredFindingIds: readonly string[],
  outcomes: readonly FixVerificationOutcome[] | undefined,
): outcomes is readonly FixVerificationOutcome[] {
  if (outcomes === undefined || outcomes.length !== requiredFindingIds.length) {
    return false;
  }

  const required = new Set(requiredFindingIds);
  const observed = new Set<string>();
  for (const outcome of outcomes) {
    if (!required.has(outcome.findingId) || observed.has(outcome.findingId)) {
      return false;
    }
    observed.add(outcome.findingId);
  }
  return observed.size === required.size;
}

function sortUniqueFindingIds(findingIds: readonly string[]): string[] {
  return [...new Set(findingIds)].sort(compareAscii);
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function hasCanonicalRequiredFindingIds(
  findingIds: readonly string[],
): boolean {
  for (let index = 1; index < findingIds.length; index += 1) {
    const previous = findingIds[index - 1];
    const current = findingIds[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareAscii(previous, current) >= 0
    ) {
      return false;
    }
  }
  return true;
}

function fixFindingSetFields(state: ReviewCycleState) {
  return "requiredFindingIds" in state
    ? { requiredFindingIds: [...state.requiredFindingIds] }
    : {};
}
