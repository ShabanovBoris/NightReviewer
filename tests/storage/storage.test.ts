import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  approvalEvidenceExample,
  createInitialReviewCycle,
  hashCanonicalJson,
  protocolExampleSha256,
  type ReviewSubmitInput,
  validProtocolExamples,
  versionHashBindingExample,
} from "../../src/protocol";
import {
  type CreatedReview,
  openStorage,
  restoreStorageBackup,
  type SqliteStorage,
  STORAGE_MIGRATIONS,
} from "../../src/storage";

const timestamp = "2026-10-03T12:00:00.000Z";

async function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "nightreviewer-nr04-"));
}

function submission(idempotencyKey: string): ReviewSubmitInput {
  return {
    ...validProtocolExamples.reviewSubmitInput,
    idempotencyKey,
  };
}

async function createReview(
  store: SqliteStorage,
  idempotencyKey = "submit-1",
): Promise<CreatedReview> {
  return store.createReview({
    callerId: "test-caller",
    submission: submission(idempotencyKey),
    reviewContextHash: protocolExampleSha256,
    versionBinding: versionHashBindingExample,
    createdAtUtc: timestamp,
  });
}

function recordRunAndAttempt(
  store: SqliteStorage,
  cycleId: string,
  directionRunId = "run-1",
  attemptId = "attempt-1",
): void {
  store.recordDirectionRun({
    runId: directionRunId,
    cycleId,
    direction: "correctness",
    role: "reviewer",
    promptHash: protocolExampleSha256,
    schemaHash: protocolExampleSha256,
    policyHash: protocolExampleSha256,
    createdAtUtc: timestamp,
  });
  store.appendWorkerAttempt({
    attemptId,
    directionRunId,
    attemptNumber: 1,
    model: "test-model",
    effort: "low",
    startedAtUtc: timestamp,
  });
}

async function closeStoresAndRemove(
  root: string,
  stores: readonly (SqliteStorage | undefined)[],
): Promise<void> {
  for (const store of stores) {
    try {
      store?.close();
    } catch {
      // Cleanup continues if a test already closed its store for restart.
    }
  }
  await rm(root, { recursive: true, force: true });
}

test("persists review state, raw result, finding provenance, and snapshot across restart", async () => {
  const root = await temporaryRoot();
  const storeDir = path.join(root, "store");
  let first: SqliteStorage | undefined;
  let reopened: SqliteStorage | undefined;
  try {
    first = await openStorage({ rootDir: storeDir });
    const review = await createReview(first);
    const manifest = {
      snapshotId: "snapshot-1",
      cycleId: review.cycleId,
      objectFormat: "sha1",
      baseSha: review.revisions.baseSha,
      headSha: review.revisions.headSha,
      files: [],
      coverage: { complete: true },
    } as const;
    const manifestHash = hashCanonicalJson(manifest);
    first.applyCycleCommand("test-caller", review.cycleId, {
      type: "ADVANCE",
      target: "SNAPSHOTTING",
      expectedVersion: 0,
      idempotencyKey: "advance-snapshotting",
    });
    first.recordSnapshot({
      snapshotId: "snapshot-1",
      cycleId: review.cycleId,
      objectFormat: "sha1",
      baseSha: review.revisions.baseSha,
      headSha: review.revisions.headSha,
      manifestHash,
      manifest,
      createdAtUtc: timestamp,
    });
    first.applyCycleCommand("test-caller", review.cycleId, {
      type: "ADVANCE",
      target: "REVIEWING",
      expectedVersion: 1,
      idempotencyKey: "advance-reviewing",
      evidence: { durableManifestRecorded: true, manifestHash },
    });

    recordRunAndAttempt(first, review.cycleId);
    const activeStore = first;
    expect(() =>
      activeStore.transitionDirectionRunStatus("run-1", "COMPLETE", timestamp),
    ).toThrow("selected valid result");
    const originalBytes = new TextEncoder().encode(
      '{"finding":"raw response"}',
    );
    const originalArtifact = await first.persistRawArtifact(originalBytes);
    await first.recordWorkerResult({
      attemptId: "attempt-1",
      rawArtifact: originalArtifact,
      disposition: "VALID",
      selected: true,
      parsedResult: { accepted: true },
      recordedAtUtc: timestamp,
    });
    expect(
      activeStore.transitionDirectionRunStatus("run-1", "COMPLETE", timestamp),
    ).toBe("COMPLETE");
    const workerResult = first.readWorkerResult("attempt-1");
    expect(
      (await stat(path.join(storeDir, workerResult.rawArtifact.relativePath)))
        .mode & 0o777,
    ).toBe(0o600);
    first.recordRawFinding({
      rawFindingId: "raw-finding-1",
      resultId: workerResult.resultId,
      localId: "finding-1",
      payload: { title: "Persisted finding" },
      createdAtUtc: timestamp,
    });
    first.recordCanonicalFinding({
      findingId: "canonical-finding-1",
      cycleId: review.cycleId,
      severity: "high",
      validation: "CONFIRMED",
      blocking: true,
      payload: { title: "Persisted finding", claim: "Evidence-backed claim." },
      sources: [
        {
          rawFindingId: "raw-finding-1",
          directionRunId: "run-1",
          attemptId: "attempt-1",
          sourceLocalId: "finding-1",
        },
      ],
      createdAtUtc: timestamp,
    });
    first.recordAdjudicationDecision({
      decisionId: "decision-1",
      cycleId: review.cycleId,
      findingId: "canonical-finding-1",
      outcome: "CONFIRMED",
      rationale: "The pinned source supports the claim.",
      evidenceDigest: protocolExampleSha256,
      createdAtUtc: timestamp,
    });
    first.close();
    first = undefined;

    reopened = await openStorage({ rootDir: storeDir });
    expect((await stat(storeDir)).mode & 0o777).toBe(0o700);
    expect(
      (await stat(path.join(storeDir, "database.sqlite"))).mode & 0o777,
    ).toBe(0o600);
    expect(reopened.readReview(review.reviewId).state).toBe("REVIEWING");
    expect(reopened.readCycle(review.cycleId).stateVersion).toBe(2);
    expect(reopened.readSnapshots(review.cycleId)).toMatchObject([
      { snapshotId: "snapshot-1", manifestHash, manifest },
    ]);
    expect(reopened.readDirectionRunStatus("run-1")).toBe("COMPLETE");
    expect(reopened.readWorkerResult("attempt-1")).toMatchObject({
      disposition: "VALID",
      selected: true,
      parsedResult: { accepted: true },
    });
    expect(
      await reopened.readRawArtifact(
        reopened.readWorkerResult("attempt-1").rawArtifact,
      ),
    ).toEqual(originalBytes);
    expect(reopened.readCanonicalFindings(review.cycleId)).toMatchObject([
      {
        findingId: "canonical-finding-1",
        severity: "high",
        blocking: true,
        sources: [
          {
            rawFindingId: "raw-finding-1",
            directionRunId: "run-1",
            attemptId: "attempt-1",
            sourceLocalId: "finding-1",
          },
        ],
      },
    ]);
    const constraintDb = new Database(path.join(storeDir, "database.sqlite"));
    try {
      constraintDb.exec("PRAGMA foreign_keys = ON");
      expect(() =>
        constraintDb
          .query(
            "UPDATE snapshots SET manifest_json = '{}' WHERE snapshot_id = ?",
          )
          .run("snapshot-1"),
      ).toThrow("snapshots are immutable");
      expect(() =>
        constraintDb
          .query(
            `UPDATE idempotency_keys SET result_id = 'changed'
             WHERE caller_id = 'test-caller' AND operation = 'review_submit'`,
          )
          .run(),
      ).toThrow("idempotency records are immutable");
      expect(() =>
        constraintDb
          .query(
            "UPDATE raw_artifacts SET content_type = 'text/plain' WHERE sha256 = ?",
          )
          .run(workerResult.rawArtifact.sha256),
      ).toThrow("raw artifacts are immutable");
      expect(() =>
        constraintDb
          .query(
            `INSERT INTO raw_findings
             (raw_finding_id, result_id, local_id, payload_json, created_at_utc)
             VALUES ('orphan-raw-finding', 'missing-result', 'local-id', '{}', ?)`,
          )
          .run(timestamp),
      ).toThrow("FOREIGN KEY constraint failed");
    } finally {
      constraintDb.close(true);
    }
    expect(reopened.integrityCheck()).toEqual({
      integrity: "ok",
      foreignKeyViolations: 0,
    });
  } finally {
    await closeStoresAndRemove(root, [first, reopened]);
  }
});

test("serializes concurrent idempotent submissions, rejects payload reuse, and keeps transition/outbox atomic", async () => {
  const root = await temporaryRoot();
  const storeDir = path.join(root, "store");
  let first: SqliteStorage | undefined;
  let second: SqliteStorage | undefined;
  try {
    first = await openStorage({ rootDir: storeDir });
    second = await openStorage({ rootDir: storeDir, busyTimeoutMs: 20 });
    const [left, right] = await Promise.all([
      createReview(first, "concurrent-submit"),
      createReview(second, "concurrent-submit"),
    ]);
    expect(left).toEqual(right);
    expect(
      first
        .readOutbox()
        .filter((event) => event.eventType === "review.created"),
    ).toHaveLength(1);

    const writerLock = new Database(path.join(storeDir, "database.sqlite"));
    writerLock.exec("BEGIN IMMEDIATE");
    try {
      await expect(createReview(second, "busy-writer")).rejects.toMatchObject({
        code: "CONFLICT",
        retryable: true,
      });
    } finally {
      writerLock.exec("ROLLBACK");
      writerLock.close(true);
    }

    await expect(
      first.createReview({
        callerId: "test-caller",
        submission: {
          ...submission("concurrent-submit"),
          task: "Different payload.",
        },
        reviewContextHash: protocolExampleSha256,
        versionBinding: versionHashBindingExample,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const command = {
      type: "REQUEST_CANCEL" as const,
      reason: "test cancellation",
      expectedVersion: 0,
      idempotencyKey: "cancel-once",
    };
    const [transitionA, transitionB] = await Promise.all([
      first.applyCycleCommand("test-caller", left.cycleId, command),
      second.applyCycleCommand("test-caller", left.cycleId, command),
    ]);
    expect(transitionA).toEqual(transitionB);
    expect(first.readCycle(left.cycleId).state).toBe("CANCEL_REQUESTED");

    const outboxCount = first.readOutbox().length;
    const triggerDb = new Database(path.join(storeDir, "database.sqlite"));
    triggerDb.exec(
      `CREATE TRIGGER test_fail_outbox BEFORE INSERT ON outbox
       BEGIN SELECT RAISE(ABORT, 'injected outbox failure'); END;`,
    );
    triggerDb.close(true);
    const primaryStore = first;
    expect(() =>
      primaryStore.recordOutboxEvent(
        left.reviewId,
        left.cycleId,
        "fault.injection",
        {},
      ),
    ).toThrow();
    expect(first.readOutbox()).toHaveLength(outboxCount);
    const verifyDb = new Database(path.join(storeDir, "database.sqlite"));
    try {
      expect(
        verifyDb
          .query(
            "SELECT COUNT(*) AS count FROM events WHERE event_type = 'fault.injection'",
          )
          .get(),
      ).toEqual({ count: 0 });
      verifyDb.exec("DROP TRIGGER test_fail_outbox");
    } finally {
      verifyDb.close(true);
    }
    let staleTransitionError: unknown;
    try {
      second.applyCycleCommand("test-caller", left.cycleId, {
        ...command,
        idempotencyKey: "stale-cancel",
      });
    } catch (error) {
      staleTransitionError = error;
    }
    expect(staleTransitionError).toMatchObject({ code: "CONFLICT" });
  } finally {
    await closeStoresAndRemove(root, [first, second]);
  }
});

test("submits a fix atomically against the authoritative finding set and state version", async () => {
  const root = await temporaryRoot();
  let store: SqliteStorage | undefined;
  try {
    store = await openStorage({ rootDir: path.join(root, "store") });
    const primaryStore = store;
    const review = await createReview(primaryStore);
    const manifest = {
      snapshotId: "fix-snapshot-1",
      cycleId: review.cycleId,
      objectFormat: "sha1",
      baseSha: review.revisions.baseSha,
      headSha: review.revisions.headSha,
      files: [],
      coverage: { complete: true },
    } as const;
    const manifestHash = hashCanonicalJson(manifest);
    primaryStore.applyCycleCommand("test-caller", review.cycleId, {
      type: "ADVANCE",
      target: "SNAPSHOTTING",
      expectedVersion: 0,
      idempotencyKey: "fix-stage-snapshotting",
    });
    expect(() =>
      primaryStore.applyCycleCommand("test-caller", review.cycleId, {
        type: "ADVANCE",
        target: "REVIEWING",
        expectedVersion: 1,
        idempotencyKey: "fix-stage-reviewing-without-snapshot",
        evidence: { durableManifestRecorded: true, manifestHash },
      }),
    ).toThrow("stored snapshot");
    expect(primaryStore.readCycle(review.cycleId).state).toBe("SNAPSHOTTING");
    primaryStore.recordSnapshot({
      snapshotId: "fix-snapshot-1",
      cycleId: review.cycleId,
      objectFormat: "sha1",
      baseSha: review.revisions.baseSha,
      headSha: review.revisions.headSha,
      manifestHash,
      manifest,
      createdAtUtc: timestamp,
    });
    primaryStore.applyCycleCommand("test-caller", review.cycleId, {
      type: "ADVANCE",
      target: "REVIEWING",
      expectedVersion: 1,
      idempotencyKey: "fix-stage-reviewing",
      evidence: { durableManifestRecorded: true, manifestHash },
    });
    primaryStore.applyCycleCommand("test-caller", review.cycleId, {
      type: "ADVANCE",
      target: "AGGREGATING",
      expectedVersion: 2,
      idempotencyKey: "fix-stage-aggregating",
      evidence: { allRequiredRunsSucceeded: true },
    });
    primaryStore.applyCycleCommand("test-caller", review.cycleId, {
      type: "ADVANCE",
      target: "NEEDS_FIX",
      expectedVersion: 3,
      idempotencyKey: "fix-stage-needs-fix",
      evidence: {
        allAdjudicationsComplete: true,
        hasBlockingFindings: true,
        requiredFindingIds: ["finding-1"],
      },
    });

    const validInput = {
      callerId: "test-caller",
      reviewId: review.reviewId,
      cycleId: review.cycleId,
      previousSha: review.revisions.headSha,
      headSha: "e".repeat(40),
      expectedVersion: 4,
      resolutions: [{ findingId: "finding-1", note: "Applied the fix." }],
      idempotencyKey: "submit-fix-1",
      submittedAtUtc: timestamp,
    } as const;
    expect(() =>
      primaryStore.submitFix({
        ...validInput,
        resolutions: [{ findingId: "unexpected-finding", note: "Wrong ID." }],
      }),
    ).toThrow("exactly the authoritative finding IDs");

    const result = primaryStore.submitFix(validInput);
    expect(result).toMatchObject({
      state: "VERIFYING_FIX",
      stateVersion: 5,
      revisions: {
        objectFormat: "sha1",
        baseSha: review.revisions.headSha,
        headSha: "e".repeat(40),
      },
    });
    expect(primaryStore.readCycle(review.cycleId)).toMatchObject({
      state: "VERIFYING_FIX",
      stateVersion: 5,
      requiredFindingIds: ["finding-1"],
      revisions: {
        objectFormat: "sha1",
        baseSha: review.revisions.baseSha,
        headSha: validInput.headSha,
      },
    });
    expect(primaryStore.submitFix(validInput)).toEqual(result);
    expect(
      primaryStore
        .readOutbox()
        .filter((event) => event.eventType === "review.fix_submitted"),
    ).toHaveLength(1);

    primaryStore.close();
    const reopenedStore = await openStorage({
      rootDir: path.join(root, "store"),
    });
    store = reopenedStore;
    expect(reopenedStore.readCycle(review.cycleId)).toMatchObject({
      state: "VERIFYING_FIX",
      revisions: {
        objectFormat: "sha1",
        baseSha: review.revisions.baseSha,
        headSha: validInput.headSha,
      },
    });
    const approved = reopenedStore.applyCycleCommand(
      "test-caller",
      review.cycleId,
      {
        type: "ADVANCE",
        target: "APPROVED",
        expectedVersion: 5,
        idempotencyKey: "approve-fixed-head",
        evidence: {
          approval: {
            ...approvalEvidenceExample,
            fixOutcomes: [
              {
                findingId: "finding-1",
                status: "FIXED",
                evidence: [
                  {
                    kind: "test_artifact",
                    artifactSha256: protocolExampleSha256,
                    artifactSizeBytes: 1,
                  },
                ],
                requiresFreshReview: false,
              },
            ],
          },
          approvedAt: timestamp,
        },
      },
    );
    expect(approved.state).toMatchObject({
      state: "APPROVED",
      approvalReceipt: {
        revisions: {
          objectFormat: "sha1",
          baseSha: review.revisions.baseSha,
          headSha: validInput.headSha,
        },
      },
    });
  } finally {
    await closeStoresAndRemove(root, [store]);
  }
});

test("refuses REVIEWING when the pinned snapshot has incomplete coverage", async () => {
  const root = await temporaryRoot();
  let store: SqliteStorage | undefined;
  try {
    store = await openStorage({ rootDir: path.join(root, "store") });
    const activeStore = store;
    const review = await createReview(activeStore);
    const manifest = {
      snapshotId: "incomplete-snapshot-1",
      cycleId: review.cycleId,
      objectFormat: "sha1",
      baseSha: review.revisions.baseSha,
      headSha: review.revisions.headSha,
      coverage: {
        complete: false,
        limitations: ["BINARY_CONTENT"],
      },
    } as const;
    const manifestHash = hashCanonicalJson(manifest);
    activeStore.applyCycleCommand("test-caller", review.cycleId, {
      type: "ADVANCE",
      target: "SNAPSHOTTING",
      expectedVersion: 0,
      idempotencyKey: "incomplete-snapshot-start",
    });
    activeStore.recordSnapshot({
      snapshotId: manifest.snapshotId,
      cycleId: review.cycleId,
      objectFormat: manifest.objectFormat,
      baseSha: manifest.baseSha,
      headSha: manifest.headSha,
      manifestHash,
      manifest,
      createdAtUtc: timestamp,
    });

    expect(() =>
      activeStore.applyCycleCommand("test-caller", review.cycleId, {
        type: "ADVANCE",
        target: "REVIEWING",
        expectedVersion: 1,
        idempotencyKey: "incomplete-snapshot-reviewing",
        evidence: { durableManifestRecorded: true, manifestHash },
      }),
    ).toThrow("complete snapshot content coverage");
    expect(activeStore.readCycle(review.cycleId).state).toBe("SNAPSHOTTING");
  } finally {
    await closeStoresAndRemove(root, [store]);
  }
});

test("uses expiring leases and fencing tokens to reject stale state mutations", async () => {
  const root = await temporaryRoot();
  let store: SqliteStorage | undefined;
  try {
    store = await openStorage({ rootDir: path.join(root, "store") });
    const review = await createReview(store);
    const leaseA = store.acquireLease(
      `cycle:${review.cycleId}`,
      "worker-a",
      1_000,
      timestamp,
    );
    expect(leaseA.token).toBe(1);
    expect(() =>
      store?.acquireLease(
        leaseA.resourceId,
        "worker-b",
        1_000,
        "2026-10-03T12:00:00.500Z",
      ),
    ).toThrow("already held");
    const leaseB = store.acquireLease(
      leaseA.resourceId,
      "worker-b",
      1_000,
      "2026-10-03T12:00:02.000Z",
    );
    expect(leaseB.token).toBe(2);
    const otherReview = await createReview(store, "submit-other-for-fencing");
    const unrelatedLease = store.acquireLease(
      `cycle:${otherReview.cycleId}`,
      "worker-other-cycle",
      1_000,
      "2026-10-03T12:00:02.000Z",
    );
    const command = {
      type: "REQUEST_CANCEL" as const,
      reason: "fencing test",
      expectedVersion: 0,
      idempotencyKey: "fenced-cancel",
    };
    expect(() =>
      store?.applyCycleCommand("test-caller", review.cycleId, command, {
        occurredAtUtc: "2026-10-03T12:00:02.000Z",
        fencing: unrelatedLease,
      }),
    ).toThrow("resource does not match the target cycle");
    expect(store.readCycle(review.cycleId).state).toBe("QUEUED");
    expect(() =>
      store?.applyCycleCommand("test-caller", review.cycleId, command, {
        occurredAtUtc: "2026-10-03T12:00:02.000Z",
        fencing: leaseA,
      }),
    ).toThrow("stale, expired, or non-current fencing token");
    expect(store.readCycle(review.cycleId).state).toBe("QUEUED");
    expect(
      store.applyCycleCommand("test-caller", review.cycleId, command, {
        occurredAtUtc: "2026-10-03T12:00:02.000Z",
        fencing: leaseB,
      }).state.state,
    ).toBe("CANCEL_REQUESTED");
    store.releaseLease(leaseB, "2026-10-03T12:00:02.100Z");
    const leaseC = store.acquireLease(
      leaseB.resourceId,
      "worker-c",
      1_000,
      "2026-10-03T12:00:02.200Z",
    );
    expect(leaseC.token).toBe(3);
    const confirmCancel = {
      type: "CONFIRM_CANCEL" as const,
      fencingAndRevocationConfirmed: true as const,
      expectedVersion: 1,
      idempotencyKey: "confirm-fenced-cancel",
    };
    expect(() =>
      store?.applyCycleCommand("test-caller", review.cycleId, confirmCancel, {
        occurredAtUtc: "2026-10-03T12:00:02.300Z",
        fencing: unrelatedLease,
      }),
    ).toThrow("resource does not match the target cycle");
    expect(store.readCycle(review.cycleId).state).toBe("CANCEL_REQUESTED");
    expect(() =>
      store?.applyCycleCommand("test-caller", review.cycleId, confirmCancel, {
        occurredAtUtc: "2026-10-03T12:00:02.300Z",
      }),
    ).toThrow("active fencing token");
    expect(
      store.applyCycleCommand("test-caller", review.cycleId, confirmCancel, {
        occurredAtUtc: "2026-10-03T12:00:02.300Z",
        fencing: leaseC,
      }).state.state,
    ).toBe("CANCELLED");
  } finally {
    await closeStoresAndRemove(root, [store]);
  }
});

test("retains malformed raw bytes and reconciliation reports crash or file-integrity gaps", async () => {
  const root = await temporaryRoot();
  const storeDir = path.join(root, "store");
  let store: SqliteStorage | undefined;
  try {
    store = await openStorage({ rootDir: storeDir });
    const review = await createReview(store);
    recordRunAndAttempt(
      store,
      review.cycleId,
      "run-malformed",
      "attempt-malformed",
    );
    const malformedBytes = new Uint8Array([0xc3, 0x28, 0x00, 0xff]);
    const mutableInputBytes = new Uint8Array(malformedBytes);
    const malformedArtifactPromise =
      store.persistRawArtifact(mutableInputBytes);
    mutableInputBytes.fill(0);
    const malformedArtifact = await malformedArtifactPromise;
    await store.recordWorkerResult({
      attemptId: "attempt-malformed",
      rawArtifact: malformedArtifact,
      disposition: "MALFORMED",
      selected: false,
      recordedAtUtc: timestamp,
    });
    expect(store.readWorkerResult("attempt-malformed").disposition).toBe(
      "MALFORMED",
    );
    expect(
      await store.readRawArtifact(
        store.readWorkerResult("attempt-malformed").rawArtifact,
      ),
    ).toEqual(malformedBytes);

    recordRunAndAttempt(store, review.cycleId, "run-fault", "attempt-fault");
    const faultArtifact = await store.persistRawArtifact(
      new TextEncoder().encode("persisted before rollback"),
    );
    const faultDatabase = new Database(
      path.join(store.rootDir, "database.sqlite"),
    );
    faultDatabase.exec(
      `CREATE TRIGGER test_fail_raw_artifact BEFORE INSERT ON raw_artifacts
       BEGIN SELECT RAISE(ABORT, 'injected raw metadata failure'); END;`,
    );
    faultDatabase.close(true);
    let artifactCommitError: unknown;
    try {
      await store.recordWorkerResult({
        attemptId: "attempt-fault",
        rawArtifact: faultArtifact,
        disposition: "FAILED",
        selected: false,
        recordedAtUtc: timestamp,
      });
    } catch (error) {
      artifactCommitError = error;
    } finally {
      const dropFault = new Database(
        path.join(store.rootDir, "database.sqlite"),
      );
      dropFault.exec("DROP TRIGGER test_fail_raw_artifact");
      dropFault.close(true);
    }
    expect(artifactCommitError).toMatchObject({ code: "IO_ERROR" });
    const orphanReport = await store.reconcileArtifacts();
    expect(orphanReport.issues.map((issue) => issue.kind)).toContain(
      "ORPHAN_FILE",
    );

    const committedPath = path.join(
      store.rootDir,
      store.readWorkerResult("attempt-malformed").rawArtifact.relativePath,
    );
    const temporaryPath = path.join(
      path.dirname(committedPath),
      ".tmp-injected",
    );
    await writeFile(temporaryPath, new Uint8Array([0x01]));
    const temporaryReport = await store.reconcileArtifacts();
    expect(temporaryReport.issues.map((issue) => issue.kind)).toContain(
      "TEMPORARY_FILE",
    );
    await unlink(temporaryPath);
    await writeFile(committedPath, new Uint8Array([0x01, 0x02, 0x03, 0x04]));
    const mismatchReport = await store.reconcileArtifacts();
    expect(mismatchReport.issues.map((issue) => issue.kind)).toContain(
      "HASH_MISMATCH",
    );
    await unlink(committedPath);
    const missingReport = await store.reconcileArtifacts();
    expect(missingReport.issues.map((issue) => issue.kind)).toContain(
      "MISSING_FILE",
    );
  } finally {
    await closeStoresAndRemove(root, [store]);
  }
});

test("creates a verifiable backup, restores exact artifacts, and rejects a tampered copy", async () => {
  const root = await temporaryRoot();
  const storeDir = path.join(root, "store");
  const backupDir = path.join(root, "backup");
  const restoredDir = path.join(root, "restored");
  const rejectedRestoreDir = path.join(root, "rejected-restore");
  let store: SqliteStorage | undefined;
  let restored: SqliteStorage | undefined;
  try {
    store = await openStorage({ rootDir: storeDir });
    const review = await createReview(store);
    recordRunAndAttempt(store, review.cycleId);
    const rawBytes = new TextEncoder().encode("unparsed result bytes");
    const rawArtifact = await store.persistRawArtifact(rawBytes);
    await store.recordWorkerResult({
      attemptId: "attempt-1",
      rawArtifact,
      disposition: "REJECTED",
      selected: false,
      recordedAtUtc: timestamp,
    });
    const manifest = await store.createBackup(backupDir);
    expect(manifest.schemaVersion).toBe(store.schemaVersion);

    restored = await restoreStorageBackup(backupDir, restoredDir);
    expect(restored.readReview(review.reviewId).reviewId).toBe(review.reviewId);
    expect(restored.readWorkerResult("attempt-1").disposition).toBe("REJECTED");
    expect(
      await restored.readRawArtifact(
        restored.readWorkerResult("attempt-1").rawArtifact,
      ),
    ).toEqual(rawBytes);
    expect(restored.integrityCheck()).toEqual({
      integrity: "ok",
      foreignKeyViolations: 0,
    });

    const artifact = manifest.artifacts[0];
    if (artifact === undefined)
      throw new Error("Backup omitted its referenced artifact.");
    await writeFile(path.join(backupDir, artifact.relativePath), "tampered");
    await expect(
      restoreStorageBackup(backupDir, rejectedRestoreDir),
    ).rejects.toMatchObject({ code: "NEEDS_RECONCILIATION" });
  } finally {
    await closeStoresAndRemove(root, [store, restored]);
  }
});

test("backs up populated v1 before forward migration and refuses a future schema", async () => {
  const root = await temporaryRoot();
  const legacyDir = path.join(root, "legacy");
  const dbPath = path.join(legacyDir, "database.sqlite");
  await mkdir(legacyDir, { recursive: true });
  const legacyDb = new Database(dbPath);
  const migration = STORAGE_MIGRATIONS[0];
  if (migration === undefined) throw new Error("Missing v1 storage migration.");
  legacyDb.exec(migration.sql);
  const cycle = createInitialReviewCycle({
    cycleId: "legacy-cycle",
    repoId: validProtocolExamples.reviewSubmitInput.repoId,
    revisions: {
      objectFormat: "sha1",
      baseSha: validProtocolExamples.reviewSubmitInput.baseSha,
      headSha: validProtocolExamples.reviewSubmitInput.headSha,
    },
    reviewContextHash: protocolExampleSha256,
    versionBinding: versionHashBindingExample,
  });
  legacyDb
    .query(
      `INSERT INTO reviews
     (review_id, repo_id, task, acceptance_criteria_json, profile, created_at_utc, updated_at_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "legacy-review",
      validProtocolExamples.reviewSubmitInput.repoId,
      "Preserve during migration",
      JSON.stringify(
        validProtocolExamples.reviewSubmitInput.acceptanceCriteria,
      ),
      "strict/1",
      timestamp,
      timestamp,
    );
  legacyDb
    .query(
      `INSERT INTO review_cycles
     (cycle_id, review_id, parent_cycle_id, cycle_number, repo_id, object_format, base_sha, head_sha,
      state, state_version, review_context_hash, manifest_hash, version_binding_json, state_json,
      created_at_utc, updated_at_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      cycle.cycleId,
      "legacy-review",
      null,
      cycle.cycleNumber,
      cycle.repoId,
      cycle.revisions.objectFormat,
      cycle.revisions.baseSha,
      cycle.revisions.headSha,
      cycle.state,
      cycle.stateVersion,
      cycle.reviewContextHash,
      cycle.manifestHash,
      JSON.stringify(cycle.versionBinding),
      JSON.stringify(cycle),
      timestamp,
      timestamp,
    );
  legacyDb
    .query(
      `INSERT INTO schema_migrations (version, name, checksum, applied_at_utc)
     VALUES (?, ?, ?, ?)`,
    )
    .run(migration.version, migration.name, migration.checksum, timestamp);
  legacyDb.exec("PRAGMA user_version = 1");
  legacyDb.close();

  let migrated: SqliteStorage | undefined;
  let current: SqliteStorage | undefined;
  try {
    migrated = await openStorage({ rootDir: legacyDir });
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.readReview("legacy-review").state).toBe("QUEUED");
    const backupParent = path.join(legacyDir, "migration-backups");
    const [backupName] = await readdir(backupParent);
    if (backupName === undefined)
      throw new Error("Forward migration did not create its backup.");
    const backupDir = path.join(backupParent, backupName);
    const backupManifest = JSON.parse(
      await readFile(path.join(backupDir, "manifest.json"), "utf8"),
    ) as { schemaVersion: number };
    expect(backupManifest.schemaVersion).toBe(1);
    const backupDb = new Database(path.join(backupDir, "database.sqlite"), {
      readonly: true,
      create: false,
    });
    try {
      expect(
        backupDb
          .query("SELECT review_id FROM reviews WHERE review_id = ?")
          .get("legacy-review"),
      ).toEqual({ review_id: "legacy-review" });
    } finally {
      backupDb.close(true);
    }
    migrated.close();
    migrated = undefined;

    current = await openStorage({ rootDir: path.join(root, "future") });
    current.close();
    current = undefined;
    const futureDb = new Database(path.join(root, "future", "database.sqlite"));
    futureDb.exec("PRAGMA user_version = 999");
    futureDb.close();
    await expect(
      openStorage({ rootDir: path.join(root, "future") }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SCHEMA" });
  } finally {
    await closeStoresAndRemove(root, [migrated, current]);
  }
});

test("refuses to migrate an unversioned database that already contains data", async () => {
  const root = await temporaryRoot();
  const storeDir = path.join(root, "unversioned");
  await mkdir(storeDir, { recursive: true });
  const dbPath = path.join(storeDir, "database.sqlite");
  const unversioned = new Database(dbPath);
  unversioned.exec("CREATE TABLE user_data (value TEXT NOT NULL)");
  unversioned
    .query("INSERT INTO user_data(value) VALUES (?)")
    .run("preserve me");
  unversioned.close();

  await expect(openStorage({ rootDir: storeDir })).rejects.toMatchObject({
    code: "UNSUPPORTED_SCHEMA",
  });
  const check = new Database(dbPath, { readonly: true, create: false });
  try {
    expect(check.query("SELECT value FROM user_data").get()).toEqual({
      value: "preserve me",
    });
    expect(check.query("PRAGMA user_version").get()).toEqual({
      user_version: 0,
    });
  } finally {
    check.close(true);
    await rm(root, { recursive: true, force: true });
  }
});
