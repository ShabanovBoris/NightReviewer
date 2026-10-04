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
import type { SnapshotService } from "../../src/snapshot";
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
          requiredFindingIds: ["finding-1"],
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
    let submitFixError: unknown;
    try {
      await reviews.invoke(
        "review_submit_fix",
        {
          reviewId: created.reviewId,
          objectFormat: "sha1",
          previousSha: cycle.revisions.headSha,
          headSha: "e".repeat(40),
          resolutions: [
            { findingId: "finding-1", note: "Address the blocker." },
          ],
          idempotencyKey: "admissible-fix",
        },
        "fix-1",
      );
    } catch (error) {
      submitFixError = error;
    }
    expect(submitFixError).toBeInstanceOf(ReviewRuntimeError);
    expect((submitFixError as ReviewRuntimeError).protocolError).toMatchObject({
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
