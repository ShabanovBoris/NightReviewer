import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  protocolExampleSha256,
  type ReviewSubmitInput,
  validProtocolExamples,
  versionHashBindingExample,
} from "../../src/protocol";
import {
  daemonOwnershipResourceId,
  openStorage,
  type SqliteStorage,
} from "../../src/storage";

const timestamp = "2026-10-04T12:00:00.000Z";

test("daemon ownership fencing prevents a former owner from mutating a cycle", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "nightreviewer-daemon-store-"),
  );
  let store: SqliteStorage | undefined;
  try {
    store = await openStorage({ rootDir: path.join(temporary, "store") });
    const resourceId = daemonOwnershipResourceId(store.rootDir);
    const ownerA = store.acquireLease(resourceId, "daemon-a", 1_000, timestamp);
    const created = await store.createReview({
      callerId: "test-caller",
      submission: submitInput("owner-fence-submit"),
      reviewContextHash: protocolExampleSha256,
      versionBinding: versionHashBindingExample,
      createdAtUtc: timestamp,
      fencing: ownerA,
    });
    const ownerB = store.acquireLease(
      resourceId,
      "daemon-b",
      1_000,
      "2026-10-04T12:00:02.000Z",
    );
    expect(ownerB.token).toBe(ownerA.token + 1);
    expect(() =>
      store?.applyCycleCommand(
        "daemon",
        created.cycleId,
        {
          type: "ADVANCE",
          target: "SNAPSHOTTING",
          expectedVersion: 0,
          idempotencyKey: "former-owner-transition",
        },
        {
          occurredAtUtc: "2026-10-04T12:00:02.100Z",
          ownerFencing: ownerA,
        },
      ),
    ).toThrow("stale, expired, or non-current fencing token");
    expect(store.readCycle(created.cycleId).state).toBe("QUEUED");
    expect(store.hasLeaseOwnership(ownerB, "2026-10-04T12:00:02.100Z")).toBe(
      true,
    );
  } finally {
    store?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("durable event pages retain sequence order across repeated reads", async () => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "nightreviewer-event-page-"),
  );
  let store: SqliteStorage | undefined;
  try {
    store = await openStorage({ rootDir: path.join(temporary, "store") });
    const created = await store.createReview({
      callerId: "test-caller",
      submission: submitInput("event-page-submit"),
      reviewContextHash: protocolExampleSha256,
      versionBinding: versionHashBindingExample,
      createdAtUtc: timestamp,
    });
    for (let index = 0; index < 101; index += 1) {
      store.recordOutboxEvent(
        created.reviewId,
        created.cycleId,
        "test.event",
        { index },
        timestamp,
      );
    }
    const first = store.readEventPage(created.cycleId, 0, 100);
    const firstRepeated = store.readEventPage(created.cycleId, 0, 100);
    expect(first).toEqual(firstRepeated);
    expect(first.events).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    const second = store.readEventPage(
      created.cycleId,
      first.events.at(-1)?.eventSeq ?? 0,
      100,
    );
    expect(second.events).toHaveLength(2);
    expect(second.hasMore).toBe(false);
    expect(second.events[0]?.eventSeq).toBeGreaterThan(
      first.events.at(-1)?.eventSeq ?? 0,
    );
  } finally {
    store?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

function submitInput(idempotencyKey: string): ReviewSubmitInput {
  return {
    ...validProtocolExamples.reviewSubmitInput,
    idempotencyKey,
  };
}
