import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DaemonOwner, DaemonReviewRuntime } from "../../src/daemon";
import type {
  ProtocolJsonValue,
  ReviewSubmitInput,
  WorkerDirection,
} from "../../src/protocol";
import {
  hashCanonicalJson,
  protocolExampleSha1,
  protocolExampleSha256,
  versionHashBindingExample,
} from "../../src/protocol";
import type {
  BackendInvocationInput,
  BackendInvocationResult,
  BackendReconciliationResult,
  BackendTurnReceipt,
  FakeScenarioPlan,
  ReviewerBackend,
  SchedulerClock,
  SchedulerPromptContext,
} from "../../src/scheduler";
import {
  classifyBackendFailure,
  DurableScheduler,
  FakeReviewerBackend,
  fakeWorkerOutput,
  NR08_FAKE_PROMPT,
} from "../../src/scheduler";
import type { SnapshotCycleContext, SqliteStorage } from "../../src/storage";
import { openStorage } from "../../src/storage";

const strictInput: Omit<ReviewSubmitInput, "idempotencyKey"> = {
  repoId: "fixture/project",
  task: "Exercise durable fake scheduling.",
  acceptanceCriteria: [
    {
      id: "AC1",
      requirement: "Run jobs durably and within bounded concurrency.",
    },
  ],
  profile: "strict/1",
  objectFormat: "sha1",
  baseSha: protocolExampleSha1,
  headSha: protocolExampleSha1,
};

test("nine complete no-finding fake runs pass the offline gate", async () => {
  const fixture = await createFixture();
  const backend = new FakeReviewerBackend();
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
    concurrency: 3,
  });
  try {
    expect(scheduler.progress(fixture.context.cycleId).requiredRuns).toBe(9);
    scheduler.activateCycle(fixture.context);
    await scheduler.start();
    await waitFor(
      () =>
        fixture.store.readCycle(fixture.context.cycleId).state === "APPROVED",
    );

    const cycle = fixture.store.readCycle(fixture.context.cycleId);
    const progress = fixture.store.readSchedulerCycleStatus(
      fixture.context.cycleId,
    );
    const selected = fixture.store.readSchedulerSelectedRuns(
      fixture.context.cycleId,
    );
    expect(cycle.state).toBe("APPROVED");
    expect(progress).toMatchObject({
      backend: "FAKE",
      qualification: "OFFLINE_ONLY",
      state: "COMPLETE",
      completedRuns: 9,
      requiredRuns: 9,
      provisionalFindings: [],
    });
    expect(selected).toHaveLength(9);
    expect(backend.maxObservedConcurrency).toBeLessThanOrEqual(3);
    const schedulerTransitions = fixture.store
      .readEventPage(fixture.context.cycleId)
      .events.filter((event) => event.eventType === "review.cycle_transitioned")
      .filter((event) => {
        const key = (event.payload as { command?: { idempotencyKey?: string } })
          .command?.idempotencyKey;
        return (
          key?.startsWith("scheduler-aggregate-") === true ||
          key?.startsWith("scheduler-approve-") === true ||
          key?.startsWith("scheduler-failed-") === true
        );
      });
    expect(schedulerTransitions).toHaveLength(2);
    expect(
      schedulerTransitions.every((event) => {
        const payload = event.payload as {
          backend?: string;
          qualification?: string;
        };
        return (
          payload.backend === "FAKE" && payload.qualification === "OFFLINE_ONLY"
        );
      }),
    ).toBe(true);
    expect(fixture.store.integrityCheck()).toEqual({
      integrity: "ok",
      foreignKeyViolations: 0,
    });
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("LIVE qualification persists one run and does not aggregate or approve", async () => {
  const fixture = await createFixture();
  const backend = new MockLiveQualificationBackend(fixture.store);
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
  });
  try {
    await scheduler.start();
    await waitFor(
      () =>
        fixture.store.readSchedulerCycleStatus(fixture.context.cycleId)
          .state === "COMPLETE",
    );

    expect(fixture.store.readCycle(fixture.context.cycleId).state).toBe(
      "REVIEWING",
    );
    expect(
      fixture.store.readSchedulerBackendBinding(fixture.context.cycleId),
    ).toMatchObject({
      backend: "LIVE",
      qualification: "LIVE_PRODUCTION_BRIDGE",
      runPlan: "NR09_LIVE_QUALIFICATION",
      requiredRuns: 1,
      configurationDigest: backend.profile.configurationDigest,
    });
    expect(
      fixture.store.readSchedulerCycleStatus(fixture.context.cycleId),
    ).toMatchObject({
      backend: "LIVE",
      qualification: "LIVE_PRODUCTION_BRIDGE",
      state: "COMPLETE",
      completedRuns: 1,
      requiredRuns: 1,
    });
    const reviewRuntime = new DaemonReviewRuntime({
      store: fixture.store,
      owner: fixture.owner,
      trustedRepositoryIds: new Set(["fixture/project"]),
      snapshotService: emptySnapshotService(),
      scheduler,
      bindingProvider: () => versionHashBindingExample,
    });
    const liveStatus = (await reviewRuntime.invoke(
      "review_status",
      { reviewId: fixture.context.reviewId },
      "live-qualification-status",
    )) as {
      progress: { completedRuns: number; requiredRuns: number };
      scheduler: { backend: string; qualification: string; state: string };
    };
    expect(liveStatus.progress).toMatchObject({
      completedRuns: 1,
      requiredRuns: 1,
    });
    expect(liveStatus.scheduler).toMatchObject({
      backend: "LIVE",
      qualification: "LIVE_PRODUCTION_BRIDGE",
      state: "COMPLETE",
    });
    const [selected] = fixture.store.readSchedulerSelectedRuns(
      fixture.context.cycleId,
    );
    expect(selected?.direction).toBe("correctness");
    expect(selected?.replicaIndex).toBe(1);
    expect(
      fixture.store
        .readEventPage(fixture.context.cycleId)
        .events.some(
          (event) => event.eventType === "scheduler.aggregation_recorded",
        ),
    ).toBe(false);

    const attempt = fixture.store
      .readEventPage(fixture.context.cycleId)
      .events.find((event) => event.eventType === "worker.result_recorded");
    if (attempt === undefined) {
      throw new Error("Mock live result event was not recorded.");
    }
    const attemptId = (attempt.payload as { attemptId: string }).attemptId;
    const provenance = fixture.store.readSchedulerAttemptProvenance(attemptId);
    expect(provenance.sendState).toBe("SENT");
    expect(provenance.artifacts.map(({ purpose }) => purpose)).toEqual([
      "RECEIPT",
      "TURN_RESPONSE",
    ]);
    if (provenance.receiptArtifact === undefined) {
      throw new Error("Mock live result did not persist its receipt.");
    }
    const receiptBytes = await fixture.store.readRawArtifact(
      provenance.receiptArtifact,
    );
    expect(
      JSON.parse(Buffer.from(receiptBytes).toString("utf8")),
    ).toMatchObject({
      qualification: "LIVE_PRODUCTION_BRIDGE",
      sendState: "SENT",
      session: { freshForAttempt: true },
    });

    const mismatchedBackend = new MockLiveQualificationBackend(
      fixture.store,
      "b".repeat(64),
    );
    const restartedScheduler = new DurableScheduler({
      store: fixture.store,
      owner: fixture.owner,
      backend: mismatchedBackend,
    });
    expect(() => restartedScheduler.activateCycle(fixture.context)).toThrow(
      "Scheduler cycle is bound to a different backend configuration.",
    );
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("schema v4 backfills existing scheduler jobs as immutable NR-08 FAKE", async () => {
  const fixture = await createFixture();
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
  });
  let storeClosed = false;
  let reopened: SqliteStorage | undefined;
  try {
    scheduler.activateCycle(fixture.context);
    const rootDir = path.join(fixture.temporary, "store");
    fixture.owner.release();
    fixture.store.close();
    storeClosed = true;

    const legacy = new Database(path.join(rootDir, "database.sqlite"));
    try {
      legacy.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TRIGGER schema_migrations_no_update;
        DROP TRIGGER schema_migrations_no_delete;
        DROP TRIGGER scheduler_backend_bindings_no_update;
        DROP TRIGGER scheduler_backend_bindings_no_delete;
        DROP TRIGGER scheduler_attempt_artifacts_no_update;
        DROP TRIGGER scheduler_attempt_artifacts_no_delete;
        DROP TABLE scheduler_attempt_artifacts;
        DROP TABLE scheduler_backend_bindings;
        ALTER TABLE scheduler_attempts DROP COLUMN backend_send_state;
        ALTER TABLE scheduler_attempts DROP COLUMN backend_receipt_sha256;
        DELETE FROM schema_migrations WHERE version = 4;
        PRAGMA user_version = 3;
      `);
    } finally {
      legacy.close();
    }

    reopened = await openStorage({ rootDir });
    expect(reopened.schemaVersion).toBe(4);
    expect(
      reopened.readSchedulerBackendBinding(fixture.context.cycleId),
    ).toMatchObject({
      backend: "FAKE",
      qualification: "OFFLINE_ONLY",
      backendProtocol: "nr-fake-scheduler/1",
      bridgeVersionPin: "not_applicable",
      model: "deterministic-fake",
      reasoningEffort: "offline",
      runPlan: "NR08_FAKE_3X3",
      requiredRuns: 9,
    });
    expect(
      reopened.readSchedulerCycleStatus(fixture.context.cycleId),
    ).toMatchObject({ backend: "FAKE", requiredRuns: 9, state: "QUEUED" });
  } finally {
    reopened?.close();
    if (!storeClosed) {
      fixture.owner.release();
      fixture.store.close();
    }
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("finding output is durable provisional status and never semantic adjudication", async () => {
  const fixture = await createFixture();
  const findingRunId = stableRunId(fixture.context.cycleId, "correctness", 1);
  const backend = new FakeReviewerBackend({
    plans: new Map<string, FakeScenarioPlan>([
      [findingRunId, { scenario: "COMPLETE_WITH_FINDING" }],
    ]),
  });
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
  });
  try {
    scheduler.activateCycle(fixture.context);
    await scheduler.start();
    await waitFor(() => {
      const progress = fixture.store.readSchedulerCycleStatus(
        fixture.context.cycleId,
      );
      return (
        fixture.store.readCycle(fixture.context.cycleId).state ===
          "AGGREGATING" && progress.provisionalFindings.length === 1
      );
    });
    const progress = fixture.store.readSchedulerCycleStatus(
      fixture.context.cycleId,
    );
    expect(progress.state).toBe("AGGREGATING");
    expect(progress.backend).toBe("FAKE");
    expect(progress.qualification).toBe("OFFLINE_ONLY");
    expect(progress.provisionalFindings).toHaveLength(1);
    expect(progress.provisionalFindings[0]).toMatchObject({
      runId: findingRunId,
      localId: "fake-fixture-finding",
      finding: {
        title: "Deterministic fake finding",
      },
    });
    expect(
      fixture.store.readCanonicalFindings(fixture.context.cycleId),
    ).toEqual([]);

    const reviewRuntime = new DaemonReviewRuntime({
      store: fixture.store,
      owner: fixture.owner,
      trustedRepositoryIds: new Set(["fixture/project"]),
      snapshotService: emptySnapshotService(),
      scheduler,
      bindingProvider: () => versionHashBindingExample,
    });
    const status = (await reviewRuntime.invoke(
      "review_status",
      { reviewId: fixture.context.reviewId },
      "scheduler-status",
    )) as {
      progress: {
        completedRuns: number;
        requiredRuns: number;
        activeRuns: number;
      };
      scheduler: {
        backend: string;
        qualification: string;
        provisionalFindings: readonly { finding: { title: string } }[];
      };
    };
    expect(status.progress).toEqual({
      completedRuns: 9,
      requiredRuns: 9,
      activeRuns: 0,
    });
    expect(status.scheduler.backend).toBe("FAKE");
    expect(status.scheduler.qualification).toBe("OFFLINE_ONLY");
    expect(status.scheduler.provisionalFindings[0]?.finding.title).toBe(
      "Deterministic fake finding",
    );
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("retry preserves the run id and selects exactly one successful result", async () => {
  const fixture = await createFixture();
  const runId = stableRunId(fixture.context.cycleId, "correctness", 1);
  const backend = new FakeReviewerBackend({
    plans: new Map([
      [
        runId,
        {
          scenario: "TRANSIENT_ERROR",
          sequence: ["TRANSIENT_ERROR", "COMPLETE_WITH_FINDING"],
        },
      ],
    ]),
  });
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
    maxAttempts: 3,
  });
  try {
    scheduler.activateCycle(fixture.context);
    await scheduler.start();
    await waitFor(
      () =>
        fixture.store.readSchedulerCycleStatus(fixture.context.cycleId)
          .provisionalFindings.length === 1,
    );
    const events = fixture.store.readEventPage(fixture.context.cycleId).events;
    const attempts = events
      .filter((event) => event.eventType === "worker.attempt_appended")
      .map(
        (event) =>
          event.payload as { directionRunId: string; attemptId: string },
      )
      .filter((event) => event.directionRunId === runId);
    const attemptIds = attempts.map((attempt) => attempt.attemptId);
    const results = events
      .filter((event) => event.eventType === "worker.result_recorded")
      .map((event) => event.payload as { attemptId: string; selected: boolean })
      .filter((event) => attemptIds.includes(event.attemptId));
    const findings = events.filter(
      (event) =>
        event.eventType === "finding.raw_recorded" &&
        (event.payload as { runId?: string }).runId === runId,
    );
    expect(
      backend.invocationContexts.filter((item) => item.runId === runId),
    ).toHaveLength(2);
    expect(new Set(attemptIds).size).toBe(2);
    expect(results.filter((result) => result.selected)).toHaveLength(1);
    expect(findings).toHaveLength(1);
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("transient retries stop at the configured per-run limit", async () => {
  const clock = new VirtualClock(Date.now());
  const fixture = await createFixture(clock);
  const runId = stableRunId(fixture.context.cycleId, "correctness", 1);
  const backend = new FakeReviewerBackend({
    clock,
    plans: new Map([
      [
        runId,
        {
          scenario: "TRANSIENT_ERROR",
          sequence: ["TRANSIENT_ERROR"],
        },
      ],
    ]),
  });
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
    maxAttempts: 2,
    clock,
    maxBackoffMs: 1,
    jitter: () => 0.5,
  });
  try {
    scheduler.activateCycle(fixture.context);
    await scheduler.start();
    await waitFor(
      () =>
        fixture.store.readSchedulerCycleStatus(fixture.context.cycleId)
          .retryWaitingRuns === 1,
    );
    clock.advanceBy(2);
    await waitFor(
      () => fixture.store.readCycle(fixture.context.cycleId).state === "FAILED",
    );
    const attempts = backend.invocationInputs.filter(
      (input) => input.claim.runId === runId,
    );
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((input) => input.claim.attemptId)).size).toBe(
      2,
    );
    expect(
      fixture.store
        .readEventPage(fixture.context.cycleId)
        .events.filter((event) => event.eventType === "scheduler.retry_wait")
        .map((event) => event.payload as { runId?: string })
        .filter((payload) => payload.runId === runId),
    ).toHaveLength(1);
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("global concurrency one fairly advances both review queues", async () => {
  const clock = new VirtualClock(Date.now());
  const fixture = await createFixture(clock);
  const second = await createReviewingCycle(
    fixture.store,
    fixture.owner,
    "fairness-second",
  );
  const backend = new FakeReviewerBackend({ clock });
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
    concurrency: 1,
    clock,
  });
  try {
    scheduler.activateCycle(fixture.context);
    scheduler.activateCycle(second);
    await scheduler.start();
    await waitFor(
      () =>
        fixture.store.readCycle(fixture.context.cycleId).state === "APPROVED" &&
        fixture.store.readCycle(second.cycleId).state === "APPROVED",
    );
    expect(backend.invocationContexts[0]?.cycleId).not.toBe(
      backend.invocationContexts[1]?.cycleId,
    );
    expect(backend.maxObservedConcurrency).toBe(1);
    expect(scheduler.maxObservedConcurrency).toBeLessThanOrEqual(1);
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("concurrency cap holds when multiple delayed fake turns are eligible", async () => {
  const clock = new VirtualClock(Date.now());
  const fixture = await createFixture(clock);
  const plans = new Map<string, FakeScenarioPlan>();
  for (const replicaIndex of [1, 2]) {
    plans.set(
      stableRunId(fixture.context.cycleId, "correctness", replicaIndex),
      { scenario: "DELAYED", delayMs: 10 },
    );
  }
  const backend = new FakeReviewerBackend({ plans, clock });
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
    concurrency: 2,
    clock,
    attemptTimeoutMs: 1_000,
    leaseTtlMs: 2_000,
  });
  try {
    scheduler.activateCycle(fixture.context);
    await scheduler.start();
    await waitFor(() => backend.maxObservedConcurrency === 2);
    clock.advanceBy(10);
    await waitFor(
      () =>
        fixture.store.readCycle(fixture.context.cycleId).state === "APPROVED",
    );
    expect(backend.maxObservedConcurrency).toBeLessThanOrEqual(2);
    expect(scheduler.maxObservedConcurrency).toBeLessThanOrEqual(2);
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("authentication, policy, permanent, and malformed outcomes have no retry", async () => {
  const fixture = await createFixture();
  const scenarios = [
    ["correctness", 1, "AUTHENTICATION_ERROR"],
    ["correctness", 2, "POLICY_ERROR"],
    ["correctness", 3, "PERMANENT_ERROR"],
    ["tests", 1, "PARTIAL_OR_MALFORMED"],
    ["design", 1, "TRANSIENT_ERROR"],
  ] as const;
  const plans = new Map<string, FakeScenarioPlan>();
  for (const [direction, replicaIndex, scenario] of scenarios) {
    plans.set(stableRunId(fixture.context.cycleId, direction, replicaIndex), {
      scenario,
    });
  }
  plans.set(stableRunId(fixture.context.cycleId, "design", 1), {
    scenario: "TRANSIENT_ERROR",
    errorClass: "AUTHENTICATION",
  });
  const backend = new FakeReviewerBackend({ plans });
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
  });
  try {
    scheduler.activateCycle(fixture.context);
    await scheduler.start();
    await waitFor(
      () => fixture.store.readCycle(fixture.context.cycleId).state === "FAILED",
    );
    const events = fixture.store.readEventPage(fixture.context.cycleId).events;
    for (const directionRunId of plans.keys()) {
      expect(
        backend.invocationContexts.filter(
          (item) => item.runId === directionRunId,
        ),
      ).toHaveLength(1);
    }
    expect(fixture.store.readCycle(fixture.context.cycleId).state).not.toBe(
      "APPROVED",
    );
    expect(
      events.some(
        (event) =>
          event.eventType === "scheduler.run_failed" &&
          (event.payload as { backend?: string }).backend === "FAKE",
      ),
    ).toBe(true);
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("unknown send is reconciled and never blindly re-enqueued", async () => {
  const fixture = await createFixture();
  const runId = stableRunId(fixture.context.cycleId, "correctness", 1);
  const backend = new FakeReviewerBackend({
    plans: new Map([
      [
        runId,
        {
          scenario: "UNKNOWN_SEND",
          reconciliation: "STILL_UNKNOWN",
        },
      ],
    ]),
  });
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
    maxBackoffMs: 1,
    jitter: () => 1,
  });
  try {
    scheduler.activateCycle(fixture.context);
    await scheduler.start();
    await waitFor(() => {
      const status = fixture.store.readSchedulerCycleStatus(
        fixture.context.cycleId,
      );
      return (
        backend.reconciliationCount === 3 &&
        status.completedRuns === 8 &&
        status.reconciliationRequiredRuns === 1
      );
    });
    expect(
      backend.invocationContexts.filter((item) => item.runId === runId),
    ).toHaveLength(1);
    expect(fixture.store.readCycle(fixture.context.cycleId).state).toBe(
      "REVIEWING",
    );
    expect(
      fixture.store.readSchedulerCycleStatus(fixture.context.cycleId),
    ).toMatchObject({
      completedRuns: 8,
      requiredRuns: 9,
      reconciliationRequiredRuns: 1,
    });
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("proven-unsent and accepted-result reconciliation each ingest once", async () => {
  const fixture = await createFixture();
  const unsentRun = stableRunId(fixture.context.cycleId, "correctness", 1);
  const acceptedRun = stableRunId(fixture.context.cycleId, "tests", 1);
  const backend = new FakeReviewerBackend({
    plans: new Map([
      [
        unsentRun,
        {
          scenario: "UNKNOWN_SEND",
          sequence: ["UNKNOWN_SEND", "COMPLETE_NO_FINDINGS"],
          reconciliation: "PROVEN_UNSENT",
        },
      ],
      [
        acceptedRun,
        {
          scenario: "UNKNOWN_SEND",
          reconciliation: "PROVEN_ACCEPTED_WITH_RESULT",
        },
      ],
    ]),
  });
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
    maxBackoffMs: 1,
    jitter: () => 1,
  });
  try {
    scheduler.activateCycle(fixture.context);
    await scheduler.start();
    await waitFor(
      () =>
        fixture.store.readCycle(fixture.context.cycleId).state === "APPROVED",
    );
    const selected = fixture.store.readSchedulerSelectedRuns(
      fixture.context.cycleId,
    );
    expect(selected).toHaveLength(9);
    expect(
      backend.invocationContexts.filter((item) => item.runId === unsentRun),
    ).toHaveLength(2);
    expect(
      backend.invocationContexts.filter((item) => item.runId === acceptedRun),
    ).toHaveLength(1);
    expect(backend.reconciliationCount).toBe(2);
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("queued cancellation makes no backend invocation", async () => {
  const fixture = await createFixture();
  const backend = new FakeReviewerBackend();
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
  });
  try {
    scheduler.activateCycle(fixture.context);
    const current = fixture.store.readReview(fixture.context.reviewId);
    fixture.store.applyCycleCommand(
      "test-caller",
      current.cycleId,
      {
        type: "REQUEST_CANCEL",
        reason: "Cancel before fake worker dispatch.",
        expectedVersion: current.stateVersion,
        idempotencyKey: "cancel-queued",
      },
      { ownerFencing: fixture.owner.fencingToken(), occurredAtUtc: nowUtc() },
    );
    await scheduler.cancelCycle(current.cycleId);
    const cancelRequested = fixture.store.readReview(current.reviewId);
    fixture.store.applyCycleCommand(
      "test-caller",
      current.cycleId,
      {
        type: "CONFIRM_CANCEL",
        fencingAndRevocationConfirmed: true,
        expectedVersion: cancelRequested.stateVersion,
        idempotencyKey: "confirm-cancel-queued",
      },
      { ownerFencing: fixture.owner.fencingToken(), occurredAtUtc: nowUtc() },
    );
    expect(backend.invocationContexts).toHaveLength(0);
    expect(fixture.store.readSchedulerCycleStatus(current.cycleId).state).toBe(
      "CANCELLED",
    );
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("cancellation preserves a backend's proven-unsent send state", async () => {
  const fixture = await createFixture();
  const backend = new DeferredFakeBackend({ reportUnsent: true });
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
    concurrency: 1,
  });
  try {
    scheduler.activateCycle(fixture.context);
    await scheduler.start();
    const invocation = await backend.started;
    const current = fixture.store.readReview(fixture.context.reviewId);
    fixture.store.applyCycleCommand(
      "test-caller",
      current.cycleId,
      {
        type: "REQUEST_CANCEL",
        reason: "Cancel after the LIVE preflight but before the POST boundary.",
        expectedVersion: current.stateVersion,
        idempotencyKey: "cancel-proven-unsent",
      },
      { ownerFencing: fixture.owner.fencingToken(), occurredAtUtc: nowUtc() },
    );

    await scheduler.cancelCycle(current.cycleId);

    expect(
      fixture.store.readSchedulerAttemptProvenance(invocation.claim.attemptId)
        .sendState,
    ).toBe("UNSENT");
    expect(
      fixture.store.readSchedulerCycleStatus(current.cycleId),
    ).toMatchObject({ state: "CANCELLED", reconciliationRequiredRuns: 0 });

    const cancelRequested = fixture.store.readReview(current.reviewId);
    fixture.store.applyCycleCommand(
      "test-caller",
      current.cycleId,
      {
        type: "CONFIRM_CANCEL",
        fencingAndRevocationConfirmed: true,
        expectedVersion: cancelRequested.stateVersion,
        idempotencyKey: "confirm-cancel-proven-unsent",
      },
      { ownerFencing: fixture.owner.fencingToken(), occurredAtUtc: nowUtc() },
    );
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("in-flight late output is retained as obsolete after cancellation", async () => {
  const clock = new VirtualClock(Date.now());
  const fixture = await createFixture(clock);
  const backend = new DeferredFakeBackend();
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
    concurrency: 1,
    clock,
  });
  try {
    scheduler.activateCycle(fixture.context);
    await scheduler.start();
    const invocation = await backend.started;
    const current = fixture.store.readReview(fixture.context.reviewId);
    fixture.store.applyCycleCommand(
      "test-caller",
      current.cycleId,
      {
        type: "REQUEST_CANCEL",
        reason: "Cancel while one fake turn is in flight.",
        expectedVersion: current.stateVersion,
        idempotencyKey: "cancel-in-flight",
      },
      { ownerFencing: fixture.owner.fencingToken(), occurredAtUtc: nowUtc() },
    );
    const cancelPromise = scheduler.cancelCycle(current.cycleId);
    backend.resolve(invocation);
    await cancelPromise;
    const cancelRequested = fixture.store.readReview(current.reviewId);
    fixture.store.applyCycleCommand(
      "test-caller",
      current.cycleId,
      {
        type: "CONFIRM_CANCEL",
        fencingAndRevocationConfirmed: true,
        expectedVersion: cancelRequested.stateVersion,
        idempotencyKey: "confirm-cancel-in-flight",
      },
      { ownerFencing: fixture.owner.fencingToken(), occurredAtUtc: nowUtc() },
    );
    const events = fixture.store.readEventPage(current.cycleId).events;
    expect(fixture.store.readCycle(current.cycleId).state).toBe("CANCELLED");
    expect(
      events.some(
        (event) => event.eventType === "scheduler.late_result_obsolete",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.eventType === "worker.result_recorded" &&
          (event.payload as { selected?: boolean }).selected === true,
      ),
    ).toBe(false);
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("cancellation returns when an invocation ignores AbortSignal", async () => {
  const clock = new VirtualClock(Date.now());
  const fixture = await createFixture(clock);
  const backend = new NonCooperativeFakeBackend(
    new FakeReviewerBackend({ clock }),
    { hangFirstInvocation: true },
  );
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
    concurrency: 1,
    attemptTimeoutMs: 1_000,
    leaseTtlMs: 2_000,
    reviewDeadlineMs: 5_000,
    clock,
  });
  try {
    scheduler.activateCycle(fixture.context);
    await scheduler.start();
    const invocation = await backend.hangingInvocation;
    const current = fixture.store.readReview(fixture.context.reviewId);
    fixture.store.applyCycleCommand(
      "test-caller",
      current.cycleId,
      {
        type: "REQUEST_CANCEL",
        reason: "Cancel a non-cooperative fake backend turn.",
        expectedVersion: current.stateVersion,
        idempotencyKey: "cancel-non-cooperative",
      },
      {
        ownerFencing: fixture.owner.fencingToken(),
        occurredAtUtc: new Date(clock.nowMs()).toISOString(),
      },
    );

    expect(
      await completesWithin(scheduler.cancelCycle(current.cycleId), 250),
    ).toBe(true);
    const cancelRequested = fixture.store.readReview(current.reviewId);
    fixture.store.applyCycleCommand(
      "test-caller",
      current.cycleId,
      {
        type: "CONFIRM_CANCEL",
        fencingAndRevocationConfirmed: true,
        expectedVersion: cancelRequested.stateVersion,
        idempotencyKey: "confirm-cancel-non-cooperative",
      },
      {
        ownerFencing: fixture.owner.fencingToken(),
        occurredAtUtc: new Date(clock.nowMs()).toISOString(),
      },
    );
    expect(fixture.store.readCycle(current.cycleId).state).toBe("CANCELLED");

    const priorObsoleteEvents = fixture.store
      .readEventPage(current.cycleId)
      .events.filter(
        (event) => event.eventType === "scheduler.late_result_obsolete",
      ).length;
    backend.resolveHungInvocation(invocation);
    await waitFor(
      () =>
        fixture.store
          .readEventPage(current.cycleId)
          .events.filter(
            (event) => event.eventType === "scheduler.late_result_obsolete",
          ).length > priorObsoleteEvents,
    );
    expect(
      hasSelectedWorkerResult(
        fixture.store,
        current.cycleId,
        invocation.claim.attemptId,
      ),
    ).toBe(false);
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("timed-out invocation releases the scheduler slot for queued work", async () => {
  const clock = new VirtualClock(Date.now());
  const fixture = await createFixture(clock);
  const second = await createReviewingCycle(
    fixture.store,
    fixture.owner,
    "deadline-fairness-second",
    clock,
  );
  const backend = new NonCooperativeFakeBackend(
    new FakeReviewerBackend({ clock }),
    { hangFirstInvocation: true },
  );
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
    concurrency: 1,
    maxAttempts: 1,
    attemptTimeoutMs: 5,
    leaseTtlMs: 1_000,
    reviewDeadlineMs: 10_000,
    maxBackoffMs: 1,
    jitter: () => 1,
    clock,
  });
  try {
    scheduler.activateCycle(fixture.context);
    scheduler.activateCycle(second);
    await scheduler.start();
    const invocation = await backend.hangingInvocation;
    clock.advanceBy(5);
    await waitFor(() =>
      backend.delegatedInvocations.some(
        (input) => input.claim.cycleId !== invocation.claim.cycleId,
      ),
    );

    expect(scheduler.maxObservedConcurrency).toBe(1);
    expect(
      fixture.store.readSchedulerCycleStatus(invocation.claim.cycleId)
        .reconciliationRequiredRuns,
    ).toBeGreaterThan(0);
    expect(
      backend.delegatedInvocations.some(
        (input) => input.claim.cycleId === second.cycleId,
      ) || invocation.claim.cycleId === second.cycleId,
    ).toBe(true);
    backend.resolveHungInvocation(invocation);
    await waitFor(() =>
      fixture.store
        .readEventPage(invocation.claim.cycleId)
        .events.some(
          (event) => event.eventType === "scheduler.late_result_obsolete",
        ),
    );
    expect(
      hasSelectedWorkerResult(
        fixture.store,
        invocation.claim.cycleId,
        invocation.claim.attemptId,
      ),
    ).toBe(false);
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("late duplicate output cannot mutate an approved cycle", async () => {
  const fixture = await createFixture();
  const backend = new FakeReviewerBackend();
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
  });
  try {
    scheduler.activateCycle(fixture.context);
    await scheduler.start();
    await waitFor(
      () =>
        fixture.store.readCycle(fixture.context.cycleId).state === "APPROVED",
    );
    const completed = backend.invocationInputs[0];
    if (completed === undefined)
      throw new Error("Expected a completed fake turn.");
    expect(await replayLateSuccess(fixture, completed)).toBe(false);
    expect(fixture.store.readCycle(fixture.context.cycleId).state).toBe(
      "APPROVED",
    );
    expect(
      fixture.store
        .readEventPage(fixture.context.cycleId)
        .events.some(
          (event) => event.eventType === "scheduler.late_result_obsolete",
        ),
    ).toBe(true);
    expect(
      fixture.store.readSchedulerSelectedRuns(fixture.context.cycleId),
    ).toHaveLength(9);
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("late duplicate output cannot mutate a failed cycle", async () => {
  const fixture = await createFixture();
  const failedRunId = stableRunId(fixture.context.cycleId, "correctness", 1);
  const backend = new FakeReviewerBackend({
    plans: new Map([[failedRunId, { scenario: "PERMANENT_ERROR" }]]),
  });
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
  });
  try {
    scheduler.activateCycle(fixture.context);
    await scheduler.start();
    await waitFor(
      () => fixture.store.readCycle(fixture.context.cycleId).state === "FAILED",
    );
    const completed = backend.invocationInputs.find(
      (input) => input.claim.runId !== failedRunId,
    );
    if (completed === undefined)
      throw new Error("Expected a completed fake turn.");
    expect(await replayLateSuccess(fixture, completed)).toBe(false);
    expect(fixture.store.readCycle(fixture.context.cycleId).state).toBe(
      "FAILED",
    );
    expect(
      fixture.store
        .readEventPage(fixture.context.cycleId)
        .events.some(
          (event) => event.eventType === "scheduler.late_result_obsolete",
        ),
    ).toBe(true);
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("queued jobs survive SQLite restart and expired leases get a new fence", async () => {
  const fixture = await createFixture();
  let scheduler: DurableScheduler | undefined;
  let reopened: SqliteStorage | undefined;
  try {
    scheduler = new DurableScheduler({
      store: fixture.store,
      owner: fixture.owner,
      backend: new FakeReviewerBackend(),
    });
    scheduler.activateCycle(fixture.context);
    const firstAttemptAt = nowUtc();
    const retry = fixture.store.claimNextSchedulerJob({
      ownerFencing: fixture.owner.fencingToken(),
      nowUtc: firstAttemptAt,
      leaseTtlMs: 1_000,
      attemptTimeoutMs: 500,
    });
    if (retry === undefined)
      throw new Error("Expected an initial scheduler turn.");
    const retryArtifact = await fixture.store.persistRawArtifact(
      Buffer.from("FAKE/OFFLINE transient failure", "utf8"),
    );
    await fixture.store.finishSchedulerAttempt({
      runId: retry.runId,
      attemptId: retry.attemptId,
      ownerFencing: fixture.owner.fencingToken(),
      lease: retry.lease,
      outcome: "RETRYABLE_FAILURE",
      errorClass: "TRANSIENT",
      rawArtifact: retryArtifact,
      retryAtUtc: new Date(Date.parse(firstAttemptAt) + 10_000).toISOString(),
      occurredAtUtc: firstAttemptAt,
    });
    const root = fixture.store.rootDir;
    fixture.owner.release();
    fixture.store.close();
    reopened = await openStorage({ rootDir: root });
    const owner = DaemonOwner.acquire(reopened);
    try {
      expect(
        reopened.readSchedulerCycleStatus(fixture.context.cycleId),
      ).toMatchObject({
        requiredRuns: 9,
        completedRuns: 0,
        retryWaitingRuns: 1,
      });
      const now = nowUtc();
      const original = reopened.claimNextSchedulerJob({
        ownerFencing: owner.fencingToken(),
        nowUtc: now,
        leaseTtlMs: 100,
        attemptTimeoutMs: 50,
      });
      if (original === undefined)
        throw new Error("Expected a scheduler turn claim.");
      const later = new Date(Date.parse(now) + 101).toISOString();
      const recovered = reopened.claimNextSchedulerJob({
        ownerFencing: owner.fencingToken(),
        nowUtc: later,
        leaseTtlMs: 500,
        attemptTimeoutMs: 50,
      });
      if (recovered === undefined)
        throw new Error("Expired lease was not recovered.");
      expect(recovered.workKind).toBe("RECONCILIATION");
      expect(recovered.attemptId).toBe(original.attemptId);
      expect(recovered.lease.token).toBeGreaterThan(original.lease.token);
      expect(recovered.runId).toBe(original.runId);
      const staleArtifact = await reopened.persistRawArtifact(
        Buffer.from(
          "FAKE/OFFLINE stale completion after lease recovery",
          "utf8",
        ),
      );
      expect(
        await reopened.finishSchedulerAttempt({
          runId: original.runId,
          attemptId: original.attemptId,
          ownerFencing: owner.fencingToken(),
          lease: original.lease,
          outcome: "MALFORMED",
          errorClass: "INVALID_SCHEMA",
          rawArtifact: staleArtifact,
          occurredAtUtc: later,
        }),
      ).toBe(false);
      expect(
        reopened
          .readEventPage(fixture.context.cycleId)
          .events.some(
            (event) => event.eventType === "scheduler.late_result_obsolete",
          ),
      ).toBe(true);
      expect(reopened.integrityCheck()).toEqual({
        integrity: "ok",
        foreignKeyViolations: 0,
      });
    } finally {
      owner.release();
    }
  } finally {
    scheduler = undefined;
    reopened?.close();
    await rm(fixture.temporary, { recursive: true, force: true });
  }
});

test("deadline uses an injected clock and ends in explicit reconciliation/failure", async () => {
  const clock = new VirtualClock(Date.now());
  const fixture = await createFixture(clock);
  const delayedRun = stableRunId(fixture.context.cycleId, "correctness", 1);
  const backend = new FakeReviewerBackend({
    clock,
    plans: new Map([[delayedRun, { scenario: "DELAYED", delayMs: 10 }]]),
  });
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
    clock,
    concurrency: 1,
    maxAttempts: 1,
    attemptTimeoutMs: 5,
    leaseTtlMs: 1_000,
    maxBackoffMs: 1,
    jitter: () => 1,
  });
  try {
    scheduler.activateCycle(fixture.context);
    await scheduler.start();
    await waitFor(() => backend.activeInvocations === 1);
    clock.advanceBy(5);
    await waitFor(
      () => fixture.store.readCycle(fixture.context.cycleId).state === "FAILED",
    );
    expect(backend.reconciliationCount).toBe(1);
    expect(
      fixture.store.readSchedulerCycleStatus(fixture.context.cycleId)
        .failedRuns,
    ).toBe(1);
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("timed-out reconciliation releases the slot and fences its late result", async () => {
  const clock = new VirtualClock(Date.now());
  const fixture = await createFixture(clock);
  const unknownRunId = stableRunId(fixture.context.cycleId, "correctness", 1);
  const delegate = new FakeReviewerBackend({
    clock,
    plans: new Map([[unknownRunId, { scenario: "UNKNOWN_SEND" }]]),
  });
  const backend = new NonCooperativeFakeBackend(delegate, {
    hangFirstReconciliation: true,
  });
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
    concurrency: 1,
    maxAttempts: 1,
    attemptTimeoutMs: 5,
    leaseTtlMs: 1_000,
    reviewDeadlineMs: 10_000,
    maxBackoffMs: 1,
    jitter: () => 1,
    clock,
  });
  try {
    scheduler.activateCycle(fixture.context);
    await scheduler.start();
    const reconciliation = await backend.hangingReconciliation;
    clock.advanceBy(5);
    await waitFor(() => backend.invocationCount >= 2);

    expect(scheduler.maxObservedConcurrency).toBe(1);
    backend.resolveHungReconciliation(reconciliation);
    await waitFor(() =>
      fixture.store
        .readEventPage(fixture.context.cycleId)
        .events.some(
          (event) =>
            event.eventType === "scheduler.late_result_obsolete" &&
            (event.payload as { reconciliationOutcome?: string })
              .reconciliationOutcome === "PROVEN_ACCEPTED_WITH_RESULT",
        ),
    );
    expect(
      hasSelectedWorkerResult(
        fixture.store,
        reconciliation.claim.cycleId,
        reconciliation.claim.attemptId,
      ),
    ).toBe(false);
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("drain returns within its deadline when an invocation ignores abort", async () => {
  const clock = new VirtualClock(Date.now());
  const fixture = await createFixture(clock);
  const backend = new NonCooperativeFakeBackend(
    new FakeReviewerBackend({ clock }),
    { hangFirstInvocation: true },
  );
  const scheduler = new DurableScheduler({
    store: fixture.store,
    owner: fixture.owner,
    backend,
    concurrency: 1,
    attemptTimeoutMs: 1_000,
    leaseTtlMs: 2_000,
    reviewDeadlineMs: 5_000,
    drainTimeoutMs: 5,
    clock,
  });
  try {
    scheduler.activateCycle(fixture.context);
    await scheduler.start();
    const invocation = await backend.hangingInvocation;
    const drain = scheduler.drain(5);
    clock.advanceBy(5);
    expect(await completesWithin(drain, 250)).toBe(true);

    backend.resolveHungInvocation(invocation);
    await waitFor(() =>
      fixture.store
        .readEventPage(fixture.context.cycleId)
        .events.some(
          (event) => event.eventType === "scheduler.late_result_obsolete",
        ),
    );
  } finally {
    await closeFixture(fixture, scheduler);
  }
});

test("policy classification retries only known-unsent transient failures", () => {
  expect(classifyBackendFailure("AUTHENTICATION", "UNSENT")).toBe("FAIL");
  expect(classifyBackendFailure("POLICY", "UNSENT")).toBe("FAIL");
  expect(classifyBackendFailure("INVALID_SCHEMA", "UNSENT")).toBe("FAIL");
  expect(classifyBackendFailure("PERMANENT", "UNSENT")).toBe("FAIL");
  expect(classifyBackendFailure("TRANSIENT", "UNSENT")).toBe("RETRY");
  expect(classifyBackendFailure("RATE_LIMIT", "SENT")).toBe("RECONCILE");
  expect(classifyBackendFailure("DEADLINE", "UNKNOWN")).toBe("RECONCILE");
});

interface Fixture {
  readonly temporary: string;
  readonly store: SqliteStorage;
  readonly owner: DaemonOwner;
  readonly context: SnapshotCycleContext;
}

class MockLiveQualificationBackend implements ReviewerBackend {
  readonly backend = "LIVE" as const;
  readonly profile: ReviewerBackend["profile"];

  constructor(
    private readonly store: SqliteStorage,
    configurationDigest = "a".repeat(64),
  ) {
    this.profile = {
      backend: "LIVE",
      backendProtocol: "chatgpt-web-responses/1",
      bridgeVersionPin: "6.1.3",
      model: "chatgpt-web/gpt-5.6-sol",
      reasoningEffort: "high",
      qualification: "LIVE_PRODUCTION_BRIDGE",
      configurationDigest,
      runPlan: "NR09_LIVE_QUALIFICATION",
      requiredRuns: 1,
    };
  }

  promptForRun(_context: SchedulerPromptContext): string {
    return "NR-09 mocked live qualification test prompt.";
  }

  async invoke(
    input: BackendInvocationInput,
  ): Promise<BackendInvocationResult> {
    const output = fakeWorkerOutput(input.context, input.claim);
    const rawBytes = Buffer.from(JSON.stringify(output), "utf8");
    const rawArtifact = await this.store.persistRawArtifact(rawBytes);
    const turnArtifact = {
      purpose: "TURN_RESPONSE" as const,
      reference: rawArtifact,
    };
    const receipt: BackendTurnReceipt = {
      schemaVersion: "nr-backend-turn-receipt/1",
      backend: "LIVE",
      qualification: "LIVE_PRODUCTION_BRIDGE",
      reviewId: input.context.reviewId,
      cycleId: input.context.cycleId,
      runId: input.context.runId,
      attemptId: input.claim.attemptId,
      direction: input.context.direction,
      objectFormat: input.context.objectFormat,
      reviewedBaseSha: input.context.baseSha,
      reviewedHeadSha: input.context.headSha,
      promptHash: input.context.promptHash,
      schemaHash: input.context.schemaHash,
      policyHash: input.context.policyHash,
      bridge: {
        service: "codex-chatgpt-web",
        pid: 4242,
        version: this.profile.bridgeVersionPin,
        mode: "full",
      },
      model: {
        requested: this.profile.model,
        observed: this.profile.model,
        reasoningEffortRequested: this.profile.reasoningEffort,
        reasoningEffortObserved: this.profile.reasoningEffort,
        advertisedReasoningEfforts: [this.profile.reasoningEffort],
      },
      session: {
        threadId: "nr09-mock-thread",
        turnIds: ["nr09-mock-turn"],
        responseIds: ["nr09-mock-response"],
        freshForAttempt: true,
      },
      outcome: "COMPLETED",
      sendState: "SENT",
      rawArtifacts: [turnArtifact],
      generatedAtUtc: nowUtc(),
    };
    const receiptArtifact = await this.store.persistRawArtifact(
      Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8"),
    );
    return {
      kind: "SUCCESS",
      output,
      rawBytes,
      sendState: "SENT",
      receipt,
      receiptArtifact,
      primaryRawArtifact: rawArtifact,
      rawArtifacts: [turnArtifact],
    };
  }

  async reconcile(): Promise<BackendReconciliationResult> {
    return { kind: "STILL_UNKNOWN" };
  }
}

async function createFixture(clock?: SchedulerClock): Promise<Fixture> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "nr08-scheduler-"));
  const store = await openStorage({ rootDir: path.join(temporary, "store") });
  const owner = DaemonOwner.acquire(store, {
    ownerId: `scheduler-owner-${randomUUID()}`,
    ...(clock === undefined
      ? {}
      : {
          now: () => new Date(clock.nowMs()).toISOString(),
          ttlMs: 3_600_000,
          renewalIntervalMs: 1_800_000,
          startHeartbeat: false,
        }),
  });
  const context = await createReviewingCycle(
    store,
    owner,
    `scheduler-${randomUUID()}`,
    clock,
  );
  return { temporary, store, owner, context };
}

async function createReviewingCycle(
  store: SqliteStorage,
  owner: DaemonOwner,
  idempotencyKey: string,
  clock?: SchedulerClock,
): Promise<SnapshotCycleContext> {
  const now =
    clock === undefined ? nowUtc() : new Date(clock.nowMs()).toISOString();
  const submit: ReviewSubmitInput = {
    ...strictInput,
    idempotencyKey,
  };
  const created = await store.createReview({
    callerId: "test-caller",
    submission: submit,
    reviewContextHash: protocolExampleSha256,
    versionBinding: versionHashBindingExample,
    createdAtUtc: now,
    fencing: owner.fencingToken(),
  });
  store.applyCycleCommand(
    "test-caller",
    created.cycleId,
    {
      type: "ADVANCE",
      target: "SNAPSHOTTING",
      expectedVersion: 0,
      idempotencyKey: `${idempotencyKey}-snapshot`,
    },
    { ownerFencing: owner.fencingToken(), occurredAtUtc: now },
  );
  const cycle = store.readCycle(created.cycleId);
  const manifest = {
    snapshotId: `snapshot-${created.cycleId}`,
    cycleId: created.cycleId,
    repoId: submit.repoId,
    objectFormat: cycle.revisions.objectFormat,
    baseSha: cycle.revisions.baseSha,
    headSha: cycle.revisions.headSha,
    coverage: { complete: true, limitations: [] },
    changes: [],
  } as unknown as ProtocolJsonValue;
  const manifestHash = hashCanonicalJson(manifest);
  store.recordSnapshot({
    snapshotId: `snapshot-${created.cycleId}`,
    cycleId: created.cycleId,
    objectFormat: cycle.revisions.objectFormat,
    baseSha: cycle.revisions.baseSha,
    headSha: cycle.revisions.headSha,
    manifestHash,
    manifest,
    createdAtUtc: now,
  });
  store.applyCycleCommand(
    "test-caller",
    created.cycleId,
    {
      type: "ADVANCE",
      target: "REVIEWING",
      expectedVersion: 1,
      idempotencyKey: `${idempotencyKey}-reviewing`,
      evidence: { durableManifestRecorded: true, manifestHash },
    },
    { ownerFencing: owner.fencingToken(), occurredAtUtc: now },
  );
  return store.readSnapshotCycleContext(created.cycleId);
}

async function closeFixture(
  fixture: Fixture,
  scheduler?: DurableScheduler,
): Promise<void> {
  await scheduler?.drain(250);
  fixture.owner.release();
  fixture.store.close();
  await rm(fixture.temporary, { recursive: true, force: true });
}

async function replayLateSuccess(
  fixture: Fixture,
  input: BackendInvocationInput,
): Promise<boolean> {
  const output = fakeWorkerOutput(input.context, input.claim);
  const rawArtifact = await fixture.store.persistRawArtifact(
    Buffer.from(
      JSON.stringify({
        backend: "FAKE",
        qualification: "OFFLINE_ONLY",
        output,
      }),
      "utf8",
    ),
  );
  return fixture.store.finishSchedulerAttempt({
    runId: input.claim.runId,
    attemptId: input.claim.attemptId,
    ownerFencing: fixture.owner.fencingToken(),
    lease: input.claim.lease,
    outcome: "SUCCESS",
    parsedResult: output,
    rawArtifact,
    occurredAtUtc: nowUtc(),
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for scheduler test condition.");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

function hasSelectedWorkerResult(
  store: SqliteStorage,
  cycleId: string,
  attemptId: string,
): boolean {
  return store
    .readEventPage(cycleId)
    .events.some(
      (event) =>
        event.eventType === "worker.result_recorded" &&
        (event.payload as { attemptId?: string; selected?: boolean })
          .attemptId === attemptId &&
        (event.payload as { selected?: boolean }).selected === true,
    );
}

async function completesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function stableRunId(
  cycleId: string,
  direction: WorkerDirection,
  replicaIndex: number,
): string {
  const digest = createHash("sha256")
    .update(`${cycleId}:${direction}:${String(replicaIndex)}`)
    .digest("hex");
  return `run-${digest.slice(0, 32)}`;
}

function nowUtc(): string {
  return new Date().toISOString();
}

class VirtualClock implements SchedulerClock {
  private currentMs: number;
  private readonly waiters = new Set<{
    readonly deadline: number;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly signal: AbortSignal | undefined;
    readonly onAbort: (() => void) | undefined;
  }>();

  constructor(startMs: number) {
    this.currentMs = startMs;
  }

  nowMs(): number {
    return this.currentMs;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort =
        signal === undefined
          ? undefined
          : () => {
              this.waiters.delete(waiter);
              reject(abortError());
            };
      const waiter = {
        deadline: this.currentMs + ms,
        resolve: () => {
          signal?.removeEventListener("abort", onAbort as () => void);
          resolve();
        },
        reject,
        signal,
        onAbort,
      };
      this.waiters.add(waiter);
      signal?.addEventListener("abort", onAbort as () => void, { once: true });
    });
  }

  advanceBy(ms: number): void {
    this.currentMs += ms;
    for (const waiter of [...this.waiters]) {
      if (waiter.deadline <= this.currentMs) {
        this.waiters.delete(waiter);
        waiter.resolve();
      }
    }
  }
}

class DeferredFakeBackend implements ReviewerBackend {
  readonly backend = "FAKE" as const;
  readonly profile = new FakeReviewerBackend().profile;
  private notifyStarted!: (input: BackendInvocationInput) => void;
  private notifyResult!: (result: BackendInvocationResult) => void;
  readonly started: Promise<BackendInvocationInput>;
  private readonly result: Promise<BackendInvocationResult>;

  constructor(
    private readonly options: { readonly reportUnsent?: boolean } = {},
  ) {
    this.started = new Promise((resolve) => {
      this.notifyStarted = resolve;
    });
    this.result = new Promise((resolve) => {
      this.notifyResult = resolve;
    });
  }

  promptForRun(_context: Parameters<FakeReviewerBackend["promptForRun"]>[0]) {
    return NR08_FAKE_PROMPT;
  }

  async invoke(
    input: BackendInvocationInput,
  ): Promise<BackendInvocationResult> {
    if (this.options.reportUnsent) input.reportSendState?.("UNSENT");
    this.notifyStarted(input);
    return this.result;
  }

  async reconcile(): Promise<BackendReconciliationResult> {
    return { kind: "STILL_UNKNOWN" };
  }

  resolve(input: BackendInvocationInput): void {
    const output = fakeWorkerOutput(input.context, input.claim);
    this.notifyResult({
      kind: "SUCCESS",
      output,
      rawBytes: Buffer.from(
        JSON.stringify({
          backend: "FAKE",
          qualification: "OFFLINE_ONLY",
          output,
        }),
        "utf8",
      ),
    });
  }
}

class NonCooperativeFakeBackend implements ReviewerBackend {
  readonly backend = "FAKE" as const;
  readonly profile: FakeReviewerBackend["profile"];
  readonly hangingInvocation: Promise<BackendInvocationInput>;
  readonly hangingReconciliation: Promise<BackendInvocationInput>;
  readonly delegatedInvocations: BackendInvocationInput[] = [];
  invocationCount = 0;
  delegatedInvocationCount = 0;
  reconciliationCount = 0;
  private notifyHangingInvocation!: (input: BackendInvocationInput) => void;
  private notifyHangingReconciliation!: (input: BackendInvocationInput) => void;
  private resolveInvocation:
    | ((result: BackendInvocationResult) => void)
    | undefined;
  private resolveReconciliation:
    | ((result: BackendReconciliationResult) => void)
    | undefined;

  constructor(
    private readonly delegate: FakeReviewerBackend,
    private readonly options: {
      readonly hangFirstInvocation?: boolean;
      readonly hangFirstReconciliation?: boolean;
    } = {},
  ) {
    this.profile = delegate.profile;
    this.hangingInvocation = new Promise((resolve) => {
      this.notifyHangingInvocation = resolve;
    });
    this.hangingReconciliation = new Promise((resolve) => {
      this.notifyHangingReconciliation = resolve;
    });
  }

  promptForRun(context: Parameters<FakeReviewerBackend["promptForRun"]>[0]) {
    return this.delegate.promptForRun(context);
  }

  invoke(input: BackendInvocationInput): Promise<BackendInvocationResult> {
    this.invocationCount += 1;
    if (this.options.hangFirstInvocation && this.invocationCount === 1) {
      this.notifyHangingInvocation(input);
      return new Promise((resolve) => {
        this.resolveInvocation = resolve;
      });
    }
    this.delegatedInvocationCount += 1;
    this.delegatedInvocations.push(input);
    return this.delegate.invoke(input);
  }

  reconcile(
    input: BackendInvocationInput,
  ): Promise<BackendReconciliationResult> {
    this.reconciliationCount += 1;
    if (
      this.options.hangFirstReconciliation &&
      this.reconciliationCount === 1
    ) {
      this.notifyHangingReconciliation(input);
      return new Promise((resolve) => {
        this.resolveReconciliation = resolve;
      });
    }
    return this.delegate.reconcile(input);
  }

  resolveHungInvocation(input: BackendInvocationInput): void {
    if (this.resolveInvocation === undefined) {
      throw new Error("No hanging fake invocation is available to resolve.");
    }
    const output = fakeWorkerOutput(input.context, input.claim);
    this.resolveInvocation({
      kind: "SUCCESS",
      output,
      rawBytes: markedFakeOutput(output),
    });
    this.resolveInvocation = undefined;
  }

  resolveHungReconciliation(input: BackendInvocationInput): void {
    if (this.resolveReconciliation === undefined) {
      throw new Error(
        "No hanging fake reconciliation is available to resolve.",
      );
    }
    const output = fakeWorkerOutput(input.context, input.claim);
    this.resolveReconciliation({
      kind: "PROVEN_ACCEPTED_WITH_RESULT",
      output,
      rawBytes: markedFakeOutput(output),
    });
    this.resolveReconciliation = undefined;
  }
}

function markedFakeOutput(
  output: ReturnType<typeof fakeWorkerOutput>,
): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      backend: "FAKE",
      qualification: "OFFLINE_ONLY",
      output,
    }),
    "utf8",
  );
}

function emptySnapshotService() {
  return {
    async createSnapshot() {
      throw new Error("Snapshot service should not run in a status-only test.");
    },
    async openSnapshot() {
      throw new Error("Snapshot service should not run in a status-only test.");
    },
  } as never;
}

function abortError(): Error {
  const error = new Error("Virtual scheduler sleep was aborted.");
  error.name = "AbortError";
  return error;
}
