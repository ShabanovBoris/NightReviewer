import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DaemonOwner, DaemonReviewRuntime } from "../src/daemon";
import {
  hashCanonicalJson,
  type ProtocolJsonValue,
  type ReviewSubmitInput,
  validProtocolExamples,
  versionHashBindingExample,
} from "../src/protocol";
import { DurableScheduler, FakeReviewerBackend } from "../src/scheduler";
import type { SnapshotManifest, SnapshotService } from "../src/snapshot";
import { openStorage } from "../src/storage";

const repoId = "fixture/offline-demo";
const temporary = await mkdtemp(path.join(os.tmpdir(), "nr08-offline-demo-"));
const store = await openStorage({ rootDir: path.join(temporary, "store") });
const owner = DaemonOwner.acquire(store);
const plans = new Map<string, { scenario: "COMPLETE_WITH_FINDING" }>();
const backend = new FakeReviewerBackend({ plans });
const scheduler = new DurableScheduler({
  store,
  owner,
  backend,
  concurrency: 3,
});
const snapshotService: SnapshotService = {
  async createSnapshot({ cycleId }) {
    const context = store.readSnapshotCycleContext(cycleId);
    const snapshotId = `offline-demo-${cycleId}`;
    const manifest = {
      schemaVersion: "nr-git-snapshot/1",
      snapshotId,
      cycleId,
      repoId: context.repoId,
      objectFormat: context.cycle.revisions.objectFormat,
      baseSha: context.cycle.revisions.baseSha,
      headSha: context.cycle.revisions.headSha,
      coverage: { complete: true, limitations: [] },
      changes: [],
    } as unknown as ProtocolJsonValue;
    await store.recordSnapshot({
      snapshotId,
      cycleId,
      objectFormat: context.cycle.revisions.objectFormat,
      baseSha: context.cycle.revisions.baseSha,
      headSha: context.cycle.revisions.headSha,
      manifestHash: hashCanonicalJson(manifest),
      manifest,
    });
    return manifest as unknown as SnapshotManifest;
  },
  async openSnapshot() {
    throw new Error("The offline scheduler demo does not read snapshot files.");
  },
};
const reviews = new DaemonReviewRuntime({
  store,
  owner,
  snapshotService,
  scheduler,
  trustedRepositoryIds: new Set([repoId]),
  bindingProvider: () => versionHashBindingExample,
});

try {
  const noFindings = await submit("offline no-findings approval");
  const finding = await submit("offline provisional finding");
  plans.set(runId(finding.cycleId), { scenario: "COMPLETE_WITH_FINDING" });
  const cancelled = await submit("offline queued cancellation");

  await reviews.invoke(
    "review_cancel",
    {
      reviewId: cancelled.reviewId,
      reason: "Demonstrate cancellation before worker dispatch.",
      idempotencyKey: "offline-demo-cancel",
    },
    "offline-demo-cancel",
  );

  await scheduler.start();
  reviews.start();
  await waitFor(() => {
    const progress = scheduler.progress(finding.cycleId);
    return (
      store.readCycle(noFindings.cycleId).state === "APPROVED" &&
      store.readCycle(finding.cycleId).state === "AGGREGATING" &&
      progress.provisionalFindings.length === 1
    );
  });

  const findingStatus = (await reviews.invoke(
    "review_status",
    { reviewId: finding.reviewId },
    "offline-demo-status",
  )) as {
    state: string;
    scheduler?: {
      backend: string;
      qualification: string;
      provisionalFindings: readonly unknown[];
    };
  };
  const result = {
    classification: "OFFLINE_SCHEDULER_FAKE",
    backend: "FAKE",
    qualification: "OFFLINE_ONLY",
    networkRequests: 0,
    noFindings: {
      cycleId: noFindings.cycleId,
      state: store.readCycle(noFindings.cycleId).state,
    },
    finding: {
      cycleId: finding.cycleId,
      state: findingStatus.state,
      provisionalFindings:
        findingStatus.scheduler?.provisionalFindings.length ?? 0,
      semanticAdjudication: "NOT_PERFORMED",
    },
    cancellation: {
      cycleId: cancelled.cycleId,
      state: store.readCycle(cancelled.cycleId).state,
      workerInvocations: backend.invocationContexts.filter(
        (invocation) => invocation.cycleId === cancelled.cycleId,
      ).length,
    },
    maxObservedConcurrency: backend.maxObservedConcurrency,
  };
  if (
    result.noFindings.state !== "APPROVED" ||
    result.finding.state !== "AGGREGATING" ||
    result.finding.provisionalFindings !== 1 ||
    result.cancellation.state !== "CANCELLED" ||
    result.cancellation.workerInvocations !== 0 ||
    result.maxObservedConcurrency > 3
  ) {
    throw new Error(
      "The offline scheduler demo did not satisfy its assertions.",
    );
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await reviews.drain(1_000);
  owner.release();
  store.close();
  await rm(temporary, { recursive: true, force: true });
}

async function submit(
  task: string,
): Promise<{ reviewId: string; cycleId: string }> {
  const submission: ReviewSubmitInput = {
    ...validProtocolExamples.reviewSubmitInput,
    repoId,
    task,
    acceptanceCriteria: [
      {
        id: "AC1",
        requirement: "Exercise the deterministic offline scheduler.",
      },
    ],
    idempotencyKey: `offline-demo-${task.replaceAll(" ", "-")}`,
  };
  return (await reviews.invoke(
    "review_submit",
    submission,
    submission.idempotencyKey,
  )) as { reviewId: string; cycleId: string };
}

function runId(cycleId: string): string {
  const digest = createHash("sha256")
    .update(`${cycleId}:correctness:1`)
    .digest("hex");
  return `run-${digest.slice(0, 32)}`;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(
        "The offline scheduler demo did not reach its terminal state.",
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}
