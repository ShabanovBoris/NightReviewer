import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { DaemonOwner } from "../daemon/owner";
import type {
  ApprovalEvidence,
  ProtocolJsonValue,
  WorkerDirection,
} from "../protocol";
import {
  canonicalJson,
  evaluateApprovalEvidence,
  validateProtocolValue,
} from "../protocol";
import type {
  ClaimedSchedulerJob,
  SchedulerAggregationInput,
  SchedulerAttemptResultInput,
  SchedulerProvisionalFinding,
  SchedulerReconciliationInput,
  SchedulerSelectedRun,
  SnapshotCycleContext,
  SqliteStorage,
} from "../storage";
import { FakeReviewerBackend, systemSchedulerClock } from "./backend";
import type {
  BackendFailureClass,
  BackendInvocationInput,
  BackendInvocationResult,
  BackendReconciliationResult,
  BackendResultEvidence,
  ReviewerBackend,
  SchedulerClock,
  SchedulerRunSeed,
} from "./types";

const DIRECTIONS: readonly WorkerDirection[] = [
  "correctness",
  "tests",
  "design",
];
const FAKE_REQUIRED_RUNS = DIRECTIONS.length * 3;

interface ActiveClaim {
  readonly cycleId: string;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
  sendState: "UNSENT" | "UNKNOWN";
}

type BackendRaceResult<T> =
  | { readonly kind: "RESULT"; readonly value: T }
  | { readonly kind: "TIMEOUT" }
  | { readonly kind: "ABORTED" }
  | { readonly kind: "ERROR"; readonly error: unknown };

export interface SchedulerRuntimeOptions {
  readonly store: SqliteStorage;
  readonly owner: DaemonOwner;
  readonly backend?: ReviewerBackend;
  readonly concurrency?: number;
  readonly maxAttempts?: number;
  readonly attemptTimeoutMs?: number;
  readonly leaseTtlMs?: number;
  readonly reviewDeadlineMs?: number;
  readonly maxBackoffMs?: number;
  readonly jitter?: (runId: string, attemptNumber: number) => number;
  readonly clock?: SchedulerClock;
  readonly drainTimeoutMs?: number;
}

export class DurableScheduler {
  readonly concurrency: number;
  readonly backend: ReviewerBackend;
  private readonly store: SqliteStorage;
  private readonly owner: DaemonOwner;
  private readonly maxAttempts: number;
  private readonly attemptTimeoutMs: number;
  private readonly leaseTtlMs: number;
  private readonly reviewDeadlineMs: number;
  private readonly maxBackoffMs: number;
  private readonly jitter: (runId: string, attemptNumber: number) => number;
  private readonly clock: SchedulerClock;
  private readonly drainTimeoutMs: number;
  private readonly seedsByCycle = new Map<
    string,
    readonly SchedulerRunSeed[]
  >();
  private readonly active = new Map<string, ActiveClaim>();
  private started = false;
  private draining = false;
  private pumping = false;
  private pumpScheduled = false;
  private wakeController: AbortController | undefined;
  maxObservedConcurrency = 0;

  constructor(options: SchedulerRuntimeOptions) {
    this.store = options.store;
    this.owner = options.owner;
    this.concurrency = options.concurrency ?? 3;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? 180_000;
    this.leaseTtlMs = options.leaseTtlMs ?? this.attemptTimeoutMs + 30_000;
    this.reviewDeadlineMs = options.reviewDeadlineMs ?? 900_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.jitter = options.jitter ?? deterministicJitter;
    this.clock = options.clock ?? systemSchedulerClock;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 10_000;
    this.backend =
      options.backend ?? new FakeReviewerBackend({ clock: this.clock });
    if (
      !Number.isSafeInteger(this.concurrency) ||
      this.concurrency < 1 ||
      this.concurrency > 36 ||
      !Number.isSafeInteger(this.maxAttempts) ||
      this.maxAttempts < 1 ||
      this.maxAttempts > 10 ||
      !Number.isSafeInteger(this.attemptTimeoutMs) ||
      this.attemptTimeoutMs < 1 ||
      !Number.isSafeInteger(this.leaseTtlMs) ||
      this.leaseTtlMs <= this.attemptTimeoutMs ||
      !Number.isSafeInteger(this.reviewDeadlineMs) ||
      this.reviewDeadlineMs < this.attemptTimeoutMs ||
      !Number.isSafeInteger(this.maxBackoffMs) ||
      this.maxBackoffMs < 1
    ) {
      throw new TypeError("Scheduler bounds are invalid.");
    }
  }

  async start(): Promise<void> {
    if (this.started || this.draining) return;
    this.started = true;
    for (const cycle of this.store.readReviewingSchedulerCycles()) {
      this.activateCycle(cycle);
    }
    for (const cycle of this.store.readAggregatingSchedulerCycles()) {
      await this.maybeAdvanceCycle(cycle.cycleId);
    }
    this.schedulePump();
  }

  activateCycle(context: SnapshotCycleContext): void {
    if (
      context.cycle.state !== "REVIEWING" ||
      context.cycle.manifestHash === null
    ) {
      return;
    }
    const seeds = this.makeRunSeeds(context);
    this.store.ensureSchedulerRuns({
      cycleId: context.cycleId,
      backendBinding: this.backend.profile,
      runs: seeds,
      ownerFencing: this.owner.fencingToken(),
      nowUtc: this.nowUtc(),
    });
    this.seedsByCycle.set(context.cycleId, seeds);
    this.cancelWakeTimer();
    this.schedulePump();
  }

  progress(cycleId: string) {
    return this.store.readSchedulerCycleStatus(cycleId);
  }

  async cancelCycle(cycleId: string): Promise<void> {
    const active = [...this.active.entries()].filter(
      ([, entry]) => entry.cycleId === cycleId,
    );
    this.store.cancelSchedulerCycle({
      cycleId,
      ownerFencing: this.owner.fencingToken(),
      activeAttemptSendStates: active.map(([attemptId, entry]) => ({
        attemptId,
        sendState: entry.sendState,
      })),
      occurredAtUtc: this.nowUtc(),
    });
    const activeClaims = active.map(([, entry]) => entry);
    for (const entry of activeClaims) entry.controller.abort();
    await this.waitForClaims(activeClaims, this.drainTimeoutMs);
  }

  async drain(timeoutMs = this.drainTimeoutMs): Promise<void> {
    this.draining = true;
    this.cancelWakeTimer();
    const deadlineMs = this.clock.nowMs() + timeoutMs;
    const active = [...this.active.values()];
    if (active.length === 0) return;
    const didSettle = await this.waitForClaims(
      active,
      Math.max(0, deadlineMs - this.clock.nowMs()),
    );
    if (didSettle) return;
    const remaining = [...this.active.values()];
    for (const entry of remaining) entry.controller.abort();
    await this.waitForClaims(
      remaining,
      Math.max(0, deadlineMs - this.clock.nowMs()),
    );
  }

  private async waitForClaims(
    claims: readonly ActiveClaim[],
    timeoutMs: number,
  ): Promise<boolean> {
    if (claims.length === 0) return true;
    const timerController = new AbortController();
    const allSettled = Promise.allSettled(
      claims.map((entry) => entry.promise),
    ).then(() => true);
    const timeout = this.clock
      .sleep(Math.max(0, timeoutMs), timerController.signal)
      .then(
        () => false,
        () => false,
      );
    try {
      return await Promise.race([allSettled, timeout]);
    } finally {
      timerController.abort();
    }
  }

  private makeRunSeeds(context: SnapshotCycleContext): SchedulerRunSeed[] {
    const schemaHash = context.cycle.versionBinding.schemaHash;
    const policyHash = context.cycle.versionBinding.policyHash;
    const profile = this.backend.profile;
    const deadlineAtUtc = new Date(
      this.clock.nowMs() + this.reviewDeadlineMs,
    ).toISOString();
    const slots =
      profile.runPlan === "NR08_FAKE_3X3"
        ? DIRECTIONS.flatMap((direction) =>
            Array.from({ length: 3 }, (_, index) => ({
              direction,
              replicaIndex: index + 1,
            })),
          )
        : [{ direction: "correctness" as const, replicaIndex: 1 }];
    if (slots.length !== profile.requiredRuns) {
      throw new TypeError(
        "Backend run plan does not match its required run count.",
      );
    }
    const seeds: SchedulerRunSeed[] = [];
    for (const { direction, replicaIndex } of slots) {
      const runIdentity =
        profile.runPlan === "NR08_FAKE_3X3"
          ? `${context.cycleId}:${direction}:${String(replicaIndex)}`
          : `${context.cycleId}:${profile.runPlan}:${direction}:${String(replicaIndex)}`;
      const runDigest = createHash("sha256").update(runIdentity).digest("hex");
      const promptContext = {
        runId: `run-${runDigest.slice(0, 32)}`,
        reviewId: context.reviewId,
        cycleId: context.cycleId,
        direction,
        replicaIndex,
        objectFormat: context.cycle.revisions.objectFormat,
        baseSha: context.cycle.revisions.baseSha,
        headSha: context.cycle.revisions.headSha,
        schemaHash,
        policyHash,
      };
      const prompt = this.backend.promptForRun(promptContext);
      if (
        typeof prompt !== "string" ||
        prompt.length === 0 ||
        Buffer.byteLength(prompt) > 1_048_576
      ) {
        throw new TypeError(
          "Backend run prompt is invalid or exceeds its bound.",
        );
      }
      seeds.push({
        ...promptContext,
        promptHash: createHash("sha256").update(prompt, "utf8").digest("hex"),
        role: "reviewer",
        maxAttempts: this.maxAttempts,
        deadlineAtUtc,
      });
    }
    return seeds;
  }

  private schedulePump(): void {
    if (!this.started || this.draining || this.pumping || this.pumpScheduled) {
      return;
    }
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.draining) return;
    if (!this.owner.isCurrent()) {
      this.draining = true;
      return;
    }
    this.pumping = true;
    try {
      while (!this.draining && this.active.size < this.concurrency) {
        const claim = this.store.claimNextSchedulerJob({
          ownerFencing: this.owner.fencingToken(),
          nowUtc: this.nowUtc(),
          leaseTtlMs: this.leaseTtlMs,
          attemptTimeoutMs: this.attemptTimeoutMs,
        });
        if (claim === undefined) break;
        const controller = new AbortController();
        const promise = Promise.resolve()
          .then(() => this.runClaim(claim, controller.signal))
          .catch(() => undefined)
          .finally(() => {
            this.active.delete(claim.attemptId);
            this.schedulePump();
          });
        this.active.set(claim.attemptId, {
          cycleId: claim.cycleId,
          controller,
          promise,
          sendState: "UNSENT",
        });
        this.maxObservedConcurrency = Math.max(
          this.maxObservedConcurrency,
          this.active.size,
        );
      }
    } finally {
      this.pumping = false;
      if (this.active.size === 0 && !this.draining) this.scheduleWake();
    }
  }

  private scheduleWake(): void {
    if (this.wakeController !== undefined || this.draining) return;
    const next = this.store.nextSchedulerWakeupUtc();
    if (next === undefined) return;
    const delay = Math.max(0, Date.parse(next) - this.clock.nowMs());
    const controller = new AbortController();
    this.wakeController = controller;
    void this.clock
      .sleep(delay, controller.signal)
      .then(() => {
        if (this.wakeController === controller) this.wakeController = undefined;
        this.schedulePump();
      })
      .catch(() => {
        if (this.wakeController === controller) this.wakeController = undefined;
      });
  }

  private cancelWakeTimer(): void {
    this.wakeController?.abort();
    this.wakeController = undefined;
  }

  private async runClaim(
    claim: ClaimedSchedulerJob,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const context = this.contextFor(claim);
      const backendInput: BackendInvocationInput = {
        claim,
        context,
        signal,
      };
      if (claim.workKind === "RECONCILIATION") {
        await this.runReconciliation(backendInput);
      } else {
        await this.runTurn(backendInput);
      }
      await this.maybeAdvanceCycle(claim.cycleId);
    } catch {
      // The durable claim remains leased or reconciliation-required for recovery.
    }
  }

  private async runTurn(input: BackendInvocationInput): Promise<void> {
    if (input.signal.aborted) return;
    let invocationStarted = false;
    const backendSendState: { value: "UNSENT" | "UNKNOWN" } = {
      value: "UNKNOWN",
    };
    const activeClaim = this.active.get(input.claim.attemptId);
    const trackedInput: BackendInvocationInput = {
      ...input,
      reportSendState: (state) => {
        backendSendState.value = state;
        if (activeClaim !== undefined) activeClaim.sendState = state;
      },
    };
    const backendPromise = Promise.resolve().then(() => {
      if (input.signal.aborted) {
        throw new Error("Backend invocation was cancelled before start.");
      }
      invocationStarted = true;
      if (activeClaim !== undefined) activeClaim.sendState = "UNKNOWN";
      return this.backend.invoke(trackedInput);
    });
    const outcome = await this.raceBackend(input, backendPromise);
    if (outcome.kind === "TIMEOUT" || outcome.kind === "ABORTED") {
      if (outcome.kind === "TIMEOUT") {
        this.active.get(input.claim.attemptId)?.controller.abort();
      }
      const provenUnsent =
        !invocationStarted || backendSendState.value === "UNSENT";
      if (provenUnsent) {
        const timedOut = outcome.kind === "TIMEOUT";
        await this.finishAttempt(input, {
          kind: timedOut ? "RETRYABLE_FAILURE" : "PERMANENT_FAILURE",
          errorClass: timedOut ? "DEADLINE" : "PERMANENT",
          rawBytes: markedBytes(this.backend.profile, {
            runId: input.claim.runId,
            attemptId: input.claim.attemptId,
            outcome: timedOut
              ? "DEADLINE_BEFORE_SEND"
              : "CANCELLED_BEFORE_SEND",
          }),
          sendState: "UNSENT",
        });
        this.observeLateResult(backendPromise, (late) =>
          this.finishAttempt(input, late),
        );
        return;
      }
      const bytes = markedBytes(this.backend.profile, {
        runId: input.claim.runId,
        attemptId: input.claim.attemptId,
        outcome: "UNKNOWN_SEND",
        reason:
          outcome.kind === "TIMEOUT"
            ? "ATTEMPT_DEADLINE_EXCEEDED"
            : "ATTEMPT_ABORTED",
      });
      await this.finishAttempt(input, {
        kind: "UNKNOWN_SEND",
        errorClass: "UNKNOWN_SEND",
        rawBytes: bytes,
        sendState: "UNKNOWN",
      });
      this.observeLateResult(backendPromise, (late) =>
        this.finishAttempt(input, late),
      );
      return;
    }
    if (outcome.kind === "ERROR") {
      const bytes = markedBytes(this.backend.profile, {
        runId: input.claim.runId,
        attemptId: input.claim.attemptId,
        outcome: "UNKNOWN_SEND",
        errorName:
          outcome.error instanceof Error ? outcome.error.name : "UnknownError",
      });
      await this.finishAttempt(input, {
        kind: "UNKNOWN_SEND",
        errorClass: "UNKNOWN_SEND",
        rawBytes: bytes,
        sendState: "UNKNOWN",
      });
      return;
    }
    await this.finishAttempt(input, outcome.value);
  }

  private async raceBackend<T>(
    input: BackendInvocationInput,
    operation: Promise<T>,
  ): Promise<BackendRaceResult<T>> {
    const timerController = new AbortController();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<BackendRaceResult<T>>((resolve) => {
      onAbort = () => resolve({ kind: "ABORTED" });
      input.signal.addEventListener("abort", onAbort, { once: true });
      if (input.signal.aborted) onAbort();
    });
    const operationResult: Promise<BackendRaceResult<T>> = operation.then(
      (value) => ({ kind: "RESULT", value }),
      (error: unknown) => ({ kind: "ERROR", error }),
    );
    const remainingMs = Math.max(
      0,
      Date.parse(input.claim.attemptDeadlineAtUtc) - this.clock.nowMs(),
    );
    const timeout: Promise<BackendRaceResult<T>> = this.clock
      .sleep(remainingMs, timerController.signal)
      .then(
        () => ({ kind: "TIMEOUT" }),
        (error: unknown) => ({ kind: "ERROR", error }),
      );
    try {
      return await Promise.race([operationResult, timeout, aborted]);
    } finally {
      timerController.abort();
      if (onAbort !== undefined) {
        input.signal.removeEventListener("abort", onAbort);
      }
    }
  }

  private observeLateResult<T>(
    operation: Promise<T>,
    record: (result: T) => Promise<unknown>,
  ): void {
    void operation.then(record).catch(() => undefined);
  }

  private async finishAttempt(
    input: BackendInvocationInput,
    result: BackendInvocationResult,
  ): Promise<void> {
    if (result.kind === "RETRYABLE_FAILURE") {
      const classification = classifyBackendFailure(
        result.errorClass,
        result.sendState,
      );
      if (classification === "FAIL") {
        const evidence = resultEvidence(result);
        result =
          result.errorClass === "INVALID_SCHEMA"
            ? {
                kind: "MALFORMED",
                errorClass: "INVALID_SCHEMA",
                rawBytes: result.rawBytes,
                ...evidence,
              }
            : {
                kind: "PERMANENT_FAILURE",
                errorClass: result.errorClass,
                rawBytes: result.rawBytes,
                ...evidence,
              };
      } else if (classification === "RECONCILE") {
        result = {
          kind: "UNKNOWN_SEND",
          errorClass: "UNKNOWN_SEND",
          rawBytes: result.rawBytes,
          ...resultEvidence(result),
        };
      }
    }
    const rawArtifact =
      result.primaryRawArtifact ??
      (await this.store.persistRawArtifact(result.rawBytes));
    let retryAtUtc: string | undefined;
    if (result.kind === "RETRYABLE_FAILURE") {
      retryAtUtc = new Date(
        this.clock.nowMs() +
          this.retryDelayMs(input.claim.runId, input.claim.attemptNumber),
      ).toISOString();
    }
    const write: SchedulerAttemptResultInput = {
      runId: input.claim.runId,
      attemptId: input.claim.attemptId,
      ownerFencing: this.owner.fencingToken(),
      lease: input.claim.lease,
      outcome: result.kind,
      rawArtifact,
      ...(result.sendState === undefined
        ? {}
        : { sendState: result.sendState }),
      ...(result.receiptArtifact === undefined
        ? {}
        : { receiptArtifact: result.receiptArtifact }),
      auxiliaryArtifacts: result.rawArtifacts ?? [],
      ...(result.kind === "SUCCESS" ? { parsedResult: result.output } : {}),
      ...("errorClass" in result ? { errorClass: result.errorClass } : {}),
      ...(retryAtUtc === undefined ? {} : { retryAtUtc }),
      occurredAtUtc: this.nowUtc(),
    };
    await this.store.finishSchedulerAttempt(write);
  }

  private async runReconciliation(
    input: BackendInvocationInput,
  ): Promise<void> {
    if (input.signal.aborted) return;
    const backendPromise = Promise.resolve().then(() => {
      if (input.signal.aborted) {
        throw new Error("Backend reconciliation was cancelled before start.");
      }
      return this.backend.reconcile(input);
    });
    const outcome = await this.raceBackend(input, backendPromise);
    const result =
      outcome.kind === "RESULT"
        ? outcome.value
        : { kind: "STILL_UNKNOWN" as const };
    if (outcome.kind === "TIMEOUT") {
      this.active.get(input.claim.attemptId)?.controller.abort();
    }
    await this.finishReconciliation(input, result);
    if (outcome.kind === "TIMEOUT" || outcome.kind === "ABORTED") {
      this.observeLateResult(backendPromise, (late) =>
        this.finishReconciliation(input, late),
      );
    }
  }

  private async finishReconciliation(
    input: BackendInvocationInput,
    result: BackendReconciliationResult,
  ): Promise<void> {
    const writeBase = {
      runId: input.claim.runId,
      attemptId: input.claim.attemptId,
      ownerFencing: this.owner.fencingToken(),
      lease: input.claim.lease,
      occurredAtUtc: this.nowUtc(),
    };
    if (result.kind === "PROVEN_ACCEPTED_WITH_RESULT") {
      const rawArtifact = await this.store.persistRawArtifact(result.rawBytes);
      const write: SchedulerReconciliationInput = {
        ...writeBase,
        outcome: result.kind,
        rawArtifact,
        parsedResult: result.output,
      };
      await this.store.reconcileSchedulerAttempt(write);
      return;
    }
    const retryAtUtc = new Date(
      this.clock.nowMs() +
        this.retryDelayMs(input.claim.runId, input.claim.attemptNumber),
    ).toISOString();
    const write: SchedulerReconciliationInput =
      result.kind === "PROVEN_UNSENT"
        ? { ...writeBase, outcome: result.kind, retryAtUtc }
        : { ...writeBase, outcome: result.kind, retryAtUtc };
    await this.store.reconcileSchedulerAttempt(write);
  }

  private async maybeAdvanceCycle(cycleId: string): Promise<void> {
    if (this.backend.profile.qualification === "LIVE_PRODUCTION_BRIDGE") {
      return;
    }
    const context = this.store.readSnapshotCycleContext(cycleId);
    const status = this.store.readSchedulerCycleStatus(cycleId);
    if (
      context.cycle.state === "REVIEWING" &&
      status.failedRuns > 0 &&
      status.activeRuns === 0 &&
      status.retryWaitingRuns === 0 &&
      status.reconciliationRequiredRuns === 0 &&
      status.completedRuns + status.failedRuns === FAKE_REQUIRED_RUNS
    ) {
      this.store.applyCycleCommand(
        "daemon-scheduler",
        cycleId,
        {
          type: "ADVANCE",
          target: "FAILED",
          expectedVersion: context.cycle.stateVersion,
          idempotencyKey: `scheduler-failed-${cycleId}`,
          evidence: { failureCode: "BACKEND_UNAVAILABLE" },
        },
        {
          ownerFencing: this.owner.fencingToken(),
          occurredAtUtc: this.nowUtc(),
          eventMetadata: { backend: "FAKE", qualification: "OFFLINE_ONLY" },
        },
      );
      return;
    }
    if (
      context.cycle.state === "REVIEWING" &&
      status.completedRuns === FAKE_REQUIRED_RUNS
    ) {
      this.store.applyCycleCommand(
        "daemon-scheduler",
        cycleId,
        {
          type: "ADVANCE",
          target: "AGGREGATING",
          expectedVersion: context.cycle.stateVersion,
          idempotencyKey: `scheduler-aggregate-${cycleId}`,
          evidence: { allRequiredRunsSucceeded: true },
        },
        {
          ownerFencing: this.owner.fencingToken(),
          occurredAtUtc: this.nowUtc(),
          eventMetadata: { backend: "FAKE", qualification: "OFFLINE_ONLY" },
        },
      );
    }
    const aggregating = this.store.readSnapshotCycleContext(cycleId);
    if (aggregating.cycle.state !== "AGGREGATING") return;
    const selected = this.store.readSchedulerSelectedRuns(cycleId);
    const provisionalFindings = this.provisionalFindings(selected);
    const state =
      provisionalFindings.length === 0 ? "NO_FINDINGS" : "PROVISIONAL_FINDINGS";
    const report = {
      backend: "FAKE",
      qualification: "OFFLINE_ONLY",
      cycleId,
      state,
      selectedLogicalRuns: selected.map((run) => ({
        runId: run.runId,
        direction: run.direction,
        replicaIndex: run.replicaIndex,
      })),
      provisionalFindings,
      semanticAdjudication: "NOT_PERFORMED",
      liveQualification: "NOT_CLAIMED",
    } as const;
    const reportJson = report as unknown as ProtocolJsonValue;
    const bytes = Buffer.from(canonicalJson(reportJson), "utf8");
    const rawArtifact = await this.store.persistRawArtifact(bytes);
    const aggregation: SchedulerAggregationInput = {
      cycleId,
      ownerFencing: this.owner.fencingToken(),
      backend: "FAKE",
      qualification: "OFFLINE_ONLY",
      state,
      report: reportJson,
      rawArtifact,
      occurredAtUtc: this.nowUtc(),
    };
    await this.store.recordSchedulerAggregation(aggregation);
    if (state !== "NO_FINDINGS") return;
    const approval = this.approvalEvidence(selected);
    if (!evaluateApprovalEvidence(approval).approved) {
      throw new Error(
        "The offline fake approval evidence did not satisfy policy.",
      );
    }
    const current = this.store.readSnapshotCycleContext(cycleId);
    if (current.cycle.state !== "AGGREGATING") return;
    this.store.applyCycleCommand(
      "daemon-scheduler",
      cycleId,
      {
        type: "ADVANCE",
        target: "APPROVED",
        expectedVersion: current.cycle.stateVersion,
        idempotencyKey: `scheduler-approve-${cycleId}`,
        evidence: {
          approval,
          approvedAt: this.nowUtc(),
        },
      },
      {
        ownerFencing: this.owner.fencingToken(),
        occurredAtUtc: this.nowUtc(),
        eventMetadata: { backend: "FAKE", qualification: "OFFLINE_ONLY" },
      },
    );
  }

  private provisionalFindings(
    selected: readonly SchedulerSelectedRun[],
  ): SchedulerProvisionalFinding[] {
    const findings: SchedulerProvisionalFinding[] = [];
    for (const run of selected) {
      const output = validateProtocolValue("workerOutput", run.output);
      if (!output.ok) {
        throw new Error("Persisted selected scheduler output is malformed.");
      }
      for (const finding of output.value.findings) {
        findings.push({
          runId: run.runId,
          direction: run.direction,
          replicaIndex: run.replicaIndex,
          localId: finding.localId,
          finding: finding as SchedulerProvisionalFinding["finding"],
        });
      }
    }
    findings.sort(
      (left, right) =>
        left.direction.localeCompare(right.direction) ||
        left.replicaIndex - right.replicaIndex ||
        left.localId.localeCompare(right.localId) ||
        left.runId.localeCompare(right.runId),
    );
    return findings;
  }

  private approvalEvidence(
    selected: readonly SchedulerSelectedRun[],
  ): ApprovalEvidence {
    return {
      requiredRuns: selected.map((run) => ({
        runId: run.runId,
        direction: run.direction,
        replicaIndex: run.replicaIndex,
        status: "SUCCEEDED",
      })),
      coverageComplete: selected.every((run) => {
        const output = validateProtocolValue("workerOutput", run.output);
        return output.ok && output.value.coverage.complete;
      }),
      allRequiredAdjudicationsResolved: true,
      canonicalValidation: "VALID",
      bindingsValid: true,
      blockingSeverities: [],
    };
  }

  private contextFor(claim: ClaimedSchedulerJob) {
    let seeds = this.seedsByCycle.get(claim.cycleId);
    if (seeds === undefined) {
      const snapshotContext = this.store.readSnapshotCycleContext(
        claim.cycleId,
      );
      seeds = this.makeRunSeeds(snapshotContext);
      this.seedsByCycle.set(claim.cycleId, seeds);
    }
    const seed = seeds.find((candidate) => candidate.runId === claim.runId);
    if (seed === undefined) {
      throw new Error(
        "Claimed scheduler run is not present in the deterministic run set.",
      );
    }
    return {
      runId: seed.runId,
      reviewId: seed.reviewId,
      cycleId: seed.cycleId,
      direction: seed.direction,
      replicaIndex: seed.replicaIndex,
      objectFormat: seed.objectFormat,
      baseSha: seed.baseSha,
      headSha: seed.headSha,
      promptHash: seed.promptHash,
      schemaHash: seed.schemaHash,
      policyHash: seed.policyHash,
    };
  }

  private retryDelayMs(runId: string, attemptNumber: number): number {
    const base = Math.min(
      this.maxBackoffMs,
      250 * 2 ** Math.max(0, attemptNumber - 1),
    );
    const jitter = this.jitter(runId, attemptNumber);
    if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
      throw new TypeError("Scheduler jitter must be between zero and one.");
    }
    return Math.min(this.maxBackoffMs, Math.floor(base * (0.5 + jitter)));
  }

  private nowUtc(): string {
    return new Date(this.clock.nowMs()).toISOString();
  }
}

export function classifyBackendFailure(
  failure: BackendFailureClass,
  sendState: "UNSENT" | "SENT" | "UNKNOWN",
): "RETRY" | "FAIL" | "RECONCILE" {
  if (
    failure === "AUTHENTICATION" ||
    failure === "POLICY" ||
    failure === "INVALID_SCHEMA"
  ) {
    return "FAIL";
  }
  if (failure === "PERMANENT") return "FAIL";
  if (failure === "DEADLINE" && sendState !== "UNSENT") return "RECONCILE";
  if (sendState !== "UNSENT") return "RECONCILE";
  return "RETRY";
}

function deterministicJitter(runId: string, attemptNumber: number): number {
  const digest = createHash("sha256")
    .update(`${runId}:${String(attemptNumber)}`)
    .digest();
  return digest.readUInt16BE(0) / 0xffff;
}

function resultEvidence(
  result: BackendInvocationResult,
): BackendResultEvidence {
  return {
    ...(result.receipt === undefined ? {} : { receipt: result.receipt }),
    ...(result.receiptArtifact === undefined
      ? {}
      : { receiptArtifact: result.receiptArtifact }),
    ...(result.primaryRawArtifact === undefined
      ? {}
      : { primaryRawArtifact: result.primaryRawArtifact }),
    ...(result.rawArtifacts === undefined
      ? {}
      : { rawArtifacts: result.rawArtifacts }),
    ...(result.sendState === undefined ? {} : { sendState: result.sendState }),
  };
}

function markedBytes(
  profile: ReviewerBackend["profile"],
  output: unknown,
): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      backend: profile.backend,
      qualification: profile.qualification,
      output,
    }),
    "utf8",
  );
}
