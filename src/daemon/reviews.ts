import { Buffer } from "node:buffer";
import {
  createVersionHashBinding,
  defaultStrictPolicy,
  hashCanonicalJson,
  type ProtocolError,
  type ProtocolSchemaName,
  type ProtocolValueBySchema,
  protocolSchemas,
  type ReviewCancelInput,
  type ReviewCancelResult,
  type ReviewEvent,
  type ReviewState,
  type ReviewStatusResult,
  type ReviewSubmitInput,
  type ReviewSubmitResult,
  type VersionHashBinding,
  validateProtocolValue,
} from "../protocol";
import type { DurableScheduler } from "../scheduler";
import type { SnapshotService } from "../snapshot";
import { defaultSnapshotLimits, SnapshotError } from "../snapshot";
import type { CanonicalFindingRecord, SnapshotCycleContext } from "../storage";
import { type SqliteStorage, StorageError } from "../storage";
import type { DaemonOwner } from "./owner";
import type { DaemonRpcMethod } from "./types";

const CALLER_ID = "local-implementer";
const EVENT_PAGE_SIZE = 100;
const STRICT_REQUIRED_RUNS = 9;
type ReviewNextAction = ReviewStatusResult["nextAction"];
const NEXT_ACTION: Record<ReviewState, ReviewNextAction> = {
  QUEUED: "WAIT",
  SNAPSHOTTING: "WAIT",
  REVIEWING: "WAIT",
  AGGREGATING: "WAIT",
  NEEDS_FIX: "SUBMIT_FIX",
  VERIFYING_FIX: "VERIFY_FIX",
  PAUSED: "CONTACT_LEAD",
  REQUIRES_FRESH_REVIEW: "START_FRESH_REVIEW",
  CANCEL_REQUESTED: "WAIT",
  APPROVED: "NONE",
  FAILED: "NONE",
  CANCELLED: "NONE",
};
const REVIEW_STATES = new Set<ReviewState>(
  Object.keys(NEXT_ACTION) as ReviewState[],
);

export class ReviewRuntimeError extends Error {
  constructor(readonly protocolError: ProtocolError) {
    super(protocolError.message);
    this.name = "ReviewRuntimeError";
  }
}

export interface ReviewRuntimeOptions {
  readonly store: SqliteStorage;
  readonly owner: DaemonOwner;
  readonly snapshotService: SnapshotService;
  readonly trustedRepositoryIds: ReadonlySet<string>;
  readonly bindingProvider?: (input: ReviewSubmitInput) => VersionHashBinding;
  readonly drainTimeoutMs?: number;
  readonly scheduler?: DurableScheduler;
}

interface ActiveSnapshot {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

export class DaemonReviewRuntime {
  private readonly activeSnapshots = new Map<string, ActiveSnapshot>();
  private readonly bindingProvider: (
    input: ReviewSubmitInput,
  ) => VersionHashBinding;
  private readonly drainTimeoutMs: number;
  private readonly scheduler: DurableScheduler | undefined;
  private started = false;
  private pumping = false;
  private pumpScheduled = false;
  private draining = false;
  private activeMutations = 0;
  private readonly quiescenceWaiters = new Set<() => void>();

  constructor(private readonly options: ReviewRuntimeOptions) {
    this.bindingProvider = options.bindingProvider ?? defaultBindingProvider;
    this.drainTimeoutMs =
      options.drainTimeoutMs ?? defaultSnapshotLimits.maxCreationTimeMs + 5_000;
    this.scheduler = options.scheduler;
  }

  start(): void {
    if (this.started || this.draining) return;
    this.started = true;
    this.schedulePump();
  }

  async invoke(
    method: DaemonRpcMethod,
    params: unknown,
    correlationId: string,
  ): Promise<unknown> {
    const isMutation =
      method === "review_submit" ||
      method === "review_submit_fix" ||
      method === "review_cancel";
    if (isMutation && this.draining) {
      throw failure(
        "BACKEND_UNAVAILABLE",
        "Daemon is draining and does not accept new mutations.",
        true,
        correlationId,
      );
    }
    if (isMutation) this.activeMutations += 1;
    try {
      switch (method) {
        case "handshake":
          throw failure(
            "INVALID_ARGUMENT",
            "Handshake is handled by the daemon endpoint.",
            false,
            correlationId,
          );
        case "review_submit":
          return await this.submit(params, correlationId);
        case "review_status":
          return this.status(params, correlationId);
        case "review_submit_fix":
          return this.submitFix(params, correlationId);
        case "review_cancel":
          return await this.cancel(params, correlationId);
      }
    } finally {
      if (isMutation) {
        this.activeMutations -= 1;
        this.signalQuiescence();
      }
    }
  }

  async drain(timeoutMs = this.drainTimeoutMs): Promise<void> {
    this.draining = true;
    const didSettle = await this.waitForQuiescence(timeoutMs);
    if (!didSettle) {
      for (const entry of this.activeSnapshots.values())
        entry.controller.abort();
    }
    await this.scheduler?.drain(timeoutMs);
  }

  private async submit(
    value: unknown,
    correlationId: string,
  ): Promise<ReviewSubmitResult> {
    const input = requireProtocolValue(
      "reviewSubmitInput",
      value,
      correlationId,
    );
    if (this.draining) {
      throw failure(
        "BACKEND_UNAVAILABLE",
        "Daemon is draining and does not accept new reviews.",
        true,
        correlationId,
      );
    }
    if (!this.options.trustedRepositoryIds.has(input.repoId)) {
      throw failure(
        "FORBIDDEN",
        "Repository is not in the trusted local allowlist.",
        false,
        correlationId,
      );
    }
    const versionBinding = this.bindingProvider(input);
    const reviewContextHash = hashCanonicalJson({
      repoId: input.repoId,
      task: input.task,
      acceptanceCriteria: input.acceptanceCriteria,
      profile: input.profile,
      revisions: {
        objectFormat: input.objectFormat,
        baseSha: input.baseSha,
        headSha: input.headSha,
      },
      versionBinding,
    });
    const created = await this.options.store.createReview({
      callerId: CALLER_ID,
      submission: input,
      reviewContextHash,
      versionBinding,
      fencing: this.currentFence(correlationId),
    });
    this.schedulePump();
    const result = {
      reviewId: created.reviewId,
      cycleId: created.cycleId,
      revisions: created.revisions,
      state: created.state,
      stateVersion: created.stateVersion,
      versionBinding: created.versionBinding,
    };
    return requireProtocolValue("reviewSubmitResult", result, correlationId);
  }

  private status(value: unknown, correlationId: string): ReviewStatusResult {
    const input = requireProtocolValue(
      "reviewStatusInput",
      value,
      correlationId,
    );
    const review = this.options.store.readReview(input.reviewId);
    const afterEventSeq =
      input.cursor === undefined
        ? 0
        : decodeCursor(
            input.cursor,
            review.reviewId,
            review.cycleId,
            correlationId,
          );
    const page = this.options.store.readEventPage(
      review.cycleId,
      afterEventSeq,
      EVENT_PAGE_SIZE,
    );
    const snapshots = this.options.store.readSnapshots(review.cycleId);
    const snapshot = snapshots.at(-1);
    const coverage =
      snapshot === undefined
        ? { complete: false, paths: [], limitations: ["snapshot pending"] }
        : snapshotCoverage(snapshot.manifest);
    const events: ReviewEvent[] = page.events.map((event) =>
      toReviewEvent(event, review.state, review.stateVersion),
    );
    const nextCursor =
      page.hasMore && page.events.length > 0
        ? encodeCursor(
            review.reviewId,
            review.cycleId,
            page.events.at(-1)?.eventSeq as number,
          )
        : null;
    const findings = this.options.store
      .readCanonicalFindings(review.cycleId)
      .map((finding) => canonicalFinding(finding, correlationId));
    const scheduler = this.scheduler?.progress(review.cycleId);
    const result = {
      reviewId: review.reviewId,
      cycleId: review.cycleId,
      revisions: review.revisions,
      state: review.state,
      stateVersion: review.stateVersion,
      progress: {
        completedRuns: scheduler?.completedRuns ?? 0,
        requiredRuns: scheduler?.requiredRuns ?? STRICT_REQUIRED_RUNS,
        activeRuns: scheduler?.activeRuns ?? 0,
      },
      ...(scheduler === undefined
        ? {}
        : {
            scheduler: {
              backend: scheduler.backend,
              qualification: scheduler.qualification,
              state: scheduler.state,
              retryWaitingRuns: scheduler.retryWaitingRuns,
              reconciliationRequiredRuns: scheduler.reconciliationRequiredRuns,
              failedRuns: scheduler.failedRuns,
              provisionalFindings: scheduler.provisionalFindings,
            },
          }),
      findings,
      coverage,
      nextAction: NEXT_ACTION[review.state],
      errors: [],
      events,
      nextCursor,
      versionBinding: review.versionBinding,
    };
    return requireProtocolValue("reviewStatusResult", result, correlationId);
  }

  private submitFix(value: unknown, correlationId: string): never {
    const input = requireProtocolValue(
      "reviewSubmitFixInput",
      value,
      correlationId,
    );
    if (this.draining) {
      throw failure(
        "BACKEND_UNAVAILABLE",
        "Daemon is draining and does not accept new mutations.",
        true,
        correlationId,
      );
    }
    const review = this.options.store.readReview(input.reviewId);
    if (
      input.objectFormat !== review.revisions.objectFormat ||
      input.previousSha !== review.revisions.headSha ||
      input.headSha === input.previousSha ||
      review.state !== "NEEDS_FIX"
    ) {
      throw failure(
        "CONFLICT",
        "Fix request does not match the current review cycle.",
        false,
        correlationId,
      );
    }
    const cycle = review.cycle;
    if (cycle.state !== "NEEDS_FIX") {
      throw failure(
        "CONFLICT",
        "Fix request does not match the current review cycle.",
        false,
        correlationId,
      );
    }
    const submittedFindingIds = input.resolutions.map(
      ({ findingId }) => findingId,
    );
    if (new Set(submittedFindingIds).size !== submittedFindingIds.length) {
      throw failure(
        "INVALID_ARGUMENT",
        "Fix submission contains duplicate finding IDs.",
        false,
        correlationId,
      );
    }
    if (input.resolutions.some(({ note }) => note.trim().length === 0)) {
      throw failure(
        "INVALID_ARGUMENT",
        "Fix resolution note cannot be empty.",
        false,
        correlationId,
      );
    }
    const requiredFindingIds = new Set(cycle.requiredFindingIds);
    if (
      submittedFindingIds.length !== requiredFindingIds.size ||
      submittedFindingIds.some(
        (findingId) => !requiredFindingIds.has(findingId),
      )
    ) {
      throw failure(
        "INVALID_ARGUMENT",
        "Fix resolutions must cover exactly the authoritative finding IDs.",
        false,
        correlationId,
      );
    }
    throw failure(
      "BACKEND_UNAVAILABLE",
      "Fix processing is not available before the assigned backend phase.",
      false,
      correlationId,
    );
  }

  private async cancel(
    value: unknown,
    correlationId: string,
  ): Promise<ReviewCancelResult> {
    const input = requireProtocolValue(
      "reviewCancelInput",
      value,
      correlationId,
    );
    if (this.draining) {
      throw failure(
        "BACKEND_UNAVAILABLE",
        "Daemon is draining and does not accept new mutations.",
        true,
        correlationId,
      );
    }
    let review = this.options.store.readReview(input.reviewId);
    if (review.state === "CANCELLED")
      return cancelResult(review, correlationId);
    if (review.state === "APPROVED" || review.state === "FAILED") {
      throw failure(
        "CONFLICT",
        "Terminal review cycles cannot be cancelled.",
        false,
        correlationId,
      );
    }

    if (review.state !== "CANCEL_REQUESTED") {
      const requestTransitionKey = `cancel-request-${hashCanonicalJson({
        reviewId: review.reviewId,
        cycleId: review.cycleId,
        idempotencyKey: input.idempotencyKey,
      })}`;
      try {
        this.options.store.applyCycleCommand(
          CALLER_ID,
          review.cycleId,
          {
            type: "REQUEST_CANCEL",
            reason: input.reason,
            expectedVersion: review.stateVersion,
            idempotencyKey: requestTransitionKey,
          },
          { ownerFencing: this.currentFence(correlationId) },
        );
      } catch (error) {
        if (!(error instanceof StorageError) || error.code !== "CONFLICT")
          throw error;
        review = this.options.store.readReview(input.reviewId);
        if (review.state !== "CANCEL_REQUESTED") {
          this.options.store.applyCycleCommand(
            CALLER_ID,
            review.cycleId,
            {
              type: "REQUEST_CANCEL",
              reason: input.reason,
              expectedVersion: review.stateVersion,
              idempotencyKey: requestTransitionKey,
            },
            { ownerFencing: this.currentFence(correlationId) },
          );
        }
      }
      review = this.options.store.readReview(input.reviewId);
    }

    await this.scheduler?.cancelCycle(review.cycleId);
    const active = this.activeSnapshots.get(review.cycleId);
    if (active !== undefined) {
      active.controller.abort();
      await active.promise.catch(() => undefined);
      review = this.options.store.readReview(input.reviewId);
    }
    if (review.state === "CANCEL_REQUESTED") {
      review = this.confirmCancel(review, input, correlationId);
    }
    return cancelResult(review, correlationId);
  }

  private confirmCancel(
    review: ReturnType<SqliteStorage["readReview"]>,
    input: ReviewCancelInput,
    correlationId: string,
  ): ReturnType<SqliteStorage["readReview"]> {
    const idempotencyKey = `confirm-${hashCanonicalJson({
      reviewId: review.reviewId,
      cycleId: review.cycleId,
      idempotencyKey: input.idempotencyKey,
    })}`;
    this.options.store.applyCycleCommand(
      CALLER_ID,
      review.cycleId,
      {
        type: "CONFIRM_CANCEL",
        fencingAndRevocationConfirmed: true,
        expectedVersion: review.stateVersion,
        idempotencyKey,
      },
      { ownerFencing: this.currentFence(correlationId) },
    );
    return this.options.store.readReview(review.reviewId);
  }

  private schedulePump(): void {
    if (!this.started || this.draining || this.pumping || this.pumpScheduled)
      return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.draining || this.pumping) return;
    if (!this.options.owner.isCurrent()) {
      this.draining = true;
      return;
    }
    this.pumping = true;
    try {
      const pending = this.options.store.readDaemonPendingCycles(100);
      for (const cycle of pending) {
        if (this.draining) break;
        if (this.activeSnapshots.has(cycle.cycleId)) continue;
        if (cycle.cycle.state === "CANCEL_REQUESTED") {
          this.confirmRecoveredCancellation(cycle);
          continue;
        }
        await this.runSnapshot(cycle);
      }
    } finally {
      this.pumping = false;
      if (!this.draining && this.hasUnownedPendingWork()) this.schedulePump();
    }
  }

  private async runSnapshot(initial: SnapshotCycleContext): Promise<void> {
    const controller = new AbortController();
    const promise = this.prepareSnapshot(initial, controller.signal);
    const active = { controller, promise };
    this.activeSnapshots.set(initial.cycleId, active);
    try {
      await promise;
    } finally {
      if (this.activeSnapshots.get(initial.cycleId) === active) {
        this.activeSnapshots.delete(initial.cycleId);
      }
      this.signalQuiescence();
    }
  }

  private async prepareSnapshot(
    initial: SnapshotCycleContext,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      let context = this.options.store.readSnapshotCycleContext(
        initial.cycleId,
      );
      if (context.cycle.state === "QUEUED") {
        this.options.store.applyCycleCommand(
          CALLER_ID,
          context.cycleId,
          {
            type: "ADVANCE",
            target: "SNAPSHOTTING",
            expectedVersion: context.cycle.stateVersion,
            idempotencyKey: `snapshot-start-${context.cycleId}-${context.cycle.stateVersion}`,
          },
          { ownerFencing: this.options.owner.fencingToken() },
        );
        context = this.options.store.readSnapshotCycleContext(context.cycleId);
      }
      if (context.cycle.state === "CANCEL_REQUESTED" || signal.aborted) return;
      if (context.cycle.state !== "SNAPSHOTTING") return;

      let snapshot = this.options.store
        .readSnapshots(context.cycleId)
        .find(
          (candidate) =>
            candidate.objectFormat === context.cycle.revisions.objectFormat &&
            candidate.baseSha === context.cycle.revisions.baseSha &&
            candidate.headSha === context.cycle.revisions.headSha,
        );
      if (snapshot === undefined) {
        const manifest = await this.options.snapshotService.createSnapshot({
          cycleId: context.cycleId,
          signal,
        });
        snapshot = this.options.store
          .readSnapshots(context.cycleId)
          .find((candidate) => candidate.snapshotId === manifest.snapshotId);
      }
      if (signal.aborted) return;
      context = this.options.store.readSnapshotCycleContext(context.cycleId);
      if (context.cycle.state === "CANCEL_REQUESTED") return;
      if (context.cycle.state !== "SNAPSHOTTING" || snapshot === undefined)
        return;
      this.options.store.applyCycleCommand(
        CALLER_ID,
        context.cycleId,
        {
          type: "ADVANCE",
          target: "REVIEWING",
          expectedVersion: context.cycle.stateVersion,
          idempotencyKey: `snapshot-ready-${snapshot.manifestHash}`,
          evidence: {
            durableManifestRecorded: true,
            manifestHash: snapshot.manifestHash,
          },
        },
        { ownerFencing: this.options.owner.fencingToken() },
      );
      const reviewingContext = this.options.store.readSnapshotCycleContext(
        context.cycleId,
      );
      this.scheduler?.activateCycle(reviewingContext);
    } catch (error) {
      if (signal.aborted) return;
      try {
        const context = this.options.store.readSnapshotCycleContext(
          initial.cycleId,
        );
        if (context.cycle.state === "CANCEL_REQUESTED") return;
        if (context.cycle.state === "SNAPSHOTTING") {
          this.options.store.applyCycleCommand(
            CALLER_ID,
            context.cycleId,
            {
              type: "ADVANCE",
              target: "FAILED",
              expectedVersion: context.cycle.stateVersion,
              idempotencyKey: `snapshot-failed-${context.cycleId}-${context.cycle.stateVersion}`,
              evidence: { failureCode: snapshotFailureCode(error) },
            },
            { ownerFencing: this.options.owner.fencingToken() },
          );
        }
      } catch {
        // Ownership loss leaves the accepted cycle durable for the next owner.
      }
    }
  }

  private confirmRecoveredCancellation(context: SnapshotCycleContext): void {
    try {
      const input: ReviewCancelInput = {
        reviewId: context.reviewId,
        reason:
          context.cycle.state === "CANCEL_REQUESTED"
            ? context.cycle.cancelReason
            : "Recovered cancellation request.",
        idempotencyKey: `recover-${hashCanonicalJson({ cycleId: context.cycleId, stateVersion: context.cycle.stateVersion })}`,
      };
      this.confirmCancel(
        this.options.store.readReview(context.reviewId),
        input,
        `recover-${context.cycleId}`,
      );
    } catch {
      // Keep the durable CANCEL_REQUESTED state if ownership was lost.
    }
  }

  private hasUnownedPendingWork(): boolean {
    try {
      if (!this.options.owner.isCurrent()) return false;
      return this.options.store
        .readDaemonPendingCycles(100)
        .some((cycle) => !this.activeSnapshots.has(cycle.cycleId));
    } catch {
      return false;
    }
  }

  private currentFence(correlationId: string) {
    try {
      return this.options.owner.fencingToken();
    } catch {
      throw failure(
        "CONFLICT",
        "Daemon ownership is no longer current.",
        false,
        correlationId,
      );
    }
  }

  private waitForQuiescence(timeoutMs: number): Promise<boolean> {
    if (this.activeMutations === 0 && this.activeSnapshots.size === 0) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (settled: boolean) => {
        if (timeout !== undefined) clearTimeout(timeout);
        this.quiescenceWaiters.delete(onQuiescence);
        resolve(settled);
      };
      const onQuiescence = () => finish(true);
      this.quiescenceWaiters.add(onQuiescence);
      timeout = setTimeout(() => finish(false), timeoutMs);
    });
  }

  private signalQuiescence(): void {
    if (this.activeMutations !== 0 || this.activeSnapshots.size !== 0) return;
    for (const resolve of this.quiescenceWaiters) resolve();
    this.quiescenceWaiters.clear();
  }
}

function defaultBindingProvider(_input: ReviewSubmitInput): VersionHashBinding {
  const result = createVersionHashBinding({
    schemaDocument: protocolSchemas.reviewSubmitInput,
    promptVersion: "nr07-no-worker/1",
    promptBytes:
      "NR-07 persists and snapshots reviews; worker dispatch starts in NR-08.",
    policyVersion: defaultStrictPolicy.policyVersion,
    policyDocument: defaultStrictPolicy,
  });
  if (!result.ok) {
    throw new Error(
      "Daemon could not derive immutable review version bindings.",
    );
  }
  return result.binding;
}

function requireProtocolValue<K extends ProtocolSchemaName>(
  name: K,
  value: unknown,
  correlationId: string,
): ProtocolValueBySchema[K] {
  const result = validateProtocolValue(name, value);
  if (!result.ok) {
    throw failure(
      "INVALID_ARGUMENT",
      "Request does not match the NR-03 protocol schema.",
      false,
      correlationId,
    );
  }
  return result.value;
}

function failure(
  code: ProtocolError["code"],
  message: string,
  retryable: boolean,
  correlationId: string,
): ReviewRuntimeError {
  const validation = validateProtocolValue("protocolError", {
    code,
    message,
    retryable,
    correlationId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(correlationId)
      ? correlationId
      : "daemon",
  });
  if (!validation.ok)
    throw new Error("Daemon error mapping violated the NR-03 schema.");
  return new ReviewRuntimeError(validation.value);
}

function cancelResult(
  review: ReturnType<SqliteStorage["readReview"]>,
  correlationId: string,
): ReviewCancelResult {
  return requireProtocolValue(
    "reviewCancelResult",
    {
      reviewId: review.reviewId,
      cycleId: review.cycleId,
      state: review.state,
      stateVersion: review.stateVersion,
    },
    correlationId,
  );
}

function canonicalFinding(
  finding: CanonicalFindingRecord,
  correlationId: string,
): unknown {
  const value = validateProtocolValue("canonicalFinding", finding.payload);
  if (!value.ok) {
    throw failure(
      "NEEDS_RECONCILIATION",
      "Stored canonical finding is malformed.",
      false,
      correlationId,
    );
  }
  return value.value;
}

function snapshotCoverage(manifest: unknown): ReviewStatusResult["coverage"] {
  if (!isRecord(manifest) || !isRecord(manifest.coverage)) {
    throw new Error("Stored snapshot manifest has no coverage record.");
  }
  const changes = Array.isArray(manifest.changes) ? manifest.changes : [];
  const paths = [
    ...new Set(
      changes.flatMap((change) =>
        isRecord(change) && typeof change.path === "string"
          ? [change.path]
          : [],
      ),
    ),
  ];
  const limitations = Array.isArray(manifest.coverage.limitations)
    ? manifest.coverage.limitations.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  return {
    complete: manifest.coverage.complete === true,
    paths,
    limitations,
  };
}

function toReviewEvent(
  event: {
    readonly eventId: string;
    readonly eventType: string;
    readonly payload: unknown;
    readonly occurredAtUtc: string;
  },
  fallbackState: ReviewState,
  fallbackVersion: number,
): ReviewEvent {
  const payload = isRecord(event.payload) ? event.payload : {};
  const nestedState = isRecord(payload.state) ? payload.state : undefined;
  const stateValue = nestedState?.state ?? payload.state;
  const versionValue = nestedState?.stateVersion ?? payload.stateVersion;
  const state =
    typeof stateValue === "string" &&
    REVIEW_STATES.has(stateValue as ReviewState)
      ? (stateValue as ReviewState)
      : fallbackState;
  const stateVersion =
    Number.isSafeInteger(versionValue) && (versionValue as number) >= 0
      ? (versionValue as number)
      : fallbackVersion;
  return {
    eventId: event.eventId,
    state,
    stateVersion,
    occurredAt: event.occurredAtUtc,
    summary: eventSummary(event.eventType, state),
  };
}

function eventSummary(eventType: string, state: ReviewState): string {
  switch (eventType) {
    case "review.created":
      return "Review durably accepted.";
    case "review.cycle_transitioned":
      return `Review entered ${state}.`;
    case "review.child_cycle_created":
      return "A new review cycle was created.";
    case "snapshot.recorded":
      return "Immutable snapshot evidence was persisted.";
    case "finding.canonical_recorded":
      return "A canonical finding was recorded.";
    default:
      return "Review event recorded.";
  }
}

function encodeCursor(
  reviewId: string,
  cycleId: string,
  afterEventSeq: number,
): string {
  return Buffer.from(
    JSON.stringify({ reviewId, cycleId, afterEventSeq }),
  ).toString("base64url");
}

function decodeCursor(
  cursor: string,
  reviewId: string,
  cycleId: string,
  correlationId: string,
): number {
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor)
      throw new Error("Non-canonical cursor.");
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 3 ||
      typeof value.reviewId !== "string" ||
      typeof value.cycleId !== "string" ||
      !Number.isSafeInteger(value.afterEventSeq) ||
      (value.afterEventSeq as number) < 0
    ) {
      throw new Error("Malformed cursor.");
    }
    if (value.reviewId !== reviewId || value.cycleId !== cycleId) {
      throw failure(
        "CONFLICT",
        "Event cursor belongs to another review cycle.",
        false,
        correlationId,
      );
    }
    return value.afterEventSeq as number;
  } catch (error) {
    if (error instanceof ReviewRuntimeError) throw error;
    throw failure(
      "INVALID_ARGUMENT",
      "Event cursor is invalid.",
      false,
      correlationId,
    );
  }
}

function snapshotFailureCode(
  error: unknown,
):
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "RESOURCE_EXHAUSTED"
  | "BACKEND_UNAVAILABLE" {
  if (!(error instanceof SnapshotError)) return "BACKEND_UNAVAILABLE";
  if (error.code === "LIMIT_EXCEEDED") return "RESOURCE_EXHAUSTED";
  if (
    error.code === "INVALID_ARGUMENT" ||
    error.code === "REVISION_INVALID" ||
    error.code === "ANCESTRY_VIOLATION"
  ) {
    return "INVALID_ARGUMENT";
  }
  if (error.code === "NOT_FOUND") return "NOT_FOUND";
  return "BACKEND_UNAVAILABLE";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
