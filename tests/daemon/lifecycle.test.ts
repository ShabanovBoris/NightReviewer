import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DaemonOwner,
  DaemonReviewRuntime,
  ReviewRuntimeError,
} from "../../src/daemon";
import {
  hashCanonicalJson,
  protocolExampleSha256,
  type ReviewSubmitInput,
  validProtocolExamples,
  versionHashBindingExample,
} from "../../src/protocol";
import type { SnapshotManifest, SnapshotService } from "../../src/snapshot";
import { openStorage, type SqliteStorage } from "../../src/storage";

const timestamp = "2026-10-04T12:00:00.000Z";
const trustedRepoId = "fixture/project";

test("queued review cancellation follows durable state transitions", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "nr07-cancel-queued-"),
  );
  let store: SqliteStorage | undefined;
  let owner: DaemonOwner | undefined;
  try {
    store = await openStorage({ rootDir: path.join(temporary, "store") });
    owner = DaemonOwner.acquire(store);
    const reviews = new DaemonReviewRuntime({
      store,
      owner,
      trustedRepositoryIds: new Set([trustedRepoId]),
      snapshotService: blockingSnapshotService(() => undefined),
      bindingProvider: () => versionHashBindingExample,
    });
    const accepted = (await reviews.invoke(
      "review_submit",
      submission("cancel-queued-review"),
      "submit-queued-1",
    )) as { reviewId: string; cycleId: string; state: string };
    expect(accepted.state).toBe("QUEUED");

    const cancelled = (await reviews.invoke(
      "review_cancel",
      {
        reviewId: accepted.reviewId,
        reason: "Cancel before snapshot scheduling.",
        idempotencyKey: "cancel-queued-review",
      },
      "cancel-queued-1",
    )) as { state: string };
    expect(cancelled.state).toBe("CANCELLED");
    expect(store.readCycle(accepted.cycleId).state).toBe("CANCELLED");
    const transitions = store
      .readEventPage(accepted.cycleId)
      .events.filter(
        (event) => event.eventType === "review.cycle_transitioned",
      );
    expect(
      transitions.map(
        (event) => (event.payload as { state: { state: string } }).state.state,
      ),
    ).toEqual(["CANCEL_REQUESTED", "CANCELLED"]);
    await reviews.drain();
  } finally {
    owner?.release();
    store?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("cancel idempotency keys are scoped to their review cycle", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "nr07-cancel-idempotency-scope-"),
  );
  let store: SqliteStorage | undefined;
  let owner: DaemonOwner | undefined;
  try {
    store = await openStorage({ rootDir: path.join(temporary, "store") });
    owner = DaemonOwner.acquire(store);
    const reviews = new DaemonReviewRuntime({
      store,
      owner,
      trustedRepositoryIds: new Set([trustedRepoId]),
      snapshotService: blockingSnapshotService(() => undefined),
      bindingProvider: () => versionHashBindingExample,
    });
    const first = (await reviews.invoke(
      "review_submit",
      submission("cancel-idempotency-review-one"),
      "submit-one",
    )) as { reviewId: string; cycleId: string };
    const second = (await reviews.invoke(
      "review_submit",
      submission("cancel-idempotency-review-two"),
      "submit-two",
    )) as { reviewId: string; cycleId: string };

    const cancel = (reviewId: string) =>
      reviews.invoke(
        "review_cancel",
        {
          reviewId,
          reason: "Cancel both independent queued reviews.",
          idempotencyKey: "shared-public-cancel-key",
        },
        `cancel-${reviewId}`,
      );
    const firstCancelled = (await cancel(first.reviewId)) as {
      state: string;
    };
    const secondCancelled = (await cancel(second.reviewId)) as {
      state: string;
    };

    expect(firstCancelled.state).toBe("CANCELLED");
    expect(secondCancelled.state).toBe("CANCELLED");
    expect(store.readCycle(first.cycleId).state).toBe("CANCELLED");
    expect(store.readCycle(second.cycleId).state).toBe("CANCELLED");
    await reviews.drain();
  } finally {
    owner?.release();
    store?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("public cancel keys cannot collide with daemon transition keys", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "nr07-cancel-internal-key-collision-"),
  );
  let store: SqliteStorage | undefined;
  let owner: DaemonOwner | undefined;
  try {
    store = await openStorage({ rootDir: path.join(temporary, "store") });
    owner = DaemonOwner.acquire(store);
    let notifyStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const reviews = new DaemonReviewRuntime({
      store,
      owner,
      trustedRepositoryIds: new Set([trustedRepoId]),
      snapshotService: blockingSnapshotService(notifyStarted),
      bindingProvider: () => versionHashBindingExample,
    });
    reviews.start();
    const accepted = (await reviews.invoke(
      "review_submit",
      submission("cancel-internal-key-collision"),
      "submit-internal-key-collision",
    )) as { reviewId: string; cycleId: string };
    await started;

    const cancelled = (await reviews.invoke(
      "review_cancel",
      {
        reviewId: accepted.reviewId,
        reason: "Cancel after snapshot preparation starts.",
        idempotencyKey: `snapshot-start-${accepted.cycleId}-0`,
      },
      "cancel-internal-key-collision",
    )) as { state: string };

    expect(cancelled.state).toBe("CANCELLED");
    expect(store.readCycle(accepted.cycleId).state).toBe("CANCELLED");
    await reviews.drain();
  } finally {
    owner?.release();
    store?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("cancel during snapshot aborts work before durably confirming cancellation", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "nr07-cancel-snapshot-"),
  );
  let store: SqliteStorage | undefined;
  let owner: DaemonOwner | undefined;
  try {
    store = await openStorage({ rootDir: path.join(temporary, "store") });
    owner = DaemonOwner.acquire(store);
    let notifyStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const reviews = new DaemonReviewRuntime({
      store,
      owner,
      trustedRepositoryIds: new Set([trustedRepoId]),
      snapshotService: blockingSnapshotService(notifyStarted),
      bindingProvider: () => versionHashBindingExample,
    });
    reviews.start();
    const accepted = (await reviews.invoke(
      "review_submit",
      submission("cancel-during-snapshot"),
      "submit-1",
    )) as {
      reviewId: string;
      cycleId: string;
    };
    await started;
    expect(store.readCycle(accepted.cycleId).state).toBe("SNAPSHOTTING");
    const cancelled = (await reviews.invoke(
      "review_cancel",
      {
        reviewId: accepted.reviewId,
        reason: "Cancel integration fixture.",
        idempotencyKey: "cancel-during-snapshot",
      },
      "cancel-1",
    )) as { state: string };
    expect(cancelled.state).toBe("CANCELLED");
    expect(store.readCycle(accepted.cycleId).state).toBe("CANCELLED");
    expect(store.readSnapshots(accepted.cycleId)).toHaveLength(0);
    await reviews.drain();
  } finally {
    owner?.release();
    store?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("shutdown aborts snapshot work but preserves the accepted resumable cycle", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "nr07-drain-snapshot-"),
  );
  let store: SqliteStorage | undefined;
  let reopened: SqliteStorage | undefined;
  let owner: DaemonOwner | undefined;
  try {
    const storageRoot = path.join(temporary, "store");
    store = await openStorage({ rootDir: storageRoot });
    owner = DaemonOwner.acquire(store);
    let notifyStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const reviews = new DaemonReviewRuntime({
      store,
      owner,
      trustedRepositoryIds: new Set([trustedRepoId]),
      snapshotService: blockingSnapshotService(notifyStarted),
      bindingProvider: () => versionHashBindingExample,
      drainTimeoutMs: 1,
    });
    reviews.start();
    const accepted = (await reviews.invoke(
      "review_submit",
      submission("drain-during-snapshot"),
      "submit-2",
    )) as {
      reviewId: string;
      cycleId: string;
    };
    await started;
    await reviews.drain(1);
    expect(store.readCycle(accepted.cycleId).state).toBe("SNAPSHOTTING");
    expect(store.hasLeaseOwnership(owner.fencingToken())).toBe(true);
    let drainError: unknown;
    try {
      await reviews.invoke(
        "review_cancel",
        {
          reviewId: accepted.reviewId,
          reason: "No new mutations during drain.",
          idempotencyKey: "cancel-during-drain",
        },
        "cancel-2",
      );
    } catch (error) {
      drainError = error;
    }
    expect(drainError).toBeInstanceOf(ReviewRuntimeError);
    expect((drainError as ReviewRuntimeError).protocolError.code).toBe(
      "BACKEND_UNAVAILABLE",
    );

    owner.release();
    store.close();
    store = undefined;
    reopened = await openStorage({ rootDir: storageRoot });
    expect(reopened.readReview(accepted.reviewId).state).toBe("SNAPSHOTTING");
  } finally {
    owner?.release();
    store?.close();
    reopened?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("drain timeout releases ownership while a snapshot ignores abort", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "nr07-drain-noncooperative-snapshot-"),
  );
  let store: SqliteStorage | undefined;
  let reopened: SqliteStorage | undefined;
  let owner: DaemonOwner | undefined;
  let replacementOwner: DaemonOwner | undefined;
  let resolveSnapshot: ((manifest: SnapshotManifest) => void) | undefined;
  try {
    const storageRoot = path.join(temporary, "store");
    store = await openStorage({ rootDir: storageRoot });
    owner = DaemonOwner.acquire(store);
    let notifyStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const snapshotService: SnapshotService = {
      createSnapshot() {
        notifyStarted();
        return new Promise<SnapshotManifest>((resolve) => {
          resolveSnapshot = resolve;
        });
      },
      async openSnapshot() {
        throw new Error("Unexpected test snapshot read.");
      },
    };
    const reviews = new DaemonReviewRuntime({
      store,
      owner,
      trustedRepositoryIds: new Set([trustedRepoId]),
      snapshotService,
      bindingProvider: () => versionHashBindingExample,
    });
    reviews.start();
    const accepted = (await reviews.invoke(
      "review_submit",
      submission("drain-noncooperative-snapshot"),
      "submit-noncooperative-snapshot",
    )) as { reviewId: string; cycleId: string };
    await started;

    const drainCompleted = await Promise.race([
      reviews.drain(10).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    expect(drainCompleted).toBe(true);
    expect(store.readCycle(accepted.cycleId).state).toBe("SNAPSHOTTING");

    owner.release();
    owner = undefined;
    store.close();
    store = undefined;
    reopened = await openStorage({ rootDir: storageRoot });
    replacementOwner = DaemonOwner.acquire(reopened);
    expect(replacementOwner.isCurrent()).toBe(true);

    resolveSnapshot?.({ snapshotId: "late-snapshot" } as SnapshotManifest);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reopened.readSnapshots(accepted.cycleId)).toHaveLength(0);
    expect(reopened.readReview(accepted.reviewId).state).toBe("SNAPSHOTTING");
  } finally {
    replacementOwner?.release();
    reopened?.close();
    owner?.release();
    store?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("admissible fix requests report backend unavailable without mutation", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "nr07-fix-unavailable-"),
  );
  let store: SqliteStorage | undefined;
  let owner: DaemonOwner | undefined;
  try {
    store = await openStorage({ rootDir: path.join(temporary, "store") });
    const created = await store.createReview({
      callerId: "test-caller",
      submission: submission("needs-fix-seed"),
      reviewContextHash: protocolExampleSha256,
      versionBinding: versionHashBindingExample,
      createdAtUtc: timestamp,
    });
    const cycleId = created.cycleId;
    store.applyCycleCommand(
      "test-caller",
      cycleId,
      {
        type: "ADVANCE",
        target: "SNAPSHOTTING",
        expectedVersion: 0,
        idempotencyKey: "needs-fix-snapshotting",
      },
      { occurredAtUtc: timestamp },
    );
    const cycle = store.readCycle(cycleId);
    const manifest = {
      snapshotId: "snapshot-needs-fix",
      cycleId,
      repoId: trustedRepoId,
      objectFormat: "sha1",
      baseSha: cycle.revisions.baseSha,
      headSha: cycle.revisions.headSha,
      coverage: { complete: true, limitations: [] },
      changes: [],
    };
    store.recordSnapshot({
      snapshotId: "snapshot-needs-fix",
      cycleId,
      objectFormat: "sha1",
      baseSha: cycle.revisions.baseSha,
      headSha: cycle.revisions.headSha,
      manifestHash: hashCanonicalJson(manifest),
      manifest,
      createdAtUtc: timestamp,
    });
    store.applyCycleCommand(
      "test-caller",
      cycleId,
      {
        type: "ADVANCE",
        target: "REVIEWING",
        expectedVersion: 1,
        idempotencyKey: "needs-fix-reviewing",
        evidence: {
          durableManifestRecorded: true,
          manifestHash: hashCanonicalJson(manifest),
        },
      },
      { occurredAtUtc: timestamp },
    );
    store.applyCycleCommand(
      "test-caller",
      cycleId,
      {
        type: "ADVANCE",
        target: "AGGREGATING",
        expectedVersion: 2,
        idempotencyKey: "needs-fix-aggregating",
        evidence: { allRequiredRunsSucceeded: true },
      },
      { occurredAtUtc: timestamp },
    );
    store.applyCycleCommand(
      "test-caller",
      cycleId,
      {
        type: "ADVANCE",
        target: "NEEDS_FIX",
        expectedVersion: 3,
        idempotencyKey: "needs-fix-state",
        evidence: {
          allAdjudicationsComplete: true,
          hasBlockingFindings: true,
          requiredFindingIds: ["finding-1", "finding-2"],
        },
      },
      { occurredAtUtc: timestamp },
    );
    owner = DaemonOwner.acquire(store);
    const reviews = new DaemonReviewRuntime({
      store,
      owner,
      trustedRepositoryIds: new Set([trustedRepoId]),
      snapshotService: blockingSnapshotService(() => undefined),
      bindingProvider: () => versionHashBindingExample,
    });
    const before = store.readCycle(cycleId);
    const beforeEvents = store.readEventPage(cycleId).events.length;
    const invalidFixes = [
      { id: "missing", findingIds: ["finding-1"] },
      {
        id: "extra",
        findingIds: ["finding-1", "finding-2", "unexpected-finding"],
      },
      { id: "duplicate", findingIds: ["finding-1", "finding-1"] },
      { id: "incorrect", findingIds: ["finding-1", "unexpected-finding"] },
      {
        id: "blank-note",
        findingIds: ["finding-1", "finding-2"],
        note: "   ",
      },
    ];
    for (const invalidFix of invalidFixes) {
      let submitFixError: unknown;
      try {
        await reviews.invoke(
          "review_submit_fix",
          {
            reviewId: created.reviewId,
            objectFormat: "sha1",
            previousSha: cycle.revisions.headSha,
            headSha: "e".repeat(40),
            resolutions: invalidFix.findingIds.map((findingId) => ({
              findingId,
              note: invalidFix.note ?? "Address the blocker.",
            })),
            idempotencyKey: `invalid-fix-${invalidFix.id}`,
          },
          `fix-${invalidFix.id}`,
        );
      } catch (error) {
        submitFixError = error;
      }
      expect(submitFixError).toBeInstanceOf(ReviewRuntimeError);
      expect(
        (submitFixError as ReviewRuntimeError).protocolError,
      ).toMatchObject({ code: "INVALID_ARGUMENT", retryable: false });
      expect(store.readCycle(cycleId)).toEqual(before);
      expect(store.readEventPage(cycleId).events).toHaveLength(beforeEvents);
    }

    let admissibleFixError: unknown;
    try {
      await reviews.invoke(
        "review_submit_fix",
        {
          reviewId: created.reviewId,
          objectFormat: "sha1",
          previousSha: cycle.revisions.headSha,
          headSha: "e".repeat(40),
          resolutions: [
            { findingId: "finding-1", note: "Address the first blocker." },
            { findingId: "finding-2", note: "Address the second blocker." },
          ],
          idempotencyKey: "admissible-fix",
        },
        "fix-admissible",
      );
    } catch (error) {
      admissibleFixError = error;
    }
    expect(admissibleFixError).toBeInstanceOf(ReviewRuntimeError);
    expect(
      (admissibleFixError as ReviewRuntimeError).protocolError,
    ).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      retryable: false,
    });
    expect(store.readCycle(cycleId)).toEqual(before);
    expect(store.readEventPage(cycleId).events).toHaveLength(beforeEvents);
  } finally {
    owner?.release();
    store?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

function blockingSnapshotService(onStart: () => void): SnapshotService {
  return {
    async createSnapshot(input) {
      onStart();
      return new Promise((_, reject) => {
        if (input.signal?.aborted) {
          reject(new Error("Snapshot work aborted."));
          return;
        }
        input.signal?.addEventListener(
          "abort",
          () => reject(new Error("Snapshot work aborted.")),
          {
            once: true,
          },
        );
      });
    },
    async openSnapshot() {
      throw new Error("Unexpected test snapshot read.");
    },
  };
}

function submission(idempotencyKey: string): ReviewSubmitInput {
  return {
    ...validProtocolExamples.reviewSubmitInput,
    repoId: trustedRepoId,
    idempotencyKey,
  };
}
