import { expect, test } from "bun:test";
import type { ReviewState } from "../../src/protocol";
import {
  allowedReviewStateTransitions,
  approvalEvidenceExample,
  createInitialReviewCycle,
  protocolExampleSha1,
  protocolExampleSha256,
  reviewCycleStateExample,
  transitionReviewCycle,
  validateProtocolValue,
} from "../../src/protocol";

const revisionPair = {
  objectFormat: "sha1",
  baseSha: protocolExampleSha1,
  headSha: "c".repeat(40),
} as const;

const terminalReceipt = {
  idempotencyKey: "terminal-1",
  normalizedPayloadHash: protocolExampleSha256,
};
const requiredFindingIds = ["finding-1", "finding-2"];

function fixEvidence() {
  return [
    {
      kind: "test_artifact" as const,
      artifactSha256: protocolExampleSha256,
      artifactSizeBytes: 1,
    },
  ];
}

function fixedOutcome(findingId: string) {
  return {
    findingId,
    status: "FIXED" as const,
    evidence: fixEvidence(),
    requiresFreshReview: false,
  };
}

function notFixedOutcome(findingId: string) {
  return {
    findingId,
    status: "NOT_FIXED" as const,
    evidence: fixEvidence(),
    requiresFreshReview: false,
  };
}

function uncertainOutcome(findingId: string) {
  return {
    findingId,
    status: "UNCERTAIN" as const,
    evidence: fixEvidence(),
    requiresFreshReview: false,
  };
}

function regressionOutcome(findingId: string, regressionFindingId: string) {
  return {
    findingId,
    status: "REGRESSION" as const,
    evidence: fixEvidence(),
    regressionFindingId,
    requiresFreshReview: false,
  };
}

function freshReviewOutcome(findingId: string) {
  return {
    ...fixedOutcome(findingId),
    requiresFreshReview: true,
  };
}

function stateSnapshot(
  state: ReviewState,
  resumeStage: "REVIEWING" | "AGGREGATING" | "VERIFYING_FIX" = "REVIEWING",
): Record<string, unknown> {
  const common = {
    cycleId: "cycle-1",
    parentCycleId: null,
    cycleNumber: 1,
    repoId: "example/nightreviewer",
    revisions: revisionPair,
    state,
    stateVersion: 0,
    reviewContextHash: protocolExampleSha256,
    manifestHash: protocolExampleSha256,
    versionBinding: reviewCycleStateExample.versionBinding,
  };
  if (state === "PAUSED") {
    return {
      ...common,
      ...(resumeStage === "VERIFYING_FIX" ? { requiredFindingIds } : {}),
      pauseInfo: {
        reason: { code: "BLOCKED", message: "Waiting for a prerequisite." },
        resumeStage,
      },
    };
  }
  if (state === "CANCEL_REQUESTED") {
    return { ...common, cancelReason: "Operator requested cancellation." };
  }
  if (state === "NEEDS_FIX" || state === "VERIFYING_FIX") {
    return { ...common, requiredFindingIds };
  }
  if (state === "FAILED") {
    return { ...common, failureCode: "INTERNAL_ERROR", terminalReceipt };
  }
  if (state === "CANCELLED") {
    return {
      ...common,
      cancelReason: "Operator requested cancellation.",
      terminalReceipt,
    };
  }
  if (state === "APPROVED") {
    return {
      ...common,
      approvalReceipt: {
        revisions: revisionPair,
        manifestHash: protocolExampleSha256,
        policyVersion: "strict/1",
        policyHash: protocolExampleSha256,
        evidenceDigest: protocolExampleSha256,
        approvedAt: "2026-10-03T12:00:00Z",
      },
      terminalReceipt,
    };
  }
  return common;
}

function passingApprovalEvidence() {
  return structuredClone(approvalEvidenceExample);
}

function transitionEvidence(
  target: ReviewState,
  source: ReviewState,
): Record<string, unknown> | undefined {
  switch (target) {
    case "REVIEWING":
      return {
        durableManifestRecorded: true,
        manifestHash: protocolExampleSha256,
      };
    case "AGGREGATING":
      return { allRequiredRunsSucceeded: true };
    case "NEEDS_FIX":
      return {
        allAdjudicationsComplete: true,
        hasBlockingFindings: true,
        ...(source === "AGGREGATING"
          ? { requiredFindingIds: [...requiredFindingIds].reverse() }
          : {
              fixOutcomes: [
                fixedOutcome("finding-1"),
                notFixedOutcome("finding-2"),
              ],
            }),
      };
    case "VERIFYING_FIX":
      return { atomicFixSubmissionValidated: true };
    case "REQUIRES_FRESH_REVIEW":
      return { freshReviewRequired: true };
    case "FAILED":
      return { failureCode: "INTERNAL_ERROR" };
    case "APPROVED":
      return {
        approval: {
          ...passingApprovalEvidence(),
          ...(source === "VERIFYING_FIX"
            ? {
                fixOutcomes: requiredFindingIds.map((findingId) =>
                  fixedOutcome(findingId),
                ),
              }
            : {}),
        },
        approvedAt: "2026-10-03T12:00:00Z",
      };
    default:
      return undefined;
  }
}

function commandFor(
  source: ReviewState,
  target: ReviewState,
): Record<string, unknown> {
  const common = {
    expectedVersion: 0,
    idempotencyKey: `transition-${source.toLowerCase()}-${target.toLowerCase()}`,
  };
  if (target === "PAUSED") {
    return {
      ...common,
      type: "PAUSE",
      reason: {
        code: "USER_REQUEST",
        message: "Paused for the transition test.",
      },
    };
  }
  if (target === "CANCEL_REQUESTED") {
    return { ...common, type: "REQUEST_CANCEL", reason: "Cancellation test." };
  }
  if (target === "CANCELLED") {
    return {
      ...common,
      type: "CONFIRM_CANCEL",
      fencingAndRevocationConfirmed: true,
    };
  }
  if (
    source === "PAUSED" &&
    (target === "REVIEWING" ||
      target === "AGGREGATING" ||
      target === "VERIFYING_FIX")
  ) {
    return { ...common, type: "RESUME", reasonCleared: true };
  }
  return {
    ...common,
    type: "ADVANCE",
    target,
    ...(transitionEvidence(target, source) === undefined
      ? {}
      : { evidence: transitionEvidence(target, source) }),
  };
}

test("initial cycle validates, pins full revisions, and advances monotonically", () => {
  const initial = createInitialReviewCycle({
    cycleId: "cycle-created",
    repoId: "example/nightreviewer",
    revisions: revisionPair,
    reviewContextHash: protocolExampleSha256,
    versionBinding: reviewCycleStateExample.versionBinding,
  });
  expect(initial.state).toBe("QUEUED");
  expect(initial.stateVersion).toBe(0);
  expect(initial.manifestHash).toBeNull();
  expect(validateProtocolValue("reviewCycleState", initial).ok).toBe(true);

  const advanced = transitionReviewCycle(initial, {
    type: "ADVANCE",
    target: "SNAPSHOTTING",
    expectedVersion: 0,
    idempotencyKey: "start-snapshot",
  });
  expect(advanced.ok).toBe(true);
  if (advanced.ok) {
    expect(advanced.state.state).toBe("SNAPSHOTTING");
    expect(advanced.state.stateVersion).toBe(1);
  }

  const stale = transitionReviewCycle(advanced.ok ? advanced.state : initial, {
    type: "ADVANCE",
    target: "REVIEWING",
    expectedVersion: 0,
    idempotencyKey: "stale-review-transition",
    evidence: {
      durableManifestRecorded: true,
      manifestHash: protocolExampleSha256,
    },
  });
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.error.code).toBe("CONFLICT");
});

test("every normative allowed state transition succeeds through its guarded command", () => {
  for (const [source, targets] of Object.entries(
    allowedReviewStateTransitions,
  ) as [ReviewState, readonly ReviewState[]][]) {
    for (const target of targets) {
      const resumeStage =
        source === "PAUSED" &&
        (target === "REVIEWING" ||
          target === "AGGREGATING" ||
          target === "VERIFYING_FIX")
          ? target
          : "REVIEWING";
      const current = stateSnapshot(source, resumeStage);
      const validation = validateProtocolValue("reviewCycleState", current);
      expect(validation.ok).toBe(true);

      const result = transitionReviewCycle(current, commandFor(source, target));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.state).toBe(
          target === "CANCELLED" ? "CANCELLED" : target,
        );
        expect(result.state.stateVersion).toBe(1);
        if (
          target === "NEEDS_FIX" ||
          target === "VERIFYING_FIX" ||
          (source === "VERIFYING_FIX" && target === "PAUSED")
        ) {
          expect("requiredFindingIds" in result.state).toBe(true);
          if ("requiredFindingIds" in result.state) {
            expect(result.state.requiredFindingIds).toEqual(requiredFindingIds);
          }
        }
      }
    }
  }
});

test("every forbidden direct pair in the transition table is rejected", () => {
  const states = Object.keys(allowedReviewStateTransitions) as ReviewState[];
  for (const source of states) {
    for (const target of states) {
      if (
        (
          allowedReviewStateTransitions[source] as readonly ReviewState[]
        ).includes(target)
      ) {
        continue;
      }
      const current = stateSnapshot(source);
      const result = transitionReviewCycle(current, {
        type: "ADVANCE",
        target,
        expectedVersion: 0,
        idempotencyKey: `forbidden-${source}-${target}`,
      });
      expect(result.ok).toBe(false);
    }
  }
});

test("pause retains reason and only resumes to the stored stage after clearance", () => {
  const pause = transitionReviewCycle(stateSnapshot("REVIEWING"), {
    type: "PAUSE",
    expectedVersion: 0,
    idempotencyKey: "pause-1",
    reason: { code: "BLOCKED", message: "A required input is unavailable." },
  });
  expect(pause.ok).toBe(true);
  if (!pause.ok) return;
  expect(pause.state.state).toBe("PAUSED");
  if (pause.state.state !== "PAUSED") return;
  expect(pause.state.pauseInfo.reason.message).toBe(
    "A required input is unavailable.",
  );

  const earlyResume = transitionReviewCycle(pause.state, {
    type: "RESUME",
    expectedVersion: 1,
    idempotencyKey: "resume-early",
    reasonCleared: false,
  });
  expect(earlyResume.ok).toBe(false);
  const directResume = transitionReviewCycle(pause.state, {
    type: "ADVANCE",
    target: "AGGREGATING",
    expectedVersion: 1,
    idempotencyKey: "resume-bypass",
    evidence: { allRequiredRunsSucceeded: true },
  });
  expect(directResume.ok).toBe(false);

  const resume = transitionReviewCycle(pause.state, {
    type: "RESUME",
    expectedVersion: 1,
    idempotencyKey: "resume-1",
    reasonCleared: true,
  });
  expect(resume.ok).toBe(true);
  if (resume.ok) {
    expect(resume.state.state).toBe("REVIEWING");
    expect(resume.state.stateVersion).toBe(2);
  }
});

test("cancellation requires fencing and late results cannot restore approval eligibility", () => {
  const requested = transitionReviewCycle(stateSnapshot("REVIEWING"), {
    type: "REQUEST_CANCEL",
    expectedVersion: 0,
    idempotencyKey: "cancel-request-1",
    reason: "Operator requested cancellation.",
  });
  expect(requested.ok).toBe(true);
  if (!requested.ok) return;
  expect(requested.state.state).toBe("CANCEL_REQUESTED");

  const lateApproval = transitionReviewCycle(
    requested.state,
    commandFor("CANCEL_REQUESTED", "APPROVED"),
  );
  expect(lateApproval.ok).toBe(false);

  const unfenced = transitionReviewCycle(requested.state, {
    type: "CONFIRM_CANCEL",
    expectedVersion: 1,
    idempotencyKey: "cancel-unfenced",
    fencingAndRevocationConfirmed: false,
  });
  expect(unfenced.ok).toBe(false);

  const cancelled = transitionReviewCycle(requested.state, {
    type: "CONFIRM_CANCEL",
    expectedVersion: 1,
    idempotencyKey: "cancel-confirm-1",
    fencingAndRevocationConfirmed: true,
  });
  expect(cancelled.ok).toBe(true);
  if (cancelled.ok) {
    expect(cancelled.state.state).toBe("CANCELLED");
    const replay = transitionReviewCycle(cancelled.state, {
      type: "CONFIRM_CANCEL",
      expectedVersion: 1,
      idempotencyKey: "cancel-confirm-1",
      fencingAndRevocationConfirmed: true,
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.replayed).toBe(true);
  }
});

test("fix and cancellation commands race through the same expected-version fence", () => {
  const needsFix = stateSnapshot("NEEDS_FIX");
  const cancelledFirst = transitionReviewCycle(needsFix, {
    type: "REQUEST_CANCEL",
    expectedVersion: 0,
    idempotencyKey: "cancel-wins",
    reason: "Cancel the pending fix round.",
  });
  expect(cancelledFirst.ok).toBe(true);
  if (cancelledFirst.ok) {
    const staleFix = transitionReviewCycle(cancelledFirst.state, {
      type: "ADVANCE",
      target: "VERIFYING_FIX",
      expectedVersion: 0,
      idempotencyKey: "stale-fix",
      evidence: { atomicFixSubmissionValidated: true },
    });
    expect(staleFix.ok).toBe(false);
    if (!staleFix.ok) expect(staleFix.error.code).toBe("CONFLICT");
  }

  const fixWins = transitionReviewCycle(needsFix, {
    type: "ADVANCE",
    target: "VERIFYING_FIX",
    expectedVersion: 0,
    idempotencyKey: "fix-wins",
    evidence: { atomicFixSubmissionValidated: true },
  });
  expect(fixWins.ok).toBe(true);
  if (fixWins.ok) {
    const staleCancel = transitionReviewCycle(fixWins.state, {
      type: "REQUEST_CANCEL",
      expectedVersion: 0,
      idempotencyKey: "stale-cancel",
      reason: "This command lost the version race.",
    });
    expect(staleCancel.ok).toBe(false);
    if (!staleCancel.ok) expect(staleCancel.error.code).toBe("CONFLICT");
  }
});

test("fresh review creates an explicitly linked child while parent remains unapproved", () => {
  const parent = stateSnapshot("REQUIRES_FRESH_REVIEW");
  const freshCommand = {
    type: "CREATE_FRESH_CYCLE",
    expectedVersion: 0,
    idempotencyKey: "fresh-cycle-1",
    childCycleId: "cycle-2",
    childRepoId: "example/nightreviewer",
    childRevisions: {
      objectFormat: "sha1",
      baseSha: revisionPair.headSha,
      headSha: "d".repeat(40),
    },
    childReviewContextHash: "e".repeat(64),
    childVersionBinding: reviewCycleStateExample.versionBinding,
  };
  const result = transitionReviewCycle(parent, freshCommand);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.state.state).toBe("REQUIRES_FRESH_REVIEW");
    expect(result.state.stateVersion).toBe(1);
    expect(result.childCycle?.cycleId).toBe("cycle-2");
    expect(result.childCycle?.parentCycleId).toBe("cycle-1");
    expect(result.childCycle?.cycleNumber).toBe(2);
    expect(result.childCycle?.stateVersion).toBe(0);
    expect(result.childCycle?.reviewContextHash).toBe("e".repeat(64));

    const replay = transitionReviewCycle(result.state, freshCommand);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.replayed).toBe(true);
      expect(replay.childCycle?.cycleId).toBe("cycle-2");
    }

    const secondChild = transitionReviewCycle(result.state, {
      ...freshCommand,
      expectedVersion: 1,
      idempotencyKey: "fresh-cycle-second-child",
      childCycleId: "cycle-3",
      childReviewContextHash: "f".repeat(64),
    });
    expect(secondChild.ok).toBe(false);
    if (!secondChild.ok) expect(secondChild.error.code).toBe("CONFLICT");
  }

  const sameContext = transitionReviewCycle(parent, {
    type: "CREATE_FRESH_CYCLE",
    expectedVersion: 0,
    idempotencyKey: "fresh-cycle-same-context",
    childCycleId: "cycle-3",
    childRepoId: "example/nightreviewer",
    childRevisions: revisionPair,
    childReviewContextHash: protocolExampleSha256,
    childVersionBinding: reviewCycleStateExample.versionBinding,
  });
  expect(sameContext.ok).toBe(false);
});

test("idempotent retries replay, changed payloads conflict, and terminals cannot mutate", () => {
  const current = reviewCycleStateExample;
  const command = {
    type: "ADVANCE",
    target: "SNAPSHOTTING",
    expectedVersion: 0,
    idempotencyKey: "start-1",
  };
  const first = transitionReviewCycle(current, command);
  expect(first.ok).toBe(true);
  if (!first.ok) return;

  const replay = transitionReviewCycle(first.state, command);
  expect(replay.ok).toBe(true);
  if (replay.ok) expect(replay.replayed).toBe(true);

  const conflict = transitionReviewCycle(first.state, {
    ...command,
    target: "FAILED",
    evidence: { failureCode: "INTERNAL_ERROR" },
  });
  expect(conflict.ok).toBe(false);
  if (!conflict.ok) expect(conflict.error.code).toBe("CONFLICT");

  for (const terminal of ["APPROVED", "FAILED", "CANCELLED"] as const) {
    const result = transitionReviewCycle(stateSnapshot(terminal), {
      type: "ADVANCE",
      target: "SNAPSHOTTING",
      expectedVersion: 0,
      idempotencyKey: `terminal-${terminal}`,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");
  }
});

test("approval fails closed for missing, failed, uncertain, stale, incomplete and blocking evidence", () => {
  const base = passingApprovalEvidence();
  const missing = { ...base, requiredRuns: base.requiredRuns.slice(1) };
  const repeatedSlot = {
    ...base,
    requiredRuns: base.requiredRuns.map((run, index) =>
      index === 1
        ? {
            ...run,
            direction: "correctness" as const,
            replicaIndex: 1 as const,
          }
        : run,
    ),
  };
  const failed = {
    ...base,
    requiredRuns: base.requiredRuns.map((run, index) =>
      index === 0 ? { ...run, status: "FAILED" as const } : run,
    ),
  };
  const uncertain = { ...base, canonicalValidation: "UNCERTAIN" as const };
  const incompleteCoverage = { ...base, coverageComplete: false };
  const unresolved = { ...base, allRequiredAdjudicationsResolved: false };
  const invalidBinding = { ...base, bindingsValid: false };
  const mediumBlocker = { ...base, blockingSeverities: ["medium" as const] };
  const uncertainFix = {
    ...base,
    fixOutcomes: [uncertainOutcome("finding-1"), fixedOutcome("finding-2")],
  };
  const freshReviewRequired = {
    ...base,
    fixOutcomes: [freshReviewOutcome("finding-1"), fixedOutcome("finding-2")],
  };
  const malformed = { ...base, requiredRuns: undefined };
  const cases = [
    missing,
    repeatedSlot,
    failed,
    uncertain,
    incompleteCoverage,
    unresolved,
    invalidBinding,
    mediumBlocker,
    uncertainFix,
    freshReviewRequired,
    malformed,
  ];

  for (const approval of cases) {
    const result = transitionReviewCycle(stateSnapshot("AGGREGATING"), {
      type: "ADVANCE",
      target: "APPROVED",
      expectedVersion: 0,
      idempotencyKey: `approval-negative-${cases.indexOf(approval)}`,
      evidence: {
        approval,
        approvedAt: "2026-10-03T12:00:00Z",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) expect(result.state.state).not.toBe("APPROVED");
  }

  const withoutFixResults = transitionReviewCycle(
    stateSnapshot("VERIFYING_FIX"),
    {
      type: "ADVANCE",
      target: "APPROVED",
      expectedVersion: 0,
      idempotencyKey: "verify-approval-missing-fix-results",
      evidence: {
        approval: base,
        approvedAt: "2026-10-03T12:00:00Z",
      },
    },
  );
  expect(withoutFixResults.ok).toBe(false);

  const validFixResults = {
    ...base,
    fixOutcomes: requiredFindingIds.map((findingId) => fixedOutcome(findingId)),
  };
  const validApproval = transitionReviewCycle(stateSnapshot("VERIFYING_FIX"), {
    type: "ADVANCE",
    target: "APPROVED",
    expectedVersion: 0,
    idempotencyKey: "verify-approval-valid",
    evidence: {
      approval: validFixResults,
      approvedAt: "2026-10-03T12:00:00Z",
    },
  });
  expect(validApproval.ok).toBe(true);
  if (validApproval.ok) {
    expect(validApproval.state.state).toBe("APPROVED");
    if (validApproval.state.state === "APPROVED") {
      expect(validApproval.state.approvalReceipt.revisions).toEqual(
        revisionPair,
      );
      expect(validApproval.state.approvalReceipt.manifestHash).toBe(
        protocolExampleSha256,
      );
      expect(validApproval.state.approvalReceipt.policyVersion).toBe(
        "strict/1",
      );
      expect(validApproval.state.approvalReceipt.evidenceDigest).toMatch(
        /^[0-9a-f]{64}$/,
      );
    }
  }
});

test("fix approval requires exactly one FIXED result per authoritative finding ID", () => {
  const base = passingApprovalEvidence();
  const approveWith = (fixOutcomes: unknown[], idempotencyKey: string) =>
    transitionReviewCycle(stateSnapshot("VERIFYING_FIX"), {
      type: "ADVANCE",
      target: "APPROVED",
      expectedVersion: 0,
      idempotencyKey,
      evidence: {
        approval: { ...base, fixOutcomes },
        approvedAt: "2026-10-03T12:00:00Z",
      },
    });

  const omitted = approveWith(
    [fixedOutcome("finding-1")],
    "fix-approval-omitted",
  );
  expect(omitted.ok).toBe(false);

  const duplicateAndOmitted = approveWith(
    [fixedOutcome("finding-1"), fixedOutcome("finding-1")],
    "fix-approval-duplicate",
  );
  expect(duplicateAndOmitted.ok).toBe(false);

  const unexpected = approveWith(
    [
      fixedOutcome("finding-1"),
      fixedOutcome("finding-2"),
      fixedOutcome("unexpected-finding"),
    ],
    "fix-approval-unexpected",
  );
  expect(unexpected.ok).toBe(false);

  const notFixed = approveWith(
    [fixedOutcome("finding-1"), notFixedOutcome("finding-2")],
    "fix-approval-not-fixed",
  );
  expect(notFixed.ok).toBe(false);

  const uncertain = approveWith(
    [fixedOutcome("finding-1"), uncertainOutcome("finding-2")],
    "fix-approval-uncertain",
  );
  expect(uncertain.ok).toBe(false);

  const regression = approveWith(
    [fixedOutcome("finding-1"), regressionOutcome("finding-2", "regression-1")],
    "fix-approval-regression",
  );
  expect(regression.ok).toBe(false);

  const freshReview = approveWith(
    [fixedOutcome("finding-1"), freshReviewOutcome("finding-2")],
    "fix-approval-fresh-review",
  );
  expect(freshReview.ok).toBe(false);

  const completeOutOfOrder = approveWith(
    [fixedOutcome("finding-2"), fixedOutcome("finding-1")],
    "fix-approval-complete-out-of-order",
  );
  expect(completeOutOfOrder.ok).toBe(true);
  if (completeOutOfOrder.ok) {
    expect(completeOutOfOrder.state.state).toBe("APPROVED");
  }
});

test("fix finding IDs persist across pause and accumulate regression IDs", () => {
  const verifying = transitionReviewCycle(stateSnapshot("NEEDS_FIX"), {
    type: "ADVANCE",
    target: "VERIFYING_FIX",
    expectedVersion: 0,
    idempotencyKey: "fix-set-start",
    evidence: { atomicFixSubmissionValidated: true },
  });
  expect(verifying.ok).toBe(true);
  if (!verifying.ok) return;
  expect("requiredFindingIds" in verifying.state).toBe(true);
  if (!("requiredFindingIds" in verifying.state)) return;
  expect(verifying.state.requiredFindingIds).toEqual(requiredFindingIds);

  const paused = transitionReviewCycle(verifying.state, {
    type: "PAUSE",
    expectedVersion: 1,
    idempotencyKey: "fix-set-pause",
    reason: { code: "BLOCKED", message: "Wait for a verification artifact." },
  });
  expect(paused.ok).toBe(true);
  if (!paused.ok) return;
  expect(paused.state.state).toBe("PAUSED");
  if (paused.state.state !== "PAUSED") return;
  expect("requiredFindingIds" in paused.state).toBe(true);
  if ("requiredFindingIds" in paused.state) {
    expect(paused.state.requiredFindingIds).toEqual(requiredFindingIds);
  }

  const resumed = transitionReviewCycle(paused.state, {
    type: "RESUME",
    expectedVersion: 2,
    idempotencyKey: "fix-set-resume",
    reasonCleared: true,
  });
  expect(resumed.ok).toBe(true);
  if (!resumed.ok) return;
  expect(resumed.state.state).toBe("VERIFYING_FIX");
  if (!("requiredFindingIds" in resumed.state)) return;
  expect(resumed.state.requiredFindingIds).toEqual(requiredFindingIds);

  const nextRound = transitionReviewCycle(resumed.state, {
    type: "ADVANCE",
    target: "NEEDS_FIX",
    expectedVersion: 3,
    idempotencyKey: "fix-set-regression-round",
    evidence: {
      allAdjudicationsComplete: true,
      hasBlockingFindings: true,
      fixOutcomes: [
        fixedOutcome("finding-1"),
        regressionOutcome("finding-2", "regression-z"),
      ],
    },
  });
  expect(nextRound.ok).toBe(true);
  if (nextRound.ok) {
    expect(nextRound.state.state).toBe("NEEDS_FIX");
    if ("requiredFindingIds" in nextRound.state) {
      expect(nextRound.state.requiredFindingIds).toEqual([
        "finding-1",
        "finding-2",
        "regression-z",
      ]);
    }
  }
});

test("subsequent fix round rejects incomplete and fresh-review outcomes", () => {
  const current = stateSnapshot("VERIFYING_FIX");
  for (const [idempotencyKey, fixOutcomes] of [
    ["fix-round-omitted", [fixedOutcome("finding-1")]],
    [
      "fix-round-fresh-review",
      [fixedOutcome("finding-1"), freshReviewOutcome("finding-2")],
    ],
  ] as const) {
    const result = transitionReviewCycle(current, {
      type: "ADVANCE",
      target: "NEEDS_FIX",
      expectedVersion: 0,
      idempotencyKey,
      evidence: {
        allAdjudicationsComplete: true,
        hasBlockingFindings: true,
        fixOutcomes,
      },
    });
    expect(result.ok).toBe(false);
  }
});

test("invalid pause resume stage and malformed transition commands are rejected", () => {
  const invalidPaused = {
    ...stateSnapshot("PAUSED"),
    pauseInfo: {
      reason: { code: "BLOCKED", message: "Waiting." },
      resumeStage: "QUEUED",
    },
  };
  expect(validateProtocolValue("reviewCycleState", invalidPaused).ok).toBe(
    false,
  );

  const malformedCommand = transitionReviewCycle(reviewCycleStateExample, {
    type: "ADVANCE",
    target: "UNKNOWN_STATE",
    expectedVersion: 0,
    idempotencyKey: "unknown-state",
  });
  expect(malformedCommand.ok).toBe(false);
  if (!malformedCommand.ok)
    expect(malformedCommand.error.code).toBe("SCHEMA_INVALID");
});
