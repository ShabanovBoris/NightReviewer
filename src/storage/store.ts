import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  createIdempotencyBinding,
  createInitialReviewCycle,
  hashCanonicalJson,
  type ProtocolJsonValue,
  type ProtocolValueBySchema,
  type ReviewCycleState,
  type ReviewSubmitInput,
  type ReviewTransitionCommand,
  transitionReviewCycle,
  type VersionHashBinding,
  validateProtocolValue,
  type WorkerFinding,
} from "../protocol";
import {
  createBackupAt,
  createMigrationBackup,
  verifyBackupAt,
} from "./backup";
import {
  conflict,
  invalidArgument,
  invariantViolation,
  needsReconciliation,
  StorageError,
} from "./errors";
import {
  artifactReferenceFor,
  artifactRelativePath,
  DATABASE_FILE_NAME,
  ensureEmptyOwnedDirectory,
  ensurePrivateChildDirectory,
  ensurePrivateDirectory,
  listArtifactFiles,
  makeUtcTimestamp,
  persistArtifactFile,
  persistStableArtifactFile,
  readVerifiedArtifact,
  sha256Hex,
  writeAtomicFile,
} from "./files";
import { applyStorageMigrations } from "./migrations";
import type {
  AdjudicationDecisionInput,
  ArtifactIssue,
  ArtifactReference,
  BackupManifest,
  CancelSchedulerCycleInput,
  CanonicalFindingInput,
  CanonicalFindingRecord,
  ClaimedSchedulerJob,
  ClaimSchedulerJobInput,
  CreatedReview,
  CreateReviewInput,
  DirectionRunBinding,
  DirectionRunInput,
  DirectionRunStatus,
  EnsureSchedulerRunsInput,
  FencingToken,
  FixSubmissionInput,
  FixSubmissionResult,
  IdempotencyLookup,
  LeaseRecord,
  OpenStorageOptions,
  OutboxRecord,
  PersistedIdempotencyRecord,
  RawFindingInput,
  ReconciliationReport,
  RecordFindingVerificationInput,
  ReviewEventPage,
  ReviewRecord,
  SchedulerAggregationInput,
  SchedulerAttemptArtifact,
  SchedulerAttemptArtifactPurpose,
  SchedulerAttemptProvenance,
  SchedulerAttemptResultInput,
  SchedulerAttemptState,
  SchedulerBackendBinding,
  SchedulerBackendProfile,
  SchedulerCycleStatus,
  SchedulerJobState,
  SchedulerReconciliationInput,
  SchedulerSelectedRun,
  SnapshotCycleContext,
  SnapshotInput,
  SnapshotRecord,
  StoredReviewEvent,
  WorkerAttemptInput,
  WorkerResultInput,
  WorkerResultRecord,
} from "./types";

const DATABASE_NAME = DATABASE_FILE_NAME;
const MIN_BUSY_TIMEOUT_MS = 0;
const MAX_BUSY_TIMEOUT_MS = 30_000;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validateSchedulerBackendProfile(
  profile: SchedulerBackendProfile,
): SchedulerBackendProfile {
  if (
    !(
      (profile.backend === "FAKE" &&
        profile.qualification === "OFFLINE_ONLY" &&
        profile.runPlan === "NR08_FAKE_3X3" &&
        profile.requiredRuns === 9) ||
      (profile.backend === "LIVE" &&
        profile.qualification === "LIVE_PRODUCTION_BRIDGE" &&
        profile.runPlan === "NR09_LIVE_QUALIFICATION" &&
        profile.requiredRuns === 1)
    ) ||
    typeof profile.backendProtocol !== "string" ||
    profile.backendProtocol.length < 1 ||
    profile.backendProtocol.length > 128 ||
    typeof profile.bridgeVersionPin !== "string" ||
    profile.bridgeVersionPin.length < 1 ||
    profile.bridgeVersionPin.length > 64 ||
    typeof profile.model !== "string" ||
    profile.model.length < 1 ||
    profile.model.length > 256 ||
    typeof profile.reasoningEffort !== "string" ||
    profile.reasoningEffort.length < 1 ||
    profile.reasoningEffort.length > 32
  ) {
    throw invalidArgument("Scheduler backend binding is invalid.");
  }
  requireSha256(profile.configurationDigest, "configurationDigest");
  return profile;
}

function sameSchedulerBackendProfile(
  left: SchedulerBackendProfile,
  right: SchedulerBackendProfile,
): boolean {
  return (
    left.backend === right.backend &&
    left.backendProtocol === right.backendProtocol &&
    left.bridgeVersionPin === right.bridgeVersionPin &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.qualification === right.qualification &&
    left.configurationDigest === right.configurationDigest &&
    left.runPlan === right.runPlan &&
    left.requiredRuns === right.requiredRuns
  );
}

const SCHEDULER_ARTIFACT_PURPOSES: readonly SchedulerAttemptArtifactPurpose[] =
  [
    "HEALTH",
    "MODEL_CATALOG",
    "TURN_RESPONSE",
    "SCHEMA_REPAIR_RESPONSE",
    "LOCAL_DIAGNOSTIC",
    "RECEIPT",
  ];

function schedulerAttemptArtifacts(
  auxiliary: SchedulerAttemptResultInput["auxiliaryArtifacts"],
  receiptArtifact: ArtifactReference | undefined,
): NonNullable<SchedulerAttemptResultInput["auxiliaryArtifacts"]> {
  const artifacts = [...(auxiliary ?? [])];
  if (receiptArtifact !== undefined) {
    artifacts.push({ purpose: "RECEIPT", reference: receiptArtifact });
  }
  const seenPurposes = new Set<string>();
  return artifacts.map((artifact) => {
    if (
      typeof artifact !== "object" ||
      artifact === null ||
      !SCHEDULER_ARTIFACT_PURPOSES.includes(artifact.purpose) ||
      seenPurposes.has(artifact.purpose)
    ) {
      throw invalidArgument("Scheduler attempt artifacts are invalid.");
    }
    seenPurposes.add(artifact.purpose);
    return {
      purpose: artifact.purpose,
      reference: requireArtifactReference(artifact.reference),
    };
  });
}

function schedulerArtifactContentType(
  purpose: SchedulerAttemptArtifactPurpose,
): string {
  if (
    purpose === "HEALTH" ||
    purpose === "MODEL_CATALOG" ||
    purpose === "RECEIPT"
  ) {
    return "application/json";
  }
  if (purpose === "TURN_RESPONSE" || purpose === "SCHEMA_REPAIR_RESPONSE") {
    return "text/event-stream";
  }
  return "application/octet-stream";
}

export function daemonOwnershipResourceId(storageRootDir: string): string {
  const canonicalRoot = path.resolve(storageRootDir);
  const digest = createHash("sha256").update(canonicalRoot).digest("hex");
  return `daemon:${digest}`;
}

function schedulerLeaseResourceId(runId: string): string {
  return `scheduler-job:${runId}`;
}

interface CycleRow {
  cycle_id: string;
  review_id: string;
  parent_cycle_id: string | null;
  cycle_number: number;
  repo_id: string;
  object_format: "sha1" | "sha256";
  base_sha: string;
  head_sha: string;
  state: string;
  state_version: number;
  review_context_hash: string;
  manifest_hash: string | null;
  version_binding_json: string;
  state_json: string;
  created_at_utc: string;
  updated_at_utc: string;
}

interface ReviewRow {
  review_id: string;
  repo_id: string;
  task: string;
  acceptance_criteria_json: string;
  profile: "strict/1";
  created_at_utc: string;
  updated_at_utc: string;
  cycle_id: string;
  cycle_json: string;
}

interface ArtifactRow {
  sha256: string;
  relative_path: string;
  byte_size: number;
}

interface IdempotencyRow {
  normalized_request_sha256: string;
  result_type: string;
  result_id: string;
  result_json: string;
  created_at_utc: string;
}

interface EventInput {
  readonly reviewId: string;
  readonly cycleId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly occurredAtUtc: string;
}

interface SchedulerJobRow {
  readonly run_id: string;
  readonly review_id: string;
  readonly cycle_id: string;
  readonly direction: "correctness" | "tests" | "design";
  readonly replica_index: number;
  readonly state: SchedulerJobState;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly deadline_at_utc: string;
  readonly active_attempt_id: string | null;
  readonly active_work_kind: "TURN" | "RECONCILIATION" | null;
  readonly lease_owner_id: string | null;
  readonly lease_token: number;
  readonly lease_expires_at_utc: string | null;
  readonly latest_error_class: string | null;
  readonly next_attempt_at_utc: string;
}

export class SqliteStorage {
  readonly rootDir: string;
  readonly schemaVersion: number;
  readonly sqliteVersion: string;
  private readonly db: Database;

  private constructor(rootDir: string, db: Database, schemaVersion: number) {
    this.rootDir = rootDir;
    this.db = db;
    this.schemaVersion = schemaVersion;
    const sqliteVersion = db
      .query("SELECT sqlite_version() AS version")
      .get() as { version?: string } | undefined;
    this.sqliteVersion = String(sqliteVersion?.version ?? "unknown");
  }

  static async open(options: OpenStorageOptions): Promise<SqliteStorage> {
    const requestedRoot = path.resolve(options.rootDir);
    if (requestedRoot === path.parse(requestedRoot).root) {
      throw invalidArgument("Storage root cannot be the filesystem root.");
    }
    await ensurePrivateDirectory(requestedRoot);
    const canonicalRoot = await realpath(requestedRoot);
    const dbPath = path.join(canonicalRoot, DATABASE_NAME);
    try {
      const existingDb = await lstat(dbPath);
      if (existingDb.isSymbolicLink() || !existingDb.isFile()) {
        throw invalidArgument(
          "Storage database path must be a regular owned file.",
        );
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }

    const busyTimeoutMs = options.busyTimeoutMs ?? 2_500;
    if (
      !Number.isSafeInteger(busyTimeoutMs) ||
      busyTimeoutMs < MIN_BUSY_TIMEOUT_MS ||
      busyTimeoutMs > MAX_BUSY_TIMEOUT_MS
    ) {
      throw invalidArgument(
        "SQLite busy timeout must be between 0 and 30000 milliseconds.",
      );
    }

    let db: Database | undefined;
    try {
      db = new Database(dbPath, {
        create: true,
        readwrite: true,
        strict: true,
      });
      await chmod(dbPath, 0o600);
      db.exec("PRAGMA foreign_keys = ON");
      db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      const journal = db.query("PRAGMA journal_mode = WAL").get() as
        | { journal_mode?: string }
        | undefined;
      if (String(journal?.journal_mode ?? "").toLowerCase() !== "wal") {
        throw new StorageError(
          "IO_ERROR",
          "SQLite did not enable the required WAL journal mode.",
        );
      }
      db.exec("PRAGMA synchronous = FULL");
      const foreignKeys = db.query("PRAGMA foreign_keys").get() as
        | { foreign_keys?: number }
        | undefined;
      if (Number(foreignKeys?.foreign_keys) !== 1) {
        throw new StorageError(
          "IO_ERROR",
          "SQLite foreign-key enforcement could not be enabled.",
        );
      }
      const synchronous = db.query("PRAGMA synchronous").get() as
        | { synchronous?: number }
        | undefined;
      if (Number(synchronous?.synchronous) !== 2) {
        throw new StorageError(
          "IO_ERROR",
          "SQLite FULL synchronous durability could not be enabled.",
        );
      }
      const before = db.query("PRAGMA user_version").get() as
        | { user_version?: number }
        | undefined;
      const startingVersion = Number(before?.user_version ?? 0);
      const schemaVersion = await applyStorageMigrations(
        db,
        async (from, to) => {
          if (from < startingVersion || to !== from + 1) {
            throw invariantViolation(
              "Migration callback received an unexpected schema transition.",
            );
          }
          await createMigrationBackup(canonicalRoot, db as Database, from, to);
        },
      );
      const storage = new SqliteStorage(canonicalRoot, db, schemaVersion);
      await ensurePrivateChildDirectory(canonicalRoot, "artifacts/sha256");
      return storage;
    } catch (error) {
      try {
        db?.close(true);
      } catch {
        // Preserve the initialization error if closing also fails.
      }
      throw mapStorageError(error);
    }
  }

  close(): void {
    this.db.close(true);
  }

  integrityCheck(): { integrity: string; foreignKeyViolations: number } {
    const result = this.db.query("PRAGMA integrity_check").get() as
      | { integrity_check?: string }
      | undefined;
    return {
      integrity: String(result?.integrity_check ?? "unknown"),
      foreignKeyViolations: this.db.query("PRAGMA foreign_key_check").all()
        .length,
    };
  }

  async createReview(input: CreateReviewInput): Promise<CreatedReview> {
    validateIdentifier(input.callerId, "callerId");
    const submission = requireValidSubmission(input.submission);
    const contextHash = requireSha256(
      input.reviewContextHash,
      "reviewContextHash",
    );
    const versionBinding = requireVersionBinding(input.versionBinding);
    const requestPayload = {
      submission: submissionPayload(submission),
      reviewContextHash: contextHash,
      versionBinding,
    };
    const binding = requireIdempotencyBinding(
      submission.idempotencyKey,
      requestPayload,
    );
    const now = makeUtcTimestamp(input.createdAtUtc);

    return this.withImmediateTransaction(() => {
      this.assertDaemonFencingToken(input.fencing, now);
      const replay = this.lookupWithinTransaction(
        input.callerId,
        "review_submit",
        submission.idempotencyKey,
        binding.normalizedPayloadHash,
      );
      if (replay !== undefined) return replay.result as CreatedReview;

      const reviewId = randomUUID();
      const cycleId = randomUUID();
      const cycle = createInitialReviewCycle({
        cycleId,
        repoId: submission.repoId,
        revisions: {
          objectFormat: submission.objectFormat,
          baseSha: submission.baseSha,
          headSha: submission.headSha,
        },
        reviewContextHash: contextHash,
        versionBinding,
      });
      const result: CreatedReview = {
        reviewId,
        cycleId,
        state: "QUEUED",
        stateVersion: 0,
        revisions: cycle.revisions,
        versionBinding,
      };

      this.db
        .query(
          `INSERT INTO reviews
           (review_id, repo_id, task, acceptance_criteria_json, profile, created_at_utc, updated_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          reviewId,
          submission.repoId,
          submission.task,
          encodeJson(submission.acceptanceCriteria),
          submission.profile,
          now,
          now,
        );
      insertCycle(this.db, reviewId, cycle, now);
      this.db
        .query("UPDATE reviews SET updated_at_utc = ? WHERE review_id = ?")
        .run(now, reviewId);
      this.insertEventOutbox({
        reviewId,
        cycleId,
        eventType: "review.created",
        payload: result,
        occurredAtUtc: now,
      });
      this.insertIdempotencyRecord({
        callerId: input.callerId,
        operation: "review_submit",
        idempotencyKey: submission.idempotencyKey,
        normalizedPayloadHash: binding.normalizedPayloadHash,
        resultType: "review_submit",
        resultId: reviewId,
        result,
        createdAtUtc: now,
      });
      return result;
    });
  }

  recordSnapshot(input: SnapshotInput): void {
    const { manifestHash, createdAt } = validateSnapshotInput(input);
    this.withImmediateTransaction(() => {
      this.insertSnapshot(input, manifestHash, createdAt);
    });
  }

  /** Atomically records the immutable manifest and its owned Git object pack. */
  async recordSnapshotWithArtifact(
    input: SnapshotInput,
    artifactBytes: Uint8Array,
    fencing?: FencingToken,
  ): Promise<ArtifactReference> {
    const { manifestHash, createdAt } = validateSnapshotInput(input);
    if (
      !(artifactBytes instanceof Uint8Array) ||
      artifactBytes.byteLength === 0
    ) {
      throw invalidArgument(
        "Snapshot artifact must contain exact non-empty bytes.",
      );
    }
    const stableBytes = new Uint8Array(artifactBytes);
    const expectedReference = artifactReferenceFor(stableBytes);
    const manifestArtifact = snapshotArtifactReference(input.manifest);
    if (
      manifestArtifact.sha256 !== expectedReference.sha256 ||
      manifestArtifact.sizeBytes !== expectedReference.sizeBytes ||
      manifestArtifact.relativePath !== expectedReference.relativePath
    ) {
      throw invalidArgument(
        "Snapshot manifest artifact identity does not match its exact bytes.",
      );
    }
    return this.withAsyncImmediateTransaction(async () => {
      this.assertDaemonFencingToken(fencing, createdAt);
      const cycle = this.requireSnapshotCycle(input);
      if (decodeCycle(cycle.state_json).state !== "SNAPSHOTTING") {
        throw conflict("Snapshot work no longer owns a SNAPSHOTTING cycle.");
      }
      const reference = await persistStableArtifactFile(
        this.rootDir,
        stableBytes,
      );
      if (reference.sha256 !== expectedReference.sha256) {
        throw invariantViolation(
          "Persisted snapshot artifact identity changed unexpectedly.",
        );
      }
      this.insertArtifactRecord(
        reference,
        "application/x-git-packed-objects",
        createdAt,
      );
      this.insertSnapshot(input, manifestHash, createdAt, reference, cycle);
      return reference;
    });
  }

  readSnapshots(cycleId: string): SnapshotRecord[] {
    validateIdentifier(cycleId, "cycleId");
    this.readCycle(cycleId);
    const rows = this.db
      .query(
        `SELECT snapshot_id, cycle_id, object_format, base_sha, head_sha,
                manifest_hash, manifest_json, created_at_utc
         FROM snapshots WHERE cycle_id = ? ORDER BY created_at_utc, snapshot_id`,
      )
      .all(cycleId) as Array<{
      snapshot_id: string;
      cycle_id: string;
      object_format: "sha1" | "sha256";
      base_sha: string;
      head_sha: string;
      manifest_hash: string;
      manifest_json: string;
      created_at_utc: string;
    }>;
    return rows.map((row) => {
      const manifest = parseJson<ProtocolJsonValue>(row.manifest_json);
      if (hashCanonicalJson(manifest) !== row.manifest_hash) {
        throw needsReconciliation(
          "Persisted snapshot manifest does not match its immutable hash.",
        );
      }
      return {
        snapshotId: row.snapshot_id,
        cycleId: row.cycle_id,
        objectFormat: row.object_format,
        baseSha: row.base_sha,
        headSha: row.head_sha,
        manifestHash: row.manifest_hash,
        manifest,
        createdAtUtc: row.created_at_utc,
      };
    });
  }

  readReview(reviewId: string): ReviewRecord {
    validateIdentifier(reviewId, "reviewId");
    const row = this.db
      .query(
        `SELECT r.review_id, r.repo_id, r.task, r.acceptance_criteria_json, r.profile,
                r.created_at_utc, r.updated_at_utc, c.cycle_id, c.state_json AS cycle_json
         FROM reviews r
         JOIN review_cycles c ON c.review_id = r.review_id
         WHERE r.review_id = ?
         ORDER BY c.cycle_number DESC LIMIT 1`,
      )
      .get(reviewId) as ReviewRow | null;
    if (row === null)
      throw new StorageError("NOT_FOUND", "Review was not found.");
    const cycle = decodeCycle(row.cycle_json);
    const acceptanceCriteria = parseJson<
      ReviewSubmitInput["acceptanceCriteria"]
    >(row.acceptance_criteria_json);
    return {
      reviewId: row.review_id,
      cycleId: row.cycle_id,
      repoId: row.repo_id,
      task: row.task,
      acceptanceCriteria,
      profile: row.profile,
      state: cycle.state,
      stateVersion: cycle.stateVersion,
      revisions: cycle.revisions,
      versionBinding: cycle.versionBinding,
      cycle,
      createdAtUtc: row.created_at_utc,
      updatedAtUtc: row.updated_at_utc,
    };
  }

  readCycle(cycleId: string): ReviewCycleState {
    validateIdentifier(cycleId, "cycleId");
    const row = this.db
      .query("SELECT state_json FROM review_cycles WHERE cycle_id = ?")
      .get(cycleId) as { state_json: string } | null;
    if (row === null)
      throw new StorageError("NOT_FOUND", "Review cycle was not found.");
    return decodeCycle(row.state_json);
  }

  readDaemonPendingCycles(limit = 100): SnapshotCycleContext[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw invalidArgument("Pending cycle limit must be between 1 and 1000.");
    }
    const rows = this.db
      .query(
        `SELECT r.review_id, r.repo_id, r.task, r.acceptance_criteria_json,
                c.cycle_id, c.state_json
         FROM review_cycles c
         JOIN reviews r ON r.review_id = c.review_id
         WHERE c.state IN ('QUEUED', 'SNAPSHOTTING', 'CANCEL_REQUESTED')
           AND c.cycle_number = (
             SELECT MAX(latest.cycle_number) FROM review_cycles latest
             WHERE latest.review_id = c.review_id
           )
         ORDER BY c.created_at_utc, c.cycle_id
         LIMIT ?`,
      )
      .all(limit) as Array<{
      review_id: string;
      repo_id: string;
      task: string;
      acceptance_criteria_json: string;
      cycle_id: string;
      state_json: string;
    }>;
    return rows.map((row) => ({
      reviewId: row.review_id,
      cycleId: row.cycle_id,
      repoId: row.repo_id,
      task: row.task,
      acceptanceCriteria: parseJson<ReviewSubmitInput["acceptanceCriteria"]>(
        row.acceptance_criteria_json,
      ),
      cycle: decodeCycle(row.state_json),
    }));
  }

  readEventPage(
    cycleId: string,
    afterEventSeq = 0,
    pageSize = 100,
  ): ReviewEventPage {
    validateIdentifier(cycleId, "cycleId");
    this.readCycle(cycleId);
    if (!Number.isSafeInteger(afterEventSeq) || afterEventSeq < 0) {
      throw invalidArgument(
        "Event cursor sequence must be a non-negative integer.",
      );
    }
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw invalidArgument("Event page size must be between 1 and 100.");
    }
    const rows = this.db
      .query(
        `SELECT event_id, event_seq, event_type, payload_json, occurred_at_utc
         FROM events WHERE cycle_id = ? AND event_seq > ?
         ORDER BY event_seq LIMIT ?`,
      )
      .all(cycleId, afterEventSeq, pageSize + 1) as Array<{
      event_id: string;
      event_seq: number;
      event_type: string;
      payload_json: string;
      occurred_at_utc: string;
    }>;
    const hasMore = rows.length > pageSize;
    const events: StoredReviewEvent[] = rows.slice(0, pageSize).map((row) => ({
      eventId: row.event_id,
      eventSeq: row.event_seq,
      eventType: row.event_type,
      payload: parseJson(row.payload_json),
      occurredAtUtc: row.occurred_at_utc,
    }));
    return { events, hasMore };
  }

  readSnapshotCycleContext(cycleId: string): SnapshotCycleContext {
    validateIdentifier(cycleId, "cycleId");
    const row = this.db
      .query(
        `SELECT r.review_id, r.repo_id, r.task, r.acceptance_criteria_json, c.state_json
         FROM review_cycles c
         JOIN reviews r ON r.review_id = c.review_id
         WHERE c.cycle_id = ?`,
      )
      .get(cycleId) as {
      review_id: string;
      repo_id: string;
      task: string;
      acceptance_criteria_json: string;
      state_json: string;
    } | null;
    if (row === null) {
      throw new StorageError("NOT_FOUND", "Review cycle was not found.");
    }
    return {
      reviewId: row.review_id,
      cycleId,
      repoId: row.repo_id,
      task: row.task,
      acceptanceCriteria: parseJson<ReviewSubmitInput["acceptanceCriteria"]>(
        row.acceptance_criteria_json,
      ),
      cycle: decodeCycle(row.state_json),
    };
  }

  applyCycleCommand(
    callerId: string,
    cycleId: string,
    command: ReviewTransitionCommand,
    options: {
      readonly occurredAtUtc?: string;
      readonly fencing?: FencingToken;
      readonly ownerFencing?: FencingToken;
      readonly eventMetadata?: {
        readonly backend: "FAKE";
        readonly qualification: "OFFLINE_ONLY";
      };
    } = {},
  ): {
    readonly state: ReviewCycleState;
    readonly childCycle?: ReviewCycleState;
  } {
    validateIdentifier(callerId, "callerId");
    validateIdentifier(cycleId, "cycleId");
    const commandKey = command.idempotencyKey;
    const normalizedPayload = Object.fromEntries(
      Object.entries(command).filter(([key]) => key !== "idempotencyKey"),
    );
    const binding = requireIdempotencyBinding(commandKey, normalizedPayload);
    const occurredAt = makeUtcTimestamp(options.occurredAtUtc);

    return this.withImmediateTransaction(() => {
      this.assertDaemonFencingToken(options.ownerFencing, occurredAt);
      const replay = this.lookupWithinTransaction(
        callerId,
        "cycle_transition",
        commandKey,
        binding.normalizedPayloadHash,
      );
      if (replay !== undefined) {
        return replay.result as {
          readonly state: ReviewCycleState;
          readonly childCycle?: ReviewCycleState;
        };
      }

      if (
        command.type === "CONFIRM_CANCEL" &&
        options.fencing === undefined &&
        options.ownerFencing === undefined
      ) {
        throw invalidArgument(
          "Final cancellation requires an active fencing token.",
        );
      }

      const currentRow = this.readCycleRow(cycleId);
      const current = decodeCycle(currentRow.state_json);
      this.assertFencingToken(options.fencing, occurredAt, `cycle:${cycleId}`);
      const transition = transitionReviewCycle(current, command);
      if (!transition.ok)
        throw mapProtocolTransitionError(transition.error.code);
      if (transition.state.state === "REVIEWING") {
        this.assertSnapshotManifestRecorded(cycleId, transition.state);
      }
      if (transition.replayed) {
        const replayResult = {
          state: transition.state,
          ...(transition.childCycle
            ? { childCycle: transition.childCycle }
            : {}),
        };
        this.insertIdempotencyRecord({
          callerId,
          operation: "cycle_transition",
          idempotencyKey: commandKey,
          normalizedPayloadHash: binding.normalizedPayloadHash,
          resultType: "cycle_transition",
          resultId: cycleId,
          result: replayResult,
          createdAtUtc: occurredAt,
        });
        return replayResult;
      }

      assertCycleIdentity(currentRow, transition.state);
      if (transition.state.stateVersion !== currentRow.state_version + 1) {
        throw invariantViolation(
          "Reducer returned a nonconsecutive cycle stateVersion.",
        );
      }
      this.updateCycleState(currentRow, transition.state, occurredAt);
      this.db
        .query("UPDATE reviews SET updated_at_utc = ? WHERE review_id = ?")
        .run(occurredAt, currentRow.review_id);
      const eventPayload = {
        ...(options.eventMetadata ?? {}),
        command,
        state: transition.state,
      };
      this.insertEventOutbox({
        reviewId: currentRow.review_id,
        cycleId,
        eventType: "review.cycle_transitioned",
        payload: eventPayload,
        occurredAtUtc: occurredAt,
      });

      let childCycle: ReviewCycleState | undefined;
      if (transition.childCycle !== undefined) {
        childCycle = transition.childCycle;
        insertCycle(this.db, currentRow.review_id, childCycle, occurredAt);
        this.insertEventOutbox({
          reviewId: currentRow.review_id,
          cycleId: childCycle.cycleId,
          eventType: "review.child_cycle_created",
          payload: { parentCycleId: cycleId, state: childCycle },
          occurredAtUtc: occurredAt,
        });
      }
      const result = {
        state: transition.state,
        ...(childCycle ? { childCycle } : {}),
      };
      this.insertIdempotencyRecord({
        callerId,
        operation: "cycle_transition",
        idempotencyKey: commandKey,
        normalizedPayloadHash: binding.normalizedPayloadHash,
        resultType: "cycle_transition",
        resultId: cycleId,
        result,
        createdAtUtc: occurredAt,
      });
      return result;
    });
  }

  /** Write exact response bytes before parsing; pass the returned reference to recordWorkerResult. */
  async persistRawArtifact(bytes: Uint8Array): Promise<ArtifactReference> {
    if (!(bytes instanceof Uint8Array))
      throw invalidArgument("Raw artifact must be exact bytes.");
    return persistArtifactFile(this.rootDir, bytes);
  }

  async readRawArtifact(reference: ArtifactReference): Promise<Uint8Array> {
    return readVerifiedArtifact(this.rootDir, reference);
  }

  async recordWorkerResult(
    input: WorkerResultInput,
  ): Promise<ArtifactReference> {
    validateIdentifier(input.attemptId, "attemptId");
    const reference = requireArtifactReference(input.rawArtifact);
    if (
      input.disposition !== "VALID" &&
      input.disposition !== "MALFORMED" &&
      input.disposition !== "REJECTED" &&
      input.disposition !== "OBSOLETE" &&
      input.disposition !== "FAILED"
    ) {
      throw invalidArgument("Worker result disposition is not supported.");
    }
    if (typeof input.selected !== "boolean") {
      throw invalidArgument("Worker result selected flag must be boolean.");
    }
    if (input.selected && input.disposition !== "VALID") {
      throw invariantViolation("Only a valid worker result may be selected.");
    }
    const parsedResultJson =
      input.parsedResult === undefined ? null : encodeJson(input.parsedResult);
    const recordedAt = makeUtcTimestamp(input.recordedAtUtc);
    const contentType = input.contentType ?? "application/octet-stream";
    if (
      typeof contentType !== "string" ||
      contentType.length < 1 ||
      contentType.length > 255
    ) {
      throw invalidArgument(
        "Artifact content type must be 1 to 255 characters.",
      );
    }
    return this.withAsyncImmediateTransaction(async () => {
      const attempt = this.db
        .query(
          "SELECT direction_run_id FROM worker_attempts WHERE attempt_id = ?",
        )
        .get(input.attemptId) as { direction_run_id: string } | null;
      if (attempt === null)
        throw new StorageError("NOT_FOUND", "Worker attempt was not found.");
      await readVerifiedArtifact(this.rootDir, reference);
      const resultId = randomUUID();
      this.insertArtifactRecord(reference, contentType, recordedAt);
      this.db
        .query(
          `INSERT INTO worker_attempt_results
           (result_id, direction_run_id, attempt_id, raw_artifact_sha256, disposition,
            parsed_result_json, selected, recorded_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          resultId,
          attempt.direction_run_id,
          input.attemptId,
          reference.sha256,
          input.disposition,
          parsedResultJson,
          input.selected ? 1 : 0,
          recordedAt,
        );
      const attemptRow = this.db
        .query(
          `SELECT r.cycle_id, dr.direction FROM direction_runs dr
           JOIN review_cycles r ON r.cycle_id = dr.cycle_id
           WHERE dr.direction_run_id = ?`,
        )
        .get(attempt.direction_run_id) as {
        cycle_id: string;
        direction: string;
      } | null;
      if (attemptRow === null)
        throw invariantViolation("Worker attempt has no owning direction run.");
      this.insertEventOutbox({
        reviewId: this.reviewIdForCycle(attemptRow.cycle_id),
        cycleId: attemptRow.cycle_id,
        eventType: "worker.result_recorded",
        payload: {
          resultId,
          attemptId: input.attemptId,
          direction: attemptRow.direction,
          disposition: input.disposition,
          selected: input.selected,
          rawArtifact: reference,
        },
        occurredAtUtc: recordedAt,
      });
      return reference;
    });
  }

  readWorkerResult(attemptId: string): WorkerResultRecord {
    validateIdentifier(attemptId, "attemptId");
    const row = this.db
      .query(
        `SELECT result_id, direction_run_id, attempt_id, raw_artifact_sha256,
                disposition, parsed_result_json, selected, recorded_at_utc,
                a.relative_path, a.byte_size
         FROM worker_attempt_results wr
         JOIN raw_artifacts a ON a.sha256 = wr.raw_artifact_sha256
         WHERE wr.attempt_id = ?`,
      )
      .get(attemptId) as {
      result_id: string;
      direction_run_id: string;
      attempt_id: string;
      raw_artifact_sha256: string;
      disposition: WorkerResultRecord["disposition"];
      parsed_result_json: string | null;
      selected: number;
      recorded_at_utc: string;
      relative_path: string;
      byte_size: number;
    } | null;
    if (row === null) {
      throw new StorageError("NOT_FOUND", "Worker result was not found.");
    }
    const rawArtifact: ArtifactReference = {
      sha256: row.raw_artifact_sha256,
      relativePath: row.relative_path,
      sizeBytes: row.byte_size,
    };
    return {
      resultId: row.result_id,
      directionRunId: row.direction_run_id,
      attemptId: row.attempt_id,
      disposition: row.disposition,
      selected: row.selected === 1,
      rawArtifact,
      ...(row.parsed_result_json === null
        ? {}
        : {
            parsedResult: parseJson<ProtocolJsonValue>(row.parsed_result_json),
          }),
      recordedAtUtc: row.recorded_at_utc,
    };
  }

  recordDirectionRun(input: DirectionRunInput): void {
    validateIdentifier(input.runId, "runId");
    validateIdentifier(input.cycleId, "cycleId");
    validateIdentifier(input.direction, "direction");
    if (
      input.direction !== "correctness" &&
      input.direction !== "tests" &&
      input.direction !== "design"
    ) {
      throw invalidArgument("Direction run direction is not supported.");
    }
    const promptHash = requireSha256(input.promptHash, "promptHash");
    const schemaHash = requireSha256(input.schemaHash, "schemaHash");
    const policyHash = requireSha256(input.policyHash, "policyHash");
    const createdAt = makeUtcTimestamp(input.createdAtUtc);
    this.withImmediateTransaction(() => {
      const reviewId = this.reviewIdForCycle(input.cycleId);
      this.db
        .query(
          `INSERT INTO direction_runs
           (direction_run_id, cycle_id, direction, role, status, prompt_hash, schema_hash, policy_hash, created_at_utc)
           VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          input.cycleId,
          input.direction,
          input.role,
          promptHash,
          schemaHash,
          policyHash,
          createdAt,
        );
      this.insertEventOutbox({
        reviewId,
        cycleId: input.cycleId,
        eventType: "direction_run.recorded",
        payload: {
          directionRunId: input.runId,
          direction: input.direction,
          role: input.role,
          promptHash,
          schemaHash,
          policyHash,
        },
        occurredAtUtc: createdAt,
      });
    });
  }

  transitionDirectionRunStatus(
    runId: string,
    status: DirectionRunStatus,
    occurredAtUtc?: string,
  ): DirectionRunStatus {
    validateIdentifier(runId, "runId");
    if (
      status !== "PENDING" &&
      status !== "RUNNING" &&
      status !== "COMPLETE" &&
      status !== "FAILED" &&
      status !== "OBSOLETE"
    ) {
      throw invalidArgument("Direction run status is not supported.");
    }
    const occurredAt = makeUtcTimestamp(occurredAtUtc);
    return this.withImmediateTransaction(() => {
      const current = this.db
        .query(
          `SELECT dr.status, dr.cycle_id, dr.direction, r.review_id
           FROM direction_runs dr
           JOIN review_cycles r ON r.cycle_id = dr.cycle_id
           WHERE dr.direction_run_id = ?`,
        )
        .get(runId) as {
        status: DirectionRunStatus;
        cycle_id: string;
        direction: string;
        review_id: string;
      } | null;
      if (current === null) {
        throw new StorageError("NOT_FOUND", "Direction run was not found.");
      }
      if (current.status === status) return status;
      const allowed =
        current.status === "PENDING"
          ? status === "RUNNING" || status === "FAILED" || status === "OBSOLETE"
          : current.status === "RUNNING"
            ? status === "COMPLETE" ||
              status === "FAILED" ||
              status === "OBSOLETE"
            : false;
      if (!allowed) {
        throw conflict("Direction run status transition is stale or terminal.");
      }
      if (status === "COMPLETE") {
        const selectedResult = this.db
          .query(
            `SELECT 1 AS found FROM worker_attempt_results
             WHERE direction_run_id = ? AND disposition = 'VALID' AND selected = 1
             LIMIT 1`,
          )
          .get(runId);
        if (selectedResult == null) {
          throw conflict(
            "A direction run requires a selected valid result before completion.",
          );
        }
      }
      const update = this.db
        .query(
          "UPDATE direction_runs SET status = ? WHERE direction_run_id = ? AND status = ?",
        )
        .run(status, runId, current.status);
      if (update.changes !== 1) {
        throw conflict(
          "Direction run status changed before the update completed.",
        );
      }
      this.insertEventOutbox({
        reviewId: current.review_id,
        cycleId: current.cycle_id,
        eventType: "direction_run.status_changed",
        payload: {
          directionRunId: runId,
          direction: current.direction,
          previousStatus: current.status,
          status,
        },
        occurredAtUtc: occurredAt,
      });
      return status;
    });
  }

  readDirectionRunStatus(runId: string): DirectionRunStatus {
    validateIdentifier(runId, "runId");
    const row = this.db
      .query("SELECT status FROM direction_runs WHERE direction_run_id = ?")
      .get(runId) as { status: DirectionRunStatus } | null;
    if (row === null) {
      throw new StorageError("NOT_FOUND", "Direction run was not found.");
    }
    return row.status;
  }

  readDirectionRunBinding(
    runId: string,
    attemptId: string,
  ): DirectionRunBinding {
    validateIdentifier(runId, "runId");
    validateIdentifier(attemptId, "attemptId");
    const row = this.db
      .query(
        `SELECT r.review_id, c.cycle_id, dr.direction_run_id,
                dr.direction, dr.role, wa.attempt_id
         FROM direction_runs dr
         JOIN worker_attempts wa ON wa.direction_run_id = dr.direction_run_id
         JOIN review_cycles c ON c.cycle_id = dr.cycle_id
         JOIN reviews r ON r.review_id = c.review_id
         WHERE dr.direction_run_id = ? AND wa.attempt_id = ?`,
      )
      .get(runId, attemptId) as {
      review_id: string;
      cycle_id: string;
      direction_run_id: string;
      direction: DirectionRunBinding["direction"];
      role: DirectionRunBinding["role"];
      attempt_id: string;
    } | null;
    if (row === null) {
      throw new StorageError(
        "NOT_FOUND",
        "Direction run attempt binding was not found.",
      );
    }
    return {
      reviewId: row.review_id,
      cycleId: row.cycle_id,
      runId: row.direction_run_id,
      attemptId: row.attempt_id,
      direction: row.direction,
      role: row.role,
    };
  }

  appendWorkerAttempt(input: WorkerAttemptInput): void {
    validateIdentifier(input.attemptId, "attemptId");
    validateIdentifier(input.directionRunId, "directionRunId");
    if (!Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1) {
      throw invalidArgument(
        "Worker attempt number must be a positive safe integer.",
      );
    }
    const startedAt = makeUtcTimestamp(input.startedAtUtc);
    const metadata = input.metadata ?? {};
    this.withImmediateTransaction(() => {
      const owner = this.db
        .query(
          "SELECT cycle_id, direction, status FROM direction_runs WHERE direction_run_id = ?",
        )
        .get(input.directionRunId) as {
        cycle_id: string;
        direction: string;
        status: DirectionRunStatus;
      } | null;
      if (owner === null)
        throw new StorageError("NOT_FOUND", "Direction run was not found.");
      if (owner.status !== "PENDING" && owner.status !== "RUNNING") {
        throw conflict("Cannot append an attempt to a terminal direction run.");
      }
      if (owner.status === "PENDING") {
        this.db
          .query(
            "UPDATE direction_runs SET status = 'RUNNING' WHERE direction_run_id = ? AND status = 'PENDING'",
          )
          .run(input.directionRunId);
        this.insertEventOutbox({
          reviewId: this.reviewIdForCycle(owner.cycle_id),
          cycleId: owner.cycle_id,
          eventType: "direction_run.status_changed",
          payload: {
            directionRunId: input.directionRunId,
            direction: owner.direction,
            previousStatus: "PENDING",
            status: "RUNNING",
          },
          occurredAtUtc: startedAt,
        });
      }
      this.db
        .query(
          `INSERT INTO worker_attempts
           (attempt_id, direction_run_id, attempt_number, model, effort, started_at_utc, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.attemptId,
          input.directionRunId,
          input.attemptNumber,
          input.model ?? null,
          input.effort ?? null,
          startedAt,
          encodeJson(metadata),
        );
      this.insertEventOutbox({
        reviewId: this.reviewIdForCycle(owner.cycle_id),
        cycleId: owner.cycle_id,
        eventType: "worker.attempt_appended",
        payload: {
          attemptId: input.attemptId,
          directionRunId: input.directionRunId,
          attemptNumber: input.attemptNumber,
          model: input.model ?? null,
          effort: input.effort ?? null,
        },
        occurredAtUtc: startedAt,
      });
    });
  }

  ensureSchedulerRuns(input: EnsureSchedulerRunsInput): void {
    validateIdentifier(input.cycleId, "cycleId");
    const backendBinding = validateSchedulerBackendProfile(
      input.backendBinding,
    );
    if (input.runs.length !== backendBinding.requiredRuns) {
      throw invalidArgument(
        "The scheduler run set does not match its immutable backend plan.",
      );
    }
    const now = makeUtcTimestamp(input.nowUtc);
    this.withImmediateTransaction(() => {
      this.assertDaemonFencingToken(input.ownerFencing, now);
      const cycle = this.readCycleRow(input.cycleId);
      const state = decodeCycle(cycle.state_json);
      if (state.state !== "REVIEWING" || state.manifestHash === null) {
        throw conflict(
          "Scheduler runs require a REVIEWING cycle with a durable snapshot.",
        );
      }
      const existingBinding = this.db
        .query(
          `SELECT backend_kind, backend_protocol, bridge_version_pin,
                  requested_model, requested_reasoning_effort, qualification,
                  configuration_digest, run_plan, required_run_count
           FROM scheduler_backend_bindings WHERE cycle_id = ?`,
        )
        .get(input.cycleId) as {
        backend_kind: SchedulerBackendProfile["backend"];
        backend_protocol: string;
        bridge_version_pin: string;
        requested_model: string;
        requested_reasoning_effort: string;
        qualification: SchedulerBackendProfile["qualification"];
        configuration_digest: string;
        run_plan: SchedulerBackendProfile["runPlan"];
        required_run_count: number;
      } | null;
      if (existingBinding === null) {
        this.db
          .query(
            `INSERT INTO scheduler_backend_bindings
             (cycle_id, backend_kind, backend_protocol, bridge_version_pin,
              requested_model, requested_reasoning_effort, qualification,
              configuration_digest, run_plan, required_run_count, binding_json,
              created_at_utc)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.cycleId,
            backendBinding.backend,
            backendBinding.backendProtocol,
            backendBinding.bridgeVersionPin,
            backendBinding.model,
            backendBinding.reasoningEffort,
            backendBinding.qualification,
            backendBinding.configurationDigest,
            backendBinding.runPlan,
            backendBinding.requiredRuns,
            encodeJson(backendBinding as unknown as ProtocolJsonValue),
            now,
          );
        this.insertEventOutbox({
          reviewId: cycle.review_id,
          cycleId: input.cycleId,
          eventType: "scheduler.backend_bound",
          payload: backendBinding,
          occurredAtUtc: now,
        });
      } else if (
        !sameSchedulerBackendProfile(backendBinding, {
          backend: existingBinding.backend_kind,
          backendProtocol: existingBinding.backend_protocol,
          bridgeVersionPin: existingBinding.bridge_version_pin,
          model: existingBinding.requested_model,
          reasoningEffort: existingBinding.requested_reasoning_effort,
          qualification: existingBinding.qualification,
          configurationDigest: existingBinding.configuration_digest,
          runPlan: existingBinding.run_plan,
          requiredRuns: existingBinding.required_run_count as 1 | 9,
        })
      ) {
        throw conflict(
          "Scheduler cycle is bound to a different backend configuration.",
        );
      }
      if (
        backendBinding.runPlan === "NR09_LIVE_QUALIFICATION" &&
        (input.runs.length !== 1 ||
          input.runs[0]?.direction !== "correctness" ||
          input.runs[0]?.replicaIndex !== 1)
      ) {
        throw invalidArgument(
          "NR-09 LIVE qualification must contain one correctness run.",
        );
      }
      const slots = new Set<string>();
      for (const run of input.runs) {
        validateIdentifier(run.runId, "runId");
        const slot = `${run.direction}:${run.replicaIndex}`;
        if (
          run.cycleId !== input.cycleId ||
          run.reviewId !== cycle.review_id ||
          run.role !== "reviewer" ||
          !Number.isSafeInteger(run.replicaIndex) ||
          run.replicaIndex < 1 ||
          run.replicaIndex > 3 ||
          slots.has(slot) ||
          !Number.isSafeInteger(run.maxAttempts) ||
          run.maxAttempts < 1 ||
          run.maxAttempts > 10
        ) {
          throw invalidArgument("Scheduler run set is invalid or duplicated.");
        }
        slots.add(slot);
        const deadline = makeUtcTimestamp(run.deadlineAtUtc);
        const promptHash = requireSha256(run.promptHash, "promptHash");
        const schemaHash = requireSha256(run.schemaHash, "schemaHash");
        const policyHash = requireSha256(run.policyHash, "policyHash");
        const existingRun = this.db
          .query(
            `SELECT cycle_id, direction, role, prompt_hash, schema_hash, policy_hash
             FROM direction_runs WHERE direction_run_id = ?`,
          )
          .get(run.runId) as {
          cycle_id: string;
          direction: string;
          role: string;
          prompt_hash: string;
          schema_hash: string;
          policy_hash: string;
        } | null;
        if (existingRun === null) {
          this.db
            .query(
              `INSERT INTO direction_runs
               (direction_run_id, cycle_id, direction, role, status,
                prompt_hash, schema_hash, policy_hash, created_at_utc)
               VALUES (?, ?, ?, 'reviewer', 'PENDING', ?, ?, ?, ?)`,
            )
            .run(
              run.runId,
              input.cycleId,
              run.direction,
              promptHash,
              schemaHash,
              policyHash,
              now,
            );
          this.insertEventOutbox({
            reviewId: run.reviewId,
            cycleId: run.cycleId,
            eventType: "direction_run.recorded",
            payload: {
              backend: backendBinding.backend,
              qualification: backendBinding.qualification,
              directionRunId: run.runId,
              direction: run.direction,
              role: run.role,
              replicaIndex: run.replicaIndex,
              promptHash,
              schemaHash,
              policyHash,
            },
            occurredAtUtc: now,
          });
        } else if (
          existingRun.cycle_id !== input.cycleId ||
          existingRun.direction !== run.direction ||
          existingRun.role !== run.role ||
          existingRun.prompt_hash !== promptHash ||
          existingRun.schema_hash !== schemaHash ||
          existingRun.policy_hash !== policyHash
        ) {
          throw conflict(
            "Existing scheduler run identity has different bindings.",
          );
        }
        const existingJob = this.db
          .query(
            `SELECT review_id, cycle_id, direction, replica_index, max_attempts, deadline_at_utc
             FROM scheduler_jobs WHERE run_id = ?`,
          )
          .get(run.runId) as {
          review_id: string;
          cycle_id: string;
          direction: string;
          replica_index: number;
          max_attempts: number;
          deadline_at_utc: string;
        } | null;
        if (existingJob === null) {
          this.db
            .query(
              `INSERT INTO scheduler_jobs
               (run_id, review_id, cycle_id, direction, replica_index, state,
                attempt_count, max_attempts, next_attempt_at_utc, deadline_at_utc,
                created_at_utc, updated_at_utc)
               VALUES (?, ?, ?, ?, ?, 'QUEUED', 0, ?, ?, ?, ?, ?)`,
            )
            .run(
              run.runId,
              run.reviewId,
              input.cycleId,
              run.direction,
              run.replicaIndex,
              run.maxAttempts,
              now,
              deadline,
              now,
              now,
            );
          this.insertEventOutbox({
            reviewId: run.reviewId,
            cycleId: input.cycleId,
            eventType: "scheduler.job_queued",
            payload: {
              backend: backendBinding.backend,
              qualification: backendBinding.qualification,
              runId: run.runId,
              direction: run.direction,
              replicaIndex: run.replicaIndex,
              maxAttempts: run.maxAttempts,
              deadlineAtUtc: deadline,
            },
            occurredAtUtc: now,
          });
        } else if (
          existingJob.review_id !== run.reviewId ||
          existingJob.cycle_id !== input.cycleId ||
          existingJob.direction !== run.direction ||
          existingJob.replica_index !== run.replicaIndex ||
          existingJob.max_attempts !== run.maxAttempts
        ) {
          throw conflict(
            "Existing scheduler job has different immutable policy.",
          );
        }
      }
      if (slots.size !== backendBinding.requiredRuns) {
        throw invalidArgument(
          "Scheduler run set does not cover its required plan slots.",
        );
      }
    });
  }

  readSchedulerBackendBinding(
    cycleId: string,
  ): SchedulerBackendBinding | undefined {
    validateIdentifier(cycleId, "cycleId");
    const row = this.db
      .query(
        `SELECT backend_kind, backend_protocol, bridge_version_pin,
                requested_model, requested_reasoning_effort, qualification,
                configuration_digest, run_plan, required_run_count,
                binding_json, created_at_utc
         FROM scheduler_backend_bindings WHERE cycle_id = ?`,
      )
      .get(cycleId) as {
      backend_kind: SchedulerBackendProfile["backend"];
      backend_protocol: string;
      bridge_version_pin: string;
      requested_model: string;
      requested_reasoning_effort: string;
      qualification: SchedulerBackendProfile["qualification"];
      configuration_digest: string;
      run_plan: SchedulerBackendProfile["runPlan"];
      required_run_count: number;
      binding_json: string;
      created_at_utc: string;
    } | null;
    if (row === null) return undefined;
    const profile = validateSchedulerBackendProfile({
      backend: row.backend_kind,
      backendProtocol: row.backend_protocol,
      bridgeVersionPin: row.bridge_version_pin,
      model: row.requested_model,
      reasoningEffort: row.requested_reasoning_effort,
      qualification: row.qualification,
      configurationDigest: row.configuration_digest,
      runPlan: row.run_plan,
      requiredRuns: row.required_run_count as 1 | 9,
    });
    const storedJson = parseJson<ProtocolJsonValue>(row.binding_json);
    if (
      canonicalJson(storedJson) !==
      canonicalJson(profile as unknown as ProtocolJsonValue)
    ) {
      throw invariantViolation(
        "Persisted scheduler backend binding does not match its columns.",
      );
    }
    return {
      ...profile,
      cycleId,
      createdAtUtc: makeUtcTimestamp(row.created_at_utc),
    };
  }

  readSchedulerAttemptArtifacts(attemptId: string): SchedulerAttemptArtifact[] {
    validateIdentifier(attemptId, "attemptId");
    return this.db
      .query(
        `SELECT saa.purpose, ra.sha256, ra.byte_size, ra.relative_path
         FROM scheduler_attempt_artifacts saa
         JOIN raw_artifacts ra ON ra.sha256 = saa.artifact_sha256
         WHERE saa.attempt_id = ?
         ORDER BY saa.purpose`,
      )
      .all(attemptId)
      .map((value) => {
        const row = value as {
          purpose: SchedulerAttemptArtifactPurpose;
          sha256: string;
          byte_size: number;
          relative_path: string;
        };
        return {
          purpose: row.purpose,
          reference: {
            sha256: row.sha256,
            sizeBytes: row.byte_size,
            relativePath: row.relative_path,
          },
        };
      });
  }

  readSchedulerAttemptProvenance(
    attemptId: string,
  ): SchedulerAttemptProvenance {
    validateIdentifier(attemptId, "attemptId");
    const row = this.db
      .query(
        `SELECT backend_receipt_sha256, backend_send_state
         FROM scheduler_attempts WHERE attempt_id = ?`,
      )
      .get(attemptId) as {
      backend_receipt_sha256: string | null;
      backend_send_state: "UNSENT" | "SENT" | "UNKNOWN" | null;
    } | null;
    if (row === null) {
      throw new StorageError("NOT_FOUND", "Scheduler attempt was not found.");
    }
    const artifacts = this.readSchedulerAttemptArtifacts(attemptId);
    const receiptArtifact = artifacts.find(
      (artifact) => artifact.purpose === "RECEIPT",
    )?.reference;
    if (row.backend_receipt_sha256 !== (receiptArtifact?.sha256 ?? null)) {
      throw invariantViolation(
        "Scheduler attempt receipt reference does not match its artifact index.",
      );
    }
    return {
      sendState: row.backend_send_state,
      ...(receiptArtifact === undefined ? {} : { receiptArtifact }),
      artifacts,
    };
  }

  readReviewingSchedulerCycles(limit = 100): SnapshotCycleContext[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw invalidArgument(
        "Scheduler cycle limit must be between 1 and 1000.",
      );
    }
    const rows = this.db
      .query(
        `SELECT r.review_id, r.repo_id, r.task, r.acceptance_criteria_json,
                c.cycle_id, c.state_json
         FROM review_cycles c
         JOIN reviews r ON r.review_id = c.review_id
         WHERE c.state = 'REVIEWING'
           AND c.cycle_number = (
             SELECT MAX(latest.cycle_number) FROM review_cycles latest
             WHERE latest.review_id = c.review_id
           )
         ORDER BY c.created_at_utc, c.cycle_id
         LIMIT ?`,
      )
      .all(limit) as Array<{
      review_id: string;
      repo_id: string;
      task: string;
      acceptance_criteria_json: string;
      cycle_id: string;
      state_json: string;
    }>;
    return rows.map((row) => ({
      reviewId: row.review_id,
      cycleId: row.cycle_id,
      repoId: row.repo_id,
      task: row.task,
      acceptanceCriteria: parseJson<ReviewSubmitInput["acceptanceCriteria"]>(
        row.acceptance_criteria_json,
      ),
      cycle: decodeCycle(row.state_json),
    }));
  }

  readAggregatingSchedulerCycles(limit = 100): SnapshotCycleContext[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw invalidArgument(
        "Scheduler cycle limit must be between 1 and 1000.",
      );
    }
    const rows = this.db
      .query(
        `SELECT r.review_id, r.repo_id, r.task, r.acceptance_criteria_json,
                c.cycle_id, c.state_json
         FROM review_cycles c
         JOIN reviews r ON r.review_id = c.review_id
         WHERE c.state = 'AGGREGATING'
           AND c.cycle_number = (
             SELECT MAX(latest.cycle_number) FROM review_cycles latest
             WHERE latest.review_id = c.review_id
           )
         ORDER BY c.created_at_utc, c.cycle_id
         LIMIT ?`,
      )
      .all(limit) as Array<{
      review_id: string;
      repo_id: string;
      task: string;
      acceptance_criteria_json: string;
      cycle_id: string;
      state_json: string;
    }>;
    return rows.map((row) => ({
      reviewId: row.review_id,
      cycleId: row.cycle_id,
      repoId: row.repo_id,
      task: row.task,
      acceptanceCriteria: parseJson<ReviewSubmitInput["acceptanceCriteria"]>(
        row.acceptance_criteria_json,
      ),
      cycle: decodeCycle(row.state_json),
    }));
  }

  claimNextSchedulerJob(
    input: ClaimSchedulerJobInput,
  ): ClaimedSchedulerJob | undefined {
    if (
      !Number.isSafeInteger(input.leaseTtlMs) ||
      input.leaseTtlMs < 1 ||
      input.leaseTtlMs > 24 * 60 * 60 * 1_000 ||
      !Number.isSafeInteger(input.attemptTimeoutMs) ||
      input.attemptTimeoutMs < 1 ||
      input.attemptTimeoutMs > 24 * 60 * 60 * 1_000
    ) {
      throw invalidArgument(
        "Scheduler lease and attempt deadline are invalid.",
      );
    }
    const now = makeUtcTimestamp(input.nowUtc);
    return this.withImmediateTransaction(() => {
      this.assertDaemonFencingToken(input.ownerFencing, now);
      this.recoverExpiredSchedulerLeases(now);
      this.failExpiredQueuedSchedulerJobs(now);
      const cursor = this.db
        .query(
          "SELECT last_review_id FROM scheduler_control WHERE singleton_id = 1",
        )
        .get() as { last_review_id: string | null } | null;
      if (cursor === null) {
        throw invariantViolation("Scheduler fairness cursor is missing.");
      }
      const row = this.db
        .query(
          `SELECT j.run_id, j.review_id, j.cycle_id, j.direction, j.replica_index,
                  j.state, j.attempt_count, j.max_attempts, j.deadline_at_utc
           FROM scheduler_jobs j
           JOIN review_cycles c ON c.cycle_id = j.cycle_id
           WHERE c.state = 'REVIEWING' AND (
             (j.state IN ('QUEUED', 'RETRY_WAIT')
              AND j.next_attempt_at_utc <= ? AND j.deadline_at_utc > ?
              AND j.attempt_count < j.max_attempts) OR
             (j.state = 'RECONCILIATION_REQUIRED'
              AND j.next_attempt_at_utc <= ? AND j.reconciliation_count < 3)
           )
           ORDER BY CASE WHEN ? IS NULL OR j.review_id > ? THEN 0 ELSE 1 END,
             j.review_id, j.direction, j.replica_index, j.run_id
           LIMIT 1`,
        )
        .get(now, now, now, cursor.last_review_id, cursor.last_review_id) as {
        run_id: string;
        review_id: string;
        cycle_id: string;
        direction: "correctness" | "tests" | "design";
        replica_index: number;
        state: SchedulerJobState;
        attempt_count: number;
        max_attempts: number;
        deadline_at_utc: string;
      } | null;
      if (row === null) return undefined;
      const backendBinding = this.readSchedulerBackendBinding(row.cycle_id);
      if (backendBinding === undefined) {
        throw invariantViolation(
          "Scheduler job has no immutable backend binding.",
        );
      }
      const backendMetadata = {
        backend: backendBinding.backend,
        qualification: backendBinding.qualification,
        backendProtocol: backendBinding.backendProtocol,
        bridgeVersionPin: backendBinding.bridgeVersionPin,
        requestedModel: backendBinding.model,
        requestedReasoningEffort: backendBinding.reasoningEffort,
        configurationDigest: backendBinding.configurationDigest,
      };

      const workKind =
        row.state === "RECONCILIATION_REQUIRED" ? "RECONCILIATION" : "TURN";
      let attemptId: string;
      let attemptNumber: number;
      if (workKind === "RECONCILIATION") {
        const previous = this.db
          .query(
            `SELECT attempt_id, attempt_number FROM scheduler_attempts
             WHERE run_id = ? AND state IN ('UNKNOWN_SEND', 'RECONCILIATION_UNKNOWN')
             ORDER BY attempt_number DESC LIMIT 1`,
          )
          .get(row.run_id) as {
          attempt_id: string;
          attempt_number: number;
        } | null;
        if (previous === null) {
          this.failSchedulerJobWithinTransaction(
            row.run_id,
            "NEEDS_RECONCILIATION",
            now,
          );
          return undefined;
        }
        attemptId = previous.attempt_id;
        attemptNumber = previous.attempt_number;
      } else {
        attemptNumber = row.attempt_count + 1;
        attemptId = randomUUID();
      }

      const resourceId = schedulerLeaseResourceId(row.run_id);
      const previousLease = this.currentLease(resourceId);
      if (
        previousLease !== null &&
        previousLease.owner_id !== null &&
        previousLease.expires_at_utc !== null &&
        previousLease.expires_at_utc > now
      ) {
        throw conflict("Scheduler job lease is still held by an active owner.");
      }
      const priorToken = previousLease?.fencing_token ?? 0;
      if (priorToken >= Number.MAX_SAFE_INTEGER) {
        throw new StorageError(
          "CONFLICT",
          "Scheduler lease fencing limit reached.",
        );
      }
      const token = priorToken + 1;
      const expiresAt = new Date(
        Date.parse(now) + input.leaseTtlMs,
      ).toISOString();
      this.db
        .query(
          `INSERT INTO leases
           (resource_id, owner_id, fencing_token, expires_at_utc, updated_at_utc)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(resource_id) DO UPDATE SET
             owner_id = excluded.owner_id,
             fencing_token = excluded.fencing_token,
             expires_at_utc = excluded.expires_at_utc,
             updated_at_utc = excluded.updated_at_utc`,
        )
        .run(resourceId, input.ownerFencing.ownerId, token, expiresAt, now);
      const attemptDeadline = new Date(
        Math.min(
          Date.parse(row.deadline_at_utc),
          Date.parse(now) + input.attemptTimeoutMs,
        ),
      ).toISOString();
      this.db
        .query(
          `UPDATE scheduler_jobs SET state = 'LEASED', attempt_count = ?,
             reconciliation_count = reconciliation_count + ?,
             active_attempt_id = ?, active_work_kind = ?, lease_owner_id = ?,
             lease_token = ?, lease_expires_at_utc = ?, updated_at_utc = ?
           WHERE run_id = ?`,
        )
        .run(
          workKind === "TURN" ? attemptNumber : row.attempt_count,
          workKind === "RECONCILIATION" ? 1 : 0,
          attemptId,
          workKind,
          input.ownerFencing.ownerId,
          token,
          expiresAt,
          now,
          row.run_id,
        );
      if (workKind === "TURN") {
        const directionRun = this.db
          .query("SELECT status FROM direction_runs WHERE direction_run_id = ?")
          .get(row.run_id) as { status: DirectionRunStatus } | null;
        if (directionRun === null) {
          throw invariantViolation("Scheduler job has no direction run.");
        }
        if (directionRun.status === "PENDING") {
          this.db
            .query(
              `UPDATE direction_runs SET status = 'RUNNING'
               WHERE direction_run_id = ? AND status = 'PENDING'`,
            )
            .run(row.run_id);
          this.insertEventOutbox({
            reviewId: row.review_id,
            cycleId: row.cycle_id,
            eventType: "direction_run.status_changed",
            payload: {
              ...backendMetadata,
              directionRunId: row.run_id,
              direction: row.direction,
              previousStatus: "PENDING",
              status: "RUNNING",
            },
            occurredAtUtc: now,
          });
        } else if (directionRun.status !== "RUNNING") {
          throw conflict("Direction run is already terminal.");
        }
        this.db
          .query(
            `INSERT INTO worker_attempts
             (attempt_id, direction_run_id, attempt_number, model, effort,
              started_at_utc, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            attemptId,
            row.run_id,
            attemptNumber,
            backendBinding.model,
            backendBinding.reasoningEffort,
            now,
            encodeJson({
              ...backendMetadata,
              runId: row.run_id,
              replicaIndex: row.replica_index,
              leaseToken: token,
            }),
          );
        this.db
          .query(
            `INSERT INTO scheduler_attempts
             (attempt_id, run_id, attempt_number, state, lease_token,
              deadline_at_utc, started_at_utc)
             VALUES (?, ?, ?, 'RUNNING', ?, ?, ?)`,
          )
          .run(
            attemptId,
            row.run_id,
            attemptNumber,
            token,
            attemptDeadline,
            now,
          );
        this.insertEventOutbox({
          reviewId: row.review_id,
          cycleId: row.cycle_id,
          eventType: "worker.attempt_appended",
          payload: {
            ...backendMetadata,
            attemptId,
            directionRunId: row.run_id,
            attemptNumber,
          },
          occurredAtUtc: now,
        });
      } else {
        this.insertEventOutbox({
          reviewId: row.review_id,
          cycleId: row.cycle_id,
          eventType: "scheduler.reconciliation_started",
          payload: {
            ...backendMetadata,
            runId: row.run_id,
            attemptId,
            leaseToken: token,
          },
          occurredAtUtc: now,
        });
      }
      this.db
        .query(
          "UPDATE scheduler_control SET last_review_id = ? WHERE singleton_id = 1",
        )
        .run(row.review_id);
      return {
        reviewId: row.review_id,
        cycleId: row.cycle_id,
        runId: row.run_id,
        direction: row.direction,
        replicaIndex: row.replica_index,
        attemptId,
        attemptNumber,
        workKind,
        deadlineAtUtc: row.deadline_at_utc,
        attemptDeadlineAtUtc: attemptDeadline,
        lease: { resourceId, ownerId: input.ownerFencing.ownerId, token },
        leaseExpiresAtUtc: expiresAt,
      };
    });
  }

  async finishSchedulerAttempt(
    input: SchedulerAttemptResultInput,
  ): Promise<boolean> {
    validateIdentifier(input.runId, "runId");
    validateIdentifier(input.attemptId, "attemptId");
    validateFencingToken(input.ownerFencing);
    validateFencingToken(input.lease);
    const now = makeUtcTimestamp(input.occurredAtUtc);
    const reference = requireArtifactReference(input.rawArtifact);
    await readVerifiedArtifact(this.rootDir, reference);
    const receiptArtifact =
      input.receiptArtifact === undefined
        ? undefined
        : requireArtifactReference(input.receiptArtifact);
    const auxiliaryArtifacts = schedulerAttemptArtifacts(
      input.auxiliaryArtifacts,
      receiptArtifact,
    );
    for (const artifact of auxiliaryArtifacts) {
      await readVerifiedArtifact(this.rootDir, artifact.reference);
    }
    let parsedOutput: ProtocolValueBySchema["workerOutput"] | undefined;
    if (input.outcome === "SUCCESS") {
      const validation = validateProtocolValue(
        "workerOutput",
        input.parsedResult,
      );
      if (!validation.ok) {
        throw invalidArgument(
          "A successful scheduler result must match workerOutput.",
        );
      }
      parsedOutput = validation.value;
    }
    return this.withImmediateTransaction(() => {
      this.assertDaemonFencingToken(input.ownerFencing, now);
      const job = this.schedulerJobRow(input.runId);
      const backendMetadata = this.schedulerBackendMetadata(job.cycle_id);
      const attempt = this.db
        .query(
          `SELECT state, deadline_at_utc FROM scheduler_attempts
           WHERE attempt_id = ? AND run_id = ?`,
        )
        .get(input.attemptId, input.runId) as {
        state: SchedulerAttemptState;
        deadline_at_utc: string;
      } | null;
      if (attempt === null) {
        throw new StorageError("NOT_FOUND", "Scheduler attempt was not found.");
      }
      this.insertArtifactRecord(reference, "application/json", now);
      for (const artifact of auxiliaryArtifacts) {
        this.recordSchedulerAttemptArtifact(input.attemptId, artifact, now);
      }
      this.recordSchedulerAttemptReceipt(input.attemptId, receiptArtifact);
      this.recordSchedulerAttemptSendState(input.attemptId, input.sendState);
      if (attempt.state !== "RUNNING") {
        this.insertEventOutbox({
          reviewId: job.review_id,
          cycleId: job.cycle_id,
          eventType: "scheduler.late_result_obsolete",
          payload: {
            ...backendMetadata,
            runId: job.run_id,
            attemptId: input.attemptId,
            rawArtifact: reference,
            ...(receiptArtifact === undefined ? {} : { receiptArtifact }),
            auxiliaryArtifacts,
            selected: false,
            previousAttemptState: attempt.state,
          },
          occurredAtUtc: now,
        });
        return false;
      }
      const cycleState = decodeCycle(
        this.readCycleRow(job.cycle_id).state_json,
      ).state;
      const isCurrent =
        cycleState === "REVIEWING" &&
        job.active_work_kind === "TURN" &&
        this.isCurrentSchedulerClaim(job, input.attemptId, input.lease, now);
      if (!isCurrent) {
        this.db
          .query(
            `UPDATE scheduler_attempts SET state = 'OBSOLETE',
             raw_artifact_sha256 = ?, finished_at_utc = ?
             WHERE attempt_id = ? AND state = 'RUNNING'`,
          )
          .run(reference.sha256, now, input.attemptId);
        this.insertEventOutbox({
          reviewId: job.review_id,
          cycleId: job.cycle_id,
          eventType: "scheduler.late_result_obsolete",
          payload: {
            ...backendMetadata,
            runId: job.run_id,
            attemptId: input.attemptId,
            rawArtifact: reference,
            ...(receiptArtifact === undefined ? {} : { receiptArtifact }),
            auxiliaryArtifacts,
            selected: false,
          },
          occurredAtUtc: now,
        });
        return false;
      }
      if (attempt.deadline_at_utc <= now) {
        this.db
          .query(
            `UPDATE scheduler_attempts SET state = 'UNKNOWN_SEND',
             raw_artifact_sha256 = ?, error_class = 'ATTEMPT_DEADLINE_EXCEEDED',
             finished_at_utc = ? WHERE attempt_id = ? AND state = 'RUNNING'`,
          )
          .run(reference.sha256, now, input.attemptId);
        this.clearSchedulerJobLease(
          job.run_id,
          input.attemptId,
          input.lease,
          now,
          {
            state: "RECONCILIATION_REQUIRED",
            latestErrorClass: "ATTEMPT_DEADLINE_EXCEEDED",
          },
        );
        this.insertEventOutbox({
          reviewId: job.review_id,
          cycleId: job.cycle_id,
          eventType: "scheduler.unknown_send",
          payload: {
            ...backendMetadata,
            runId: job.run_id,
            attemptId: input.attemptId,
            rawArtifact: reference,
            ...(receiptArtifact === undefined ? {} : { receiptArtifact }),
            auxiliaryArtifacts,
            reason: "ATTEMPT_DEADLINE_EXCEEDED",
            state: "RECONCILIATION_REQUIRED",
          },
          occurredAtUtc: now,
        });
        return true;
      }

      if (input.outcome === "UNKNOWN_SEND") {
        this.db
          .query(
            `UPDATE scheduler_attempts SET state = 'UNKNOWN_SEND',
             raw_artifact_sha256 = ?, error_class = ?, finished_at_utc = ?
             WHERE attempt_id = ?`,
          )
          .run(
            reference.sha256,
            input.errorClass ?? "UNKNOWN_SEND",
            now,
            input.attemptId,
          );
        this.clearSchedulerJobLease(
          job.run_id,
          input.attemptId,
          input.lease,
          now,
          {
            state: "RECONCILIATION_REQUIRED",
            latestErrorClass: input.errorClass ?? "UNKNOWN_SEND",
          },
        );
        this.insertEventOutbox({
          reviewId: job.review_id,
          cycleId: job.cycle_id,
          eventType: "scheduler.unknown_send",
          payload: {
            ...backendMetadata,
            runId: job.run_id,
            attemptId: input.attemptId,
            rawArtifact: reference,
            ...(receiptArtifact === undefined ? {} : { receiptArtifact }),
            auxiliaryArtifacts,
            state: "RECONCILIATION_REQUIRED",
          },
          occurredAtUtc: now,
        });
        return true;
      }

      let selectedOutput: ProtocolValueBySchema["workerOutput"] | undefined;
      if (input.outcome === "SUCCESS") {
        if (parsedOutput === undefined) {
          throw invariantViolation("Validated worker output was lost.");
        }
        this.assertSchedulerOutput(job, input.attemptId, parsedOutput);
        selectedOutput = parsedOutput;
      }
      const disposition =
        input.outcome === "SUCCESS"
          ? "VALID"
          : input.outcome === "MALFORMED"
            ? "MALFORMED"
            : "FAILED";
      const resultId = randomUUID();
      this.db
        .query(
          `INSERT INTO worker_attempt_results
           (result_id, direction_run_id, attempt_id, raw_artifact_sha256,
            disposition, parsed_result_json, selected, recorded_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          resultId,
          job.run_id,
          input.attemptId,
          reference.sha256,
          disposition,
          selectedOutput === undefined ? null : encodeJson(selectedOutput),
          selectedOutput === undefined ? 0 : 1,
          now,
        );
      this.insertEventOutbox({
        reviewId: job.review_id,
        cycleId: job.cycle_id,
        eventType: "worker.result_recorded",
        payload: {
          ...backendMetadata,
          resultId,
          attemptId: input.attemptId,
          direction: job.direction,
          disposition,
          selected: selectedOutput !== undefined,
          rawArtifact: reference,
          ...(receiptArtifact === undefined ? {} : { receiptArtifact }),
          auxiliaryArtifacts,
        },
        occurredAtUtc: now,
      });

      if (selectedOutput !== undefined) {
        this.recordSchedulerRawFindings(
          job,
          resultId,
          selectedOutput.findings,
          now,
        );
        this.db
          .query(
            `UPDATE scheduler_attempts SET state = 'SUCCEEDED',
             raw_artifact_sha256 = ?, finished_at_utc = ? WHERE attempt_id = ?`,
          )
          .run(reference.sha256, now, input.attemptId);
        this.db
          .query(
            `UPDATE direction_runs SET status = 'COMPLETE'
             WHERE direction_run_id = ? AND status = 'RUNNING'`,
          )
          .run(job.run_id);
        this.insertEventOutbox({
          reviewId: job.review_id,
          cycleId: job.cycle_id,
          eventType: "direction_run.status_changed",
          payload: {
            ...backendMetadata,
            directionRunId: job.run_id,
            direction: job.direction,
            previousStatus: "RUNNING",
            status: "COMPLETE",
          },
          occurredAtUtc: now,
        });
        this.clearSchedulerJobLease(
          job.run_id,
          input.attemptId,
          input.lease,
          now,
          { state: "COMPLETE", latestErrorClass: null },
        );
        return true;
      }

      const retryAt =
        input.outcome === "RETRYABLE_FAILURE" && input.retryAtUtc !== undefined
          ? makeUtcTimestamp(input.retryAtUtc)
          : undefined;
      const canRetry =
        input.outcome === "RETRYABLE_FAILURE" &&
        retryAt !== undefined &&
        retryAt < job.deadline_at_utc &&
        job.attempt_count < job.max_attempts;
      const failureClass = input.errorClass ?? input.outcome;
      this.db
        .query(
          `UPDATE scheduler_attempts SET state = ?, raw_artifact_sha256 = ?,
           error_class = ?, finished_at_utc = ? WHERE attempt_id = ?`,
        )
        .run(
          input.outcome,
          reference.sha256,
          failureClass,
          now,
          input.attemptId,
        );
      if (!canRetry) {
        this.db
          .query(
            `UPDATE direction_runs SET status = 'FAILED'
             WHERE direction_run_id = ? AND status IN ('PENDING', 'RUNNING')`,
          )
          .run(job.run_id);
      }
      this.clearSchedulerJobLease(
        job.run_id,
        input.attemptId,
        input.lease,
        now,
        canRetry
          ? {
              state: "RETRY_WAIT",
              retryAtUtc: retryAt,
              latestErrorClass: failureClass,
            }
          : { state: "FAILED", latestErrorClass: failureClass },
      );
      this.insertEventOutbox({
        reviewId: job.review_id,
        cycleId: job.cycle_id,
        eventType: canRetry ? "scheduler.retry_wait" : "scheduler.run_failed",
        payload: {
          ...backendMetadata,
          runId: job.run_id,
          attemptId: input.attemptId,
          errorClass: failureClass,
          retryAtUtc: canRetry ? retryAt : null,
          jobState: canRetry ? "RETRY_WAIT" : "FAILED",
        },
        occurredAtUtc: now,
      });
      return true;
    });
  }

  async reconcileSchedulerAttempt(
    input: SchedulerReconciliationInput,
  ): Promise<boolean> {
    validateIdentifier(input.runId, "runId");
    validateIdentifier(input.attemptId, "attemptId");
    validateFencingToken(input.ownerFencing);
    validateFencingToken(input.lease);
    const now = makeUtcTimestamp(input.occurredAtUtc);
    let acceptedOutput: ProtocolValueBySchema["workerOutput"] | undefined;
    let acceptedArtifact: ArtifactReference | undefined;
    if (input.outcome === "PROVEN_ACCEPTED_WITH_RESULT") {
      acceptedArtifact = requireArtifactReference(input.rawArtifact);
      await readVerifiedArtifact(this.rootDir, acceptedArtifact);
      const validation = validateProtocolValue(
        "workerOutput",
        input.parsedResult,
      );
      if (!validation.ok) {
        throw invalidArgument(
          "Reconciled worker output does not match workerOutput.",
        );
      }
      acceptedOutput = validation.value;
    }
    return this.withImmediateTransaction(() => {
      this.assertDaemonFencingToken(input.ownerFencing, now);
      const job = this.schedulerJobRow(input.runId);
      const backendMetadata = this.schedulerBackendMetadata(job.cycle_id);
      const attempt = this.db
        .query(
          `SELECT state, raw_artifact_sha256
           FROM scheduler_attempts WHERE attempt_id = ? AND run_id = ?`,
        )
        .get(input.attemptId, input.runId) as {
        state: SchedulerAttemptState;
        raw_artifact_sha256: string | null;
      } | null;
      if (attempt === null) {
        throw new StorageError(
          "NOT_FOUND",
          "Unknown-send attempt was not found.",
        );
      }
      this.recordSchedulerAttemptSendState(
        input.attemptId,
        input.outcome === "PROVEN_UNSENT"
          ? "UNSENT"
          : input.outcome === "PROVEN_ACCEPTED_WITH_RESULT"
            ? "SENT"
            : "UNKNOWN",
      );
      const current =
        decodeCycle(this.readCycleRow(job.cycle_id).state_json).state ===
          "REVIEWING" &&
        job.active_work_kind === "RECONCILIATION" &&
        this.isCurrentSchedulerClaim(job, input.attemptId, input.lease, now);
      if (!current) {
        if (acceptedArtifact !== undefined) {
          this.insertArtifactRecord(acceptedArtifact, "application/json", now);
        }
        this.insertEventOutbox({
          reviewId: job.review_id,
          cycleId: job.cycle_id,
          eventType: "scheduler.late_result_obsolete",
          payload: {
            ...backendMetadata,
            runId: job.run_id,
            attemptId: input.attemptId,
            reconciliationOutcome: input.outcome,
            selected: false,
            previousAttemptState: attempt.state,
            ...(acceptedArtifact === undefined
              ? {}
              : { rawArtifact: acceptedArtifact }),
          },
          occurredAtUtc: now,
        });
        return false;
      }

      if (input.outcome === "STILL_UNKNOWN") {
        this.db
          .query(
            `UPDATE scheduler_attempts SET state = 'RECONCILIATION_UNKNOWN',
             reconciliation_outcome = 'STILL_UNKNOWN', finished_at_utc = ?
             WHERE attempt_id = ?`,
          )
          .run(now, input.attemptId);
        const retryAt =
          input.retryAtUtc === undefined
            ? new Date(Date.parse(now) + 60_000).toISOString()
            : makeUtcTimestamp(input.retryAtUtc);
        this.clearSchedulerJobLease(
          job.run_id,
          input.attemptId,
          input.lease,
          now,
          {
            state: "RECONCILIATION_REQUIRED",
            retryAtUtc: retryAt,
            latestErrorClass: "UNKNOWN_SEND",
          },
        );
        this.insertEventOutbox({
          reviewId: job.review_id,
          cycleId: job.cycle_id,
          eventType: "scheduler.reconciliation_unknown",
          payload: {
            ...backendMetadata,
            runId: job.run_id,
            attemptId: input.attemptId,
            reconciliationOutcome: "STILL_UNKNOWN",
            state: "RECONCILIATION_REQUIRED",
          },
          occurredAtUtc: now,
        });
        return true;
      }

      if (input.outcome === "PROVEN_UNSENT") {
        this.db
          .query(
            `UPDATE scheduler_attempts SET state = 'RECONCILED_UNSENT',
             reconciliation_outcome = 'PROVEN_UNSENT', finished_at_utc = ?
             WHERE attempt_id = ?`,
          )
          .run(now, input.attemptId);
        const retryAt =
          input.retryAtUtc === undefined
            ? now
            : makeUtcTimestamp(input.retryAtUtc);
        const canRetry =
          job.attempt_count < job.max_attempts && retryAt < job.deadline_at_utc;
        if (attempt.raw_artifact_sha256 !== null) {
          this.db
            .query(
              `INSERT INTO worker_attempt_results
               (result_id, direction_run_id, attempt_id, raw_artifact_sha256,
                disposition, selected, recorded_at_utc)
               VALUES (?, ?, ?, ?, 'FAILED', 0, ?)`,
            )
            .run(
              randomUUID(),
              job.run_id,
              input.attemptId,
              attempt.raw_artifact_sha256,
              now,
            );
        }
        if (!canRetry) {
          this.db
            .query(
              `UPDATE direction_runs SET status = 'FAILED'
               WHERE direction_run_id = ? AND status = 'RUNNING'`,
            )
            .run(job.run_id);
        }
        this.clearSchedulerJobLease(
          job.run_id,
          input.attemptId,
          input.lease,
          now,
          canRetry
            ? {
                state: "RETRY_WAIT",
                retryAtUtc: retryAt,
                latestErrorClass: "PROVEN_UNSENT",
              }
            : { state: "FAILED", latestErrorClass: "PROVEN_UNSENT" },
        );
        this.insertEventOutbox({
          reviewId: job.review_id,
          cycleId: job.cycle_id,
          eventType: "scheduler.reconciled_unsent",
          payload: {
            ...backendMetadata,
            runId: job.run_id,
            attemptId: input.attemptId,
            retryAtUtc: canRetry ? retryAt : null,
            jobState: canRetry ? "RETRY_WAIT" : "FAILED",
          },
          occurredAtUtc: now,
        });
        return true;
      }

      if (acceptedOutput === undefined || acceptedArtifact === undefined) {
        throw invariantViolation(
          "Accepted reconciliation result was not validated.",
        );
      }
      this.assertSchedulerOutput(job, input.attemptId, acceptedOutput);
      this.insertArtifactRecord(acceptedArtifact, "application/json", now);
      const resultId = randomUUID();
      this.db
        .query(
          `INSERT INTO worker_attempt_results
           (result_id, direction_run_id, attempt_id, raw_artifact_sha256,
            disposition, parsed_result_json, selected, recorded_at_utc)
           VALUES (?, ?, ?, ?, 'VALID', ?, 1, ?)`,
        )
        .run(
          resultId,
          job.run_id,
          input.attemptId,
          acceptedArtifact.sha256,
          encodeJson(acceptedOutput),
          now,
        );
      this.recordSchedulerRawFindings(
        job,
        resultId,
        acceptedOutput.findings,
        now,
      );
      this.db
        .query(
          `UPDATE scheduler_attempts SET state = 'RECONCILED_ACCEPTED',
           reconciliation_outcome = 'PROVEN_ACCEPTED_WITH_RESULT',
           raw_artifact_sha256 = ?, finished_at_utc = ? WHERE attempt_id = ?`,
        )
        .run(acceptedArtifact.sha256, now, input.attemptId);
      this.db
        .query(
          `UPDATE direction_runs SET status = 'COMPLETE'
           WHERE direction_run_id = ? AND status = 'RUNNING'`,
        )
        .run(job.run_id);
      this.clearSchedulerJobLease(
        job.run_id,
        input.attemptId,
        input.lease,
        now,
        { state: "COMPLETE", latestErrorClass: null },
      );
      this.insertEventOutbox({
        reviewId: job.review_id,
        cycleId: job.cycle_id,
        eventType: "scheduler.reconciled_accepted",
        payload: {
          ...backendMetadata,
          runId: job.run_id,
          attemptId: input.attemptId,
          resultId,
          rawArtifact: acceptedArtifact,
        },
        occurredAtUtc: now,
      });
      return true;
    });
  }

  cancelSchedulerCycle(input: CancelSchedulerCycleInput): void {
    validateIdentifier(input.cycleId, "cycleId");
    const now = makeUtcTimestamp(input.occurredAtUtc);
    this.withImmediateTransaction(() => {
      this.assertDaemonFencingToken(input.ownerFencing, now);
      const cycle = this.readCycleRow(input.cycleId);
      const backendMetadata = this.schedulerBackendMetadata(input.cycleId);
      const state = decodeCycle(cycle.state_json).state;
      if (state !== "CANCEL_REQUESTED" && state !== "CANCELLED") {
        throw conflict(
          "Scheduler cancellation requires a requested cancellation.",
        );
      }
      const jobs = this.db
        .query(
          `SELECT run_id, state, active_attempt_id, active_work_kind,
                  lease_owner_id, lease_token
           FROM scheduler_jobs WHERE cycle_id = ?
             AND state NOT IN ('COMPLETE', 'FAILED', 'CANCELLED', 'OBSOLETE')`,
        )
        .all(input.cycleId) as Array<{
        run_id: string;
        state: SchedulerJobState;
        active_attempt_id: string | null;
        active_work_kind: "TURN" | "RECONCILIATION" | null;
        lease_owner_id: string | null;
        lease_token: number;
      }>;
      for (const job of jobs) {
        if (job.active_attempt_id !== null) {
          if (job.active_work_kind === "TURN") {
            this.recordSchedulerAttemptSendState(
              job.active_attempt_id,
              "UNKNOWN",
            );
          }
          this.db
            .query(
              `UPDATE scheduler_attempts SET state = 'CANCELLED',
               finished_at_utc = ? WHERE attempt_id = ? AND state IN (
                 'RUNNING', 'UNKNOWN_SEND', 'RECONCILIATION_UNKNOWN'
               )`,
            )
            .run(now, job.active_attempt_id);
        }
        if (job.lease_owner_id !== null) {
          this.db
            .query(
              `UPDATE leases SET owner_id = NULL, expires_at_utc = NULL,
               updated_at_utc = ? WHERE resource_id = ? AND owner_id = ?
               AND fencing_token = ?`,
            )
            .run(
              now,
              schedulerLeaseResourceId(job.run_id),
              job.lease_owner_id,
              job.lease_token,
            );
        }
        this.db
          .query(
            `UPDATE scheduler_jobs SET state = 'CANCELLED',
             active_attempt_id = NULL, active_work_kind = NULL,
             lease_owner_id = NULL, lease_expires_at_utc = ?, updated_at_utc = ?
             WHERE run_id = ?`,
          )
          .run(null, now, job.run_id);
        this.insertEventOutbox({
          reviewId: cycle.review_id,
          cycleId: input.cycleId,
          eventType: "scheduler.job_cancelled",
          payload: {
            ...backendMetadata,
            runId: job.run_id,
            previousState: job.state,
            activeAttemptId: job.active_attempt_id,
          },
          occurredAtUtc: now,
        });
      }
    });
  }

  async recordSchedulerAggregation(
    input: SchedulerAggregationInput,
  ): Promise<void> {
    validateIdentifier(input.cycleId, "cycleId");
    validateFencingToken(input.ownerFencing);
    const now = makeUtcTimestamp(input.occurredAtUtc);
    const reference = requireArtifactReference(input.rawArtifact);
    await readVerifiedArtifact(this.rootDir, reference);
    this.withImmediateTransaction(() => {
      this.assertDaemonFencingToken(input.ownerFencing, now);
      const cycle = this.readCycleRow(input.cycleId);
      if (decodeCycle(cycle.state_json).state !== "AGGREGATING") {
        throw conflict("Scheduler aggregation requires an AGGREGATING cycle.");
      }
      const reportJson = encodeJson(input.report);
      const existing = this.db
        .query(
          `SELECT backend, qualification, state, report_json,
                  raw_artifact_sha256 FROM scheduler_aggregations WHERE cycle_id = ?`,
        )
        .get(input.cycleId) as {
        backend: string;
        qualification: string;
        state: string;
        report_json: string;
        raw_artifact_sha256: string;
      } | null;
      if (existing !== null) {
        if (
          existing.backend !== input.backend ||
          existing.qualification !== input.qualification ||
          existing.state !== input.state ||
          existing.report_json !== reportJson ||
          existing.raw_artifact_sha256 !== reference.sha256
        ) {
          throw conflict(
            "Scheduler aggregation changed after it was recorded.",
          );
        }
        return;
      }
      this.insertArtifactRecord(reference, "application/json", now);
      this.db
        .query(
          `INSERT INTO scheduler_aggregations
           (cycle_id, backend, qualification, state, report_json,
            raw_artifact_sha256, created_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.cycleId,
          input.backend,
          input.qualification,
          input.state,
          reportJson,
          reference.sha256,
          now,
        );
      this.insertEventOutbox({
        reviewId: cycle.review_id,
        cycleId: input.cycleId,
        eventType: "scheduler.aggregation_recorded",
        payload: {
          backend: input.backend,
          qualification: input.qualification,
          state: input.state,
          rawArtifact: reference,
          provisional: input.state === "PROVISIONAL_FINDINGS",
          semanticAdjudication: "NOT_PERFORMED",
        },
        occurredAtUtc: now,
      });
    });
  }

  readSchedulerCycleStatus(cycleId: string): SchedulerCycleStatus {
    validateIdentifier(cycleId, "cycleId");
    const cycle = this.readCycleRow(cycleId);
    const reviewState = decodeCycle(cycle.state_json).state;
    const backendBinding = this.readSchedulerBackendBinding(cycleId);
    const counts = this.db
      .query(
        `SELECT COUNT(*) AS required_runs,
           SUM(CASE WHEN state = 'COMPLETE' THEN 1 ELSE 0 END) AS completed_runs,
           SUM(CASE WHEN state = 'LEASED' THEN 1 ELSE 0 END) AS active_runs,
           SUM(CASE WHEN state = 'RETRY_WAIT' THEN 1 ELSE 0 END) AS retry_waiting_runs,
           SUM(CASE WHEN state = 'RECONCILIATION_REQUIRED' THEN 1 ELSE 0 END)
             AS reconciliation_runs,
           SUM(CASE WHEN state = 'FAILED' THEN 1 ELSE 0 END) AS failed_runs
         FROM scheduler_jobs WHERE cycle_id = ?`,
      )
      .get(cycleId) as {
      required_runs: number;
      completed_runs: number | null;
      active_runs: number | null;
      retry_waiting_runs: number | null;
      reconciliation_runs: number | null;
      failed_runs: number | null;
    };
    if (
      (backendBinding === undefined && counts.required_runs > 0) ||
      (backendBinding !== undefined &&
        counts.required_runs !== backendBinding.requiredRuns)
    ) {
      throw invariantViolation(
        "Scheduler backend binding does not match its persisted run plan.",
      );
    }
    const aggregation = this.db
      .query(
        "SELECT report_json FROM scheduler_aggregations WHERE cycle_id = ?",
      )
      .get(cycleId) as { report_json: string } | null;
    const report =
      aggregation === null
        ? undefined
        : parseJson<ProtocolJsonValue>(aggregation.report_json);
    const findings =
      typeof report === "object" &&
      report !== null &&
      !Array.isArray(report) &&
      "provisionalFindings" in report &&
      Array.isArray(report.provisionalFindings)
        ? (report.provisionalFindings as unknown as SchedulerCycleStatus["provisionalFindings"])
        : [];
    let schedulerState: SchedulerCycleStatus["state"];
    if (reviewState === "APPROVED") schedulerState = "COMPLETE";
    else if (reviewState === "FAILED") schedulerState = "FAILED";
    else if (
      reviewState === "CANCELLED" ||
      reviewState === "CANCEL_REQUESTED"
    ) {
      schedulerState = "CANCELLED";
    } else if ((counts.reconciliation_runs ?? 0) > 0) {
      schedulerState = "RECONCILIATION_REQUIRED";
    } else if ((counts.failed_runs ?? 0) > 0) {
      schedulerState = "FAILED";
    } else if (
      backendBinding?.backend === "LIVE" &&
      (counts.completed_runs ?? 0) === backendBinding.requiredRuns &&
      (counts.active_runs ?? 0) === 0 &&
      (counts.retry_waiting_runs ?? 0) === 0 &&
      (counts.reconciliation_runs ?? 0) === 0
    ) {
      schedulerState = "COMPLETE";
    } else if (aggregation !== null || reviewState === "AGGREGATING") {
      schedulerState = "AGGREGATING";
    } else if (
      (counts.active_runs ?? 0) > 0 ||
      (counts.completed_runs ?? 0) > 0
    ) {
      schedulerState = "RUNNING";
    } else {
      schedulerState = "QUEUED";
    }
    return {
      backend: backendBinding?.backend ?? "FAKE",
      qualification: backendBinding?.qualification ?? "OFFLINE_ONLY",
      state: schedulerState,
      completedRuns: counts.completed_runs ?? 0,
      requiredRuns: Math.max(
        counts.required_runs ?? 0,
        backendBinding?.requiredRuns ?? 9,
      ),
      activeRuns: counts.active_runs ?? 0,
      retryWaitingRuns: counts.retry_waiting_runs ?? 0,
      reconciliationRequiredRuns: counts.reconciliation_runs ?? 0,
      failedRuns: counts.failed_runs ?? 0,
      provisionalFindings: findings,
    };
  }

  readSchedulerSelectedRuns(cycleId: string): SchedulerSelectedRun[] {
    validateIdentifier(cycleId, "cycleId");
    this.readCycle(cycleId);
    const backendBinding = this.readSchedulerBackendBinding(cycleId);
    const requiredRuns = backendBinding?.requiredRuns ?? 9;
    const rows = this.db
      .query(
        `SELECT j.run_id, j.direction, j.replica_index,
                wr.parsed_result_json, wr.disposition, wr.selected
         FROM scheduler_jobs j
         LEFT JOIN worker_attempt_results wr
           ON wr.direction_run_id = j.run_id AND wr.selected = 1
         WHERE j.cycle_id = ? AND j.state = 'COMPLETE'
         ORDER BY j.direction, j.replica_index, j.run_id`,
      )
      .all(cycleId) as Array<{
      run_id: string;
      direction: SchedulerSelectedRun["direction"];
      replica_index: number;
      parsed_result_json: string | null;
      disposition: string | null;
      selected: number | null;
    }>;
    if (
      rows.length !== requiredRuns ||
      rows.some(
        (row) =>
          row.selected !== 1 ||
          row.disposition !== "VALID" ||
          row.parsed_result_json === null,
      )
    ) {
      throw needsReconciliation(
        "The scheduler does not have all selected valid run outputs for its backend plan.",
      );
    }
    return rows.map((row) => ({
      runId: row.run_id,
      direction: row.direction,
      replicaIndex: row.replica_index,
      output: parseJson<ProtocolJsonValue>(row.parsed_result_json as string),
    }));
  }

  nextSchedulerWakeupUtc(): string | undefined {
    const row = this.db
      .query(
        `SELECT MIN(CASE WHEN j.state = 'LEASED'
             THEN j.lease_expires_at_utc ELSE j.next_attempt_at_utc END) AS next_at
         FROM scheduler_jobs j JOIN review_cycles c ON c.cycle_id = j.cycle_id
         WHERE c.state = 'REVIEWING' AND (
           j.state IN ('QUEUED', 'RETRY_WAIT', 'LEASED') OR
           (j.state = 'RECONCILIATION_REQUIRED' AND j.reconciliation_count < 3)
         )`,
      )
      .get() as { next_at: string | null } | null;
    return row?.next_at ?? undefined;
  }

  recordRawFinding(input: RawFindingInput): void {
    validateIdentifier(input.rawFindingId, "rawFindingId");
    validateIdentifier(input.resultId, "resultId");
    validateIdentifier(input.localId, "localId");
    const createdAt = makeUtcTimestamp(input.createdAtUtc);
    this.withImmediateTransaction(() => {
      const owner = this.db
        .query(
          `SELECT dr.cycle_id FROM worker_attempt_results wr
           JOIN direction_runs dr ON dr.direction_run_id = wr.direction_run_id
           WHERE wr.result_id = ? AND wr.disposition = 'VALID'`,
        )
        .get(input.resultId) as { cycle_id: string } | null;
      if (owner === null) {
        throw invariantViolation(
          "Raw finding must belong to a valid persisted worker result.",
        );
      }
      this.db
        .query(
          `INSERT INTO raw_findings (raw_finding_id, result_id, local_id, payload_json, created_at_utc)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.rawFindingId,
          input.resultId,
          input.localId,
          encodeJson(input.payload),
          createdAt,
        );
      this.insertEventOutbox({
        reviewId: this.reviewIdForCycle(owner.cycle_id),
        cycleId: owner.cycle_id,
        eventType: "finding.raw_recorded",
        payload: {
          rawFindingId: input.rawFindingId,
          resultId: input.resultId,
          localId: input.localId,
        },
        occurredAtUtc: createdAt,
      });
    });
  }

  recordCanonicalFinding(input: CanonicalFindingInput): void {
    validateIdentifier(input.findingId, "findingId");
    validateIdentifier(input.cycleId, "cycleId");
    if (input.sources.length === 0)
      throw invalidArgument(
        "Canonical finding must retain at least one source.",
      );
    const createdAt = makeUtcTimestamp(input.createdAtUtc);
    this.withImmediateTransaction(() => {
      const reviewId = this.reviewIdForCycle(input.cycleId);
      this.db
        .query(
          `INSERT INTO canonical_findings
           (finding_id, cycle_id, severity, validation, blocking, payload_json, created_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.findingId,
          input.cycleId,
          input.severity,
          input.validation,
          input.blocking ? 1 : 0,
          encodeJson(input.payload),
          createdAt,
        );
      for (const source of input.sources) {
        const provenance = this.db
          .query(
            `SELECT rf.local_id, wr.attempt_id, wr.direction_run_id, dr.cycle_id
             FROM raw_findings rf
             JOIN worker_attempt_results wr ON wr.result_id = rf.result_id
             JOIN direction_runs dr ON dr.direction_run_id = wr.direction_run_id
             WHERE rf.raw_finding_id = ?`,
          )
          .get(source.rawFindingId) as {
          local_id: string;
          attempt_id: string;
          direction_run_id: string;
          cycle_id: string;
        } | null;
        if (
          provenance === null ||
          provenance.attempt_id !== source.attemptId ||
          provenance.direction_run_id !== source.directionRunId ||
          provenance.cycle_id !== input.cycleId ||
          provenance.local_id !== source.sourceLocalId
        ) {
          throw invariantViolation(
            "Finding source does not match its persisted raw provenance.",
          );
        }
        this.db
          .query(
            `INSERT INTO finding_sources
             (finding_id, raw_finding_id, direction_run_id, attempt_id, source_local_id, created_at_utc)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.findingId,
            source.rawFindingId,
            source.directionRunId,
            source.attemptId,
            source.sourceLocalId,
            createdAt,
          );
      }
      this.insertEventOutbox({
        reviewId,
        cycleId: input.cycleId,
        eventType: "finding.canonical_recorded",
        payload: {
          findingId: input.findingId,
          severity: input.severity,
          validation: input.validation,
          blocking: input.blocking,
          sources: input.sources,
        },
        occurredAtUtc: createdAt,
      });
    });
  }

  readCanonicalFindings(cycleId: string): CanonicalFindingRecord[] {
    validateIdentifier(cycleId, "cycleId");
    this.readCycle(cycleId);
    const rows = this.db
      .query(
        `SELECT finding_id, cycle_id, severity, validation, blocking, payload_json, created_at_utc
         FROM canonical_findings WHERE cycle_id = ? ORDER BY finding_id`,
      )
      .all(cycleId) as Array<{
      finding_id: string;
      cycle_id: string;
      severity: CanonicalFindingRecord["severity"];
      validation: CanonicalFindingRecord["validation"];
      blocking: number;
      payload_json: string;
      created_at_utc: string;
    }>;
    return rows.map((row) => {
      const sources = this.db
        .query(
          `SELECT raw_finding_id, direction_run_id, attempt_id, source_local_id
           FROM finding_sources WHERE finding_id = ? ORDER BY raw_finding_id`,
        )
        .all(row.finding_id) as Array<{
        raw_finding_id: string;
        direction_run_id: string;
        attempt_id: string;
        source_local_id: string;
      }>;
      return {
        findingId: row.finding_id,
        cycleId: row.cycle_id,
        severity: row.severity,
        validation: row.validation,
        blocking: row.blocking === 1,
        payload: parseJson<ProtocolJsonValue>(row.payload_json),
        sources: sources.map((source) => ({
          rawFindingId: source.raw_finding_id,
          directionRunId: source.direction_run_id,
          attemptId: source.attempt_id,
          sourceLocalId: source.source_local_id,
        })),
        createdAtUtc: row.created_at_utc,
      };
    });
  }

  recordAdjudicationDecision(input: AdjudicationDecisionInput): void {
    validateIdentifier(input.decisionId, "decisionId");
    validateIdentifier(input.cycleId, "cycleId");
    validateIdentifier(input.findingId, "findingId");
    const evidenceDigest = requireSha256(
      input.evidenceDigest,
      "evidenceDigest",
    );
    if (input.rationale.trim().length === 0)
      throw invalidArgument("Adjudication rationale cannot be empty.");
    const createdAt = makeUtcTimestamp(input.createdAtUtc);
    this.withImmediateTransaction(() => {
      const reviewId = this.reviewIdForCycle(input.cycleId);
      const finding = this.db
        .query("SELECT cycle_id FROM canonical_findings WHERE finding_id = ?")
        .get(input.findingId) as { cycle_id: string } | null;
      if (finding === null || finding.cycle_id !== input.cycleId) {
        throw invariantViolation(
          "Adjudication decision must refer to a finding in the same cycle.",
        );
      }
      this.db
        .query(
          `INSERT INTO adjudication_decisions
           (decision_id, cycle_id, finding_id, outcome, rationale, evidence_digest, created_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.decisionId,
          input.cycleId,
          input.findingId,
          input.outcome,
          input.rationale,
          evidenceDigest,
          createdAt,
        );
      this.insertEventOutbox({
        reviewId,
        cycleId: input.cycleId,
        eventType: "finding.adjudication_recorded",
        payload: {
          decisionId: input.decisionId,
          findingId: input.findingId,
          outcome: input.outcome,
          evidenceDigest,
        },
        occurredAtUtc: createdAt,
      });
    });
  }

  submitFix(input: FixSubmissionInput): FixSubmissionResult {
    validateIdentifier(input.callerId, "callerId");
    validateIdentifier(input.reviewId, "reviewId");
    validateIdentifier(input.cycleId, "cycleId");
    validateIdentifier(input.idempotencyKey, "idempotencyKey");
    validateExpectedVersion(input.expectedVersion);
    if (!Array.isArray(input.resolutions) || input.resolutions.length === 0)
      throw invalidArgument("Fix submission requires at least one resolution.");
    const resolutions = [...input.resolutions];
    const ids = resolutions.map(({ findingId }) => {
      validateIdentifier(findingId, "findingId");
      return findingId;
    });
    if (new Set(ids).size !== ids.length)
      throw invalidArgument("Fix submission contains duplicate finding IDs.");
    for (const resolution of resolutions) {
      if (
        typeof resolution.note !== "string" ||
        resolution.note.trim().length === 0 ||
        resolution.note.length > 4096
      )
        throw invalidArgument("Fix resolution note cannot be empty.");
    }
    const requestPayload = {
      reviewId: input.reviewId,
      cycleId: input.cycleId,
      previousSha: input.previousSha,
      headSha: input.headSha,
      expectedVersion: input.expectedVersion,
      resolutions,
    };
    const binding = requireIdempotencyBinding(
      input.idempotencyKey,
      requestPayload,
    );
    const submittedAt = makeUtcTimestamp(input.submittedAtUtc);
    return this.withImmediateTransaction(() => {
      const replay = this.lookupWithinTransaction(
        input.callerId,
        "review_submit_fix",
        input.idempotencyKey,
        binding.normalizedPayloadHash,
      );
      if (replay !== undefined) return replay.result as FixSubmissionResult;
      const cycle = this.readCycleRow(input.cycleId);
      if (cycle.review_id !== input.reviewId)
        throw invariantViolation(
          "Fix submission review/cycle ownership mismatch.",
        );
      if (cycle.state_version !== input.expectedVersion) {
        throw conflict(
          "Fix submission stateVersion did not match expectedVersion.",
        );
      }
      const state = decodeCycle(cycle.state_json);
      if (
        state.state !== "NEEDS_FIX" ||
        state.revisions.headSha !== input.previousSha
      ) {
        throw conflict(
          "Fix submission is stale for the current cycle state and head revision.",
        );
      }
      requireGitSha(input.previousSha, cycle.object_format, "previousSha");
      requireGitSha(input.headSha, cycle.object_format, "headSha");
      if (input.headSha === input.previousSha)
        throw invalidArgument(
          "Fix submission head must differ from previousSha.",
        );
      const expectedFindingIds = state.requiredFindingIds;
      const submittedFindingIds = [...ids].sort(compareOrdinal);
      if (
        submittedFindingIds.length !== expectedFindingIds.length ||
        submittedFindingIds.some(
          (findingId, index) => findingId !== expectedFindingIds[index],
        )
      ) {
        throw invalidArgument(
          "Fix resolutions must cover exactly the authoritative finding IDs.",
        );
      }
      const transitionCommand: ReviewTransitionCommand = {
        type: "ADVANCE",
        target: "VERIFYING_FIX",
        expectedVersion: input.expectedVersion,
        idempotencyKey: fixTransitionKey(input.callerId, input.idempotencyKey),
        evidence: {
          atomicFixSubmissionValidated: true,
          fixRevisions: {
            objectFormat: cycle.object_format,
            baseSha: input.previousSha,
            headSha: input.headSha,
          },
        },
      };
      const transition = transitionReviewCycle(state, transitionCommand);
      if (!transition.ok)
        throw mapProtocolTransitionError(transition.error.code);
      const fixId = randomUUID();
      const result: FixSubmissionResult = {
        fixId,
        reviewId: input.reviewId,
        cycleId: input.cycleId,
        previousSha: input.previousSha,
        headSha: input.headSha,
        state: "VERIFYING_FIX",
        stateVersion: transition.state.stateVersion,
        revisions: {
          objectFormat: cycle.object_format,
          baseSha: input.previousSha,
          headSha: input.headSha,
        },
      };
      this.db
        .query(
          `INSERT INTO fix_submissions
           (fix_id, review_id, cycle_id, previous_sha, head_sha, resolutions_json, caller_id,
            operation, idempotency_key, normalized_request_sha256, submitted_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'review_submit_fix', ?, ?, ?)`,
        )
        .run(
          fixId,
          input.reviewId,
          input.cycleId,
          input.previousSha,
          input.headSha,
          encodeJson(resolutions),
          input.callerId,
          input.idempotencyKey,
          binding.normalizedPayloadHash,
          submittedAt,
        );
      this.updateCycleState(cycle, transition.state, submittedAt);
      this.db
        .query("UPDATE reviews SET updated_at_utc = ? WHERE review_id = ?")
        .run(submittedAt, input.reviewId);
      this.insertEventOutbox({
        reviewId: input.reviewId,
        cycleId: input.cycleId,
        eventType: "review.cycle_transitioned",
        payload: { command: transitionCommand, state: transition.state },
        occurredAtUtc: submittedAt,
      });
      this.insertEventOutbox({
        reviewId: input.reviewId,
        cycleId: input.cycleId,
        eventType: "review.fix_submitted",
        payload: result,
        occurredAtUtc: submittedAt,
      });
      this.insertIdempotencyRecord({
        callerId: input.callerId,
        operation: "review_submit_fix",
        idempotencyKey: input.idempotencyKey,
        normalizedPayloadHash: binding.normalizedPayloadHash,
        resultType: "review_submit_fix",
        resultId: fixId,
        result,
        createdAtUtc: submittedAt,
      });
      return result;
    });
  }

  recordFindingVerification(input: RecordFindingVerificationInput): void {
    validateIdentifier(input.verificationId, "verificationId");
    validateIdentifier(input.fixId, "fixId");
    validateIdentifier(input.findingId, "findingId");
    if (
      input.evidence.length === 0 ||
      input.evidence.some((item) => item.trim().length === 0)
    ) {
      throw invalidArgument(
        "Finding verification requires non-empty evidence.",
      );
    }
    const recordedAt = makeUtcTimestamp(input.recordedAtUtc);
    this.withImmediateTransaction(() => {
      const owner = this.db
        .query(
          "SELECT review_id, cycle_id FROM fix_submissions WHERE fix_id = ?",
        )
        .get(input.fixId) as { review_id: string; cycle_id: string } | null;
      if (owner === null)
        throw new StorageError("NOT_FOUND", "Fix submission was not found.");
      const finding = this.db
        .query("SELECT cycle_id FROM canonical_findings WHERE finding_id = ?")
        .get(input.findingId) as { cycle_id: string } | null;
      if (finding === null || finding.cycle_id !== owner.cycle_id) {
        throw invariantViolation(
          "Finding verification must refer to a canonical finding in the fix cycle.",
        );
      }
      this.db
        .query(
          `INSERT INTO finding_verifications
           (verification_id, fix_id, finding_id, status, requires_fresh_review, evidence_json, recorded_at_utc)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.verificationId,
          input.fixId,
          input.findingId,
          input.status,
          input.requiresFreshReview ? 1 : 0,
          encodeJson(input.evidence),
          recordedAt,
        );
      this.insertEventOutbox({
        reviewId: owner.review_id,
        cycleId: owner.cycle_id,
        eventType: "review.finding_verification_recorded",
        payload: input,
        occurredAtUtc: recordedAt,
      });
    });
  }

  async reconcileArtifacts(): Promise<ReconciliationReport> {
    const committedRows = this.db
      .query(
        "SELECT sha256, relative_path, byte_size FROM raw_artifacts ORDER BY relative_path",
      )
      .all() as ArtifactRow[];
    const committed = new Map(
      committedRows.map((row) => [row.relative_path, row]),
    );
    const issues: ArtifactIssue[] = [];
    const files = await listArtifactFiles(this.rootDir);
    for (const file of files) {
      if (file.temporary) {
        issues.push({
          kind: "TEMPORARY_FILE",
          relativePath: file.relativePath,
        });
        continue;
      }
      const reference = committed.get(file.relativePath);
      if (reference === undefined) {
        issues.push({
          kind: "ORPHAN_FILE",
          relativePath: file.relativePath,
          observedSizeBytes: file.sizeBytes,
        });
        continue;
      }
      try {
        const bytes = new Uint8Array(
          await Bun.file(file.absolutePath).arrayBuffer(),
        );
        if (bytes.byteLength !== reference.byte_size) {
          issues.push({
            kind: "SIZE_MISMATCH",
            relativePath: file.relativePath,
            sha256: reference.sha256,
            expectedSizeBytes: reference.byte_size,
            observedSizeBytes: bytes.byteLength,
          });
        } else if (sha256Hex(bytes) !== reference.sha256) {
          issues.push({
            kind: "HASH_MISMATCH",
            relativePath: file.relativePath,
            sha256: reference.sha256,
            expectedSha256: reference.sha256,
            expectedSizeBytes: reference.byte_size,
            observedSizeBytes: bytes.byteLength,
          });
        }
      } catch {
        issues.push({
          kind: "HASH_MISMATCH",
          relativePath: file.relativePath,
          sha256: reference.sha256,
        });
      }
      committed.delete(file.relativePath);
    }
    for (const reference of committed.values()) {
      issues.push({
        kind: "MISSING_FILE",
        relativePath: reference.relative_path,
        sha256: reference.sha256,
        expectedSha256: reference.sha256,
        expectedSizeBytes: reference.byte_size,
      });
    }
    issues.sort((left, right) =>
      compareOrdinal(left.relativePath, right.relativePath),
    );
    return {
      schemaVersion: this.schemaVersion,
      scannedAtUtc: new Date().toISOString(),
      issues,
    };
  }

  async createBackup(destinationDir: string): Promise<BackupManifest> {
    return createBackupAt(
      this.rootDir,
      this.db,
      destinationDir,
      this.schemaVersion,
    );
  }

  async restoreBackup(
    backupDir: string,
    destinationDir: string,
  ): Promise<SqliteStorage> {
    return restoreStorageBackup(backupDir, destinationDir);
  }

  recordOutboxEvent(
    reviewId: string,
    cycleId: string,
    eventType: string,
    payload: unknown,
    occurredAtUtc?: string,
  ): OutboxRecord {
    validateIdentifier(reviewId, "reviewId");
    validateIdentifier(cycleId, "cycleId");
    const occurredAt = makeUtcTimestamp(occurredAtUtc);
    return this.withImmediateTransaction(() => {
      const eventId = this.insertEventOutbox({
        reviewId,
        cycleId,
        eventType,
        payload,
        occurredAtUtc: occurredAt,
      });
      const row = this.db
        .query(
          `SELECT o.outbox_seq, o.outbox_id, o.event_id, o.event_type, o.payload_json,
                  o.created_at_utc, o.acknowledged_at_utc
           FROM outbox o WHERE o.event_id = ?`,
        )
        .get(eventId) as OutboxSqlRow | null;
      if (row === null)
        throw invariantViolation("Outbox event was not visible after insert.");
      return decodeOutbox(row);
    });
  }

  readOutbox(limit = 100): OutboxRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw invalidArgument("Outbox page size must be between 1 and 1000.");
    }
    const rows = this.db
      .query(
        `SELECT outbox_seq, outbox_id, event_id, event_type, payload_json, created_at_utc, acknowledged_at_utc
         FROM outbox WHERE acknowledged_at_utc IS NULL ORDER BY outbox_seq LIMIT ?`,
      )
      .all(limit) as OutboxSqlRow[];
    return rows.map(decodeOutbox);
  }

  acknowledgeOutbox(
    outboxId: string,
    workerId: string,
    acknowledgedAtUtc?: string,
  ): boolean {
    validateIdentifier(outboxId, "outboxId");
    validateIdentifier(workerId, "workerId");
    const acknowledgedAt = makeUtcTimestamp(acknowledgedAtUtc);
    return this.withImmediateTransaction(() => {
      const result = this.db
        .query(
          `UPDATE outbox SET acknowledged_at_utc = ?, acknowledged_by = ?
           WHERE outbox_id = ? AND acknowledged_at_utc IS NULL`,
        )
        .run(acknowledgedAt, workerId, outboxId);
      return result.changes === 1;
    });
  }

  acquireLease(
    resourceId: string,
    ownerId: string,
    ttlMs: number,
    nowUtc?: string,
  ): LeaseRecord {
    validateIdentifier(resourceId, "resourceId");
    validateIdentifier(ownerId, "ownerId");
    if (
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > 24 * 60 * 60 * 1_000
    ) {
      throw invalidArgument(
        "Lease TTL must be between 1 millisecond and 24 hours.",
      );
    }
    const now = makeUtcTimestamp(nowUtc);
    const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
    return this.withImmediateTransaction(() => {
      const current = this.db
        .query(
          "SELECT owner_id, fencing_token, expires_at_utc FROM leases WHERE resource_id = ?",
        )
        .get(resourceId) as {
        owner_id: string | null;
        fencing_token: number;
        expires_at_utc: string | null;
      } | null;
      if (
        current !== null &&
        current.owner_id !== null &&
        current.expires_at_utc !== null &&
        current.expires_at_utc > now
      ) {
        throw conflict("Lease is already held by an unexpired owner.");
      }
      const previousToken = current?.fencing_token ?? 0;
      if (previousToken >= Number.MAX_SAFE_INTEGER) {
        throw new StorageError(
          "CONFLICT",
          "Lease fencing token limit was reached.",
        );
      }
      const token = previousToken + 1;
      this.db
        .query(
          `INSERT INTO leases (resource_id, owner_id, fencing_token, expires_at_utc, updated_at_utc)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(resource_id) DO UPDATE SET
             owner_id = excluded.owner_id,
             fencing_token = excluded.fencing_token,
             expires_at_utc = excluded.expires_at_utc,
             updated_at_utc = excluded.updated_at_utc`,
        )
        .run(resourceId, ownerId, token, expiresAt, now);
      return {
        resourceId,
        ownerId,
        token,
        expiresAtUtc: expiresAt,
        updatedAtUtc: now,
      };
    });
  }

  renewLease(lease: FencingToken, ttlMs: number, nowUtc?: string): LeaseRecord {
    validateFencingToken(lease);
    if (
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > 24 * 60 * 60 * 1_000
    ) {
      throw invalidArgument(
        "Lease TTL must be between 1 millisecond and 24 hours.",
      );
    }
    const now = makeUtcTimestamp(nowUtc);
    const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
    return this.withImmediateTransaction(() => {
      const current = this.currentLease(lease.resourceId);
      if (
        current === null ||
        current.owner_id !== lease.ownerId ||
        current.fencing_token !== lease.token ||
        current.expires_at_utc === null ||
        current.expires_at_utc <= now
      ) {
        throw conflict("Lease owner or fencing token is stale.");
      }
      this.db
        .query(
          `UPDATE leases SET expires_at_utc = ?, updated_at_utc = ?
           WHERE resource_id = ? AND owner_id = ? AND fencing_token = ?`,
        )
        .run(expiresAt, now, lease.resourceId, lease.ownerId, lease.token);
      return { ...lease, expiresAtUtc: expiresAt, updatedAtUtc: now };
    });
  }

  releaseLease(lease: FencingToken, nowUtc?: string): void {
    validateFencingToken(lease);
    const now = makeUtcTimestamp(nowUtc);
    this.withImmediateTransaction(() => {
      const result = this.db
        .query(
          `UPDATE leases SET owner_id = NULL, expires_at_utc = NULL, updated_at_utc = ?
           WHERE resource_id = ? AND owner_id = ? AND fencing_token = ?`,
        )
        .run(now, lease.resourceId, lease.ownerId, lease.token);
      if (result.changes !== 1)
        throw conflict("Lease owner or fencing token is stale.");
    });
  }

  hasLeaseOwnership(fencing: FencingToken, nowUtc?: string): boolean {
    validateFencingToken(fencing);
    const now = makeUtcTimestamp(nowUtc);
    const current = this.currentLease(fencing.resourceId);
    return (
      current !== null &&
      current.owner_id === fencing.ownerId &&
      current.fencing_token === fencing.token &&
      current.expires_at_utc !== null &&
      current.expires_at_utc > now
    );
  }

  lookupIdempotency(
    input: IdempotencyLookup,
  ): PersistedIdempotencyRecord | undefined {
    validateIdentifier(input.callerId, "callerId");
    validateIdentifier(input.operation, "operation");
    validateIdentifier(input.idempotencyKey, "idempotencyKey");
    const row = this.lookupRow(
      input.callerId,
      input.operation,
      input.idempotencyKey,
    );
    if (row === undefined) return undefined;
    if (
      input.normalizedPayloadHash !== undefined &&
      row.normalized_request_sha256 !== input.normalizedPayloadHash
    ) {
      throw conflict(
        "Idempotency key was reused with a different normalized request.",
      );
    }
    return {
      binding: {
        idempotencyKey: input.idempotencyKey,
        normalizedPayloadHash: row.normalized_request_sha256,
      },
      resultType: row.result_type,
      resultId: row.result_id,
      result: parseJson(row.result_json),
      createdAtUtc: row.created_at_utc,
    };
  }

  private readCycleRow(cycleId: string): CycleRow {
    const row = this.db
      .query("SELECT * FROM review_cycles WHERE cycle_id = ?")
      .get(cycleId) as CycleRow | null;
    if (row === null)
      throw new StorageError("NOT_FOUND", "Review cycle was not found.");
    return row;
  }

  private updateCycleState(
    row: CycleRow,
    state: ReviewCycleState,
    updatedAt: string,
  ): void {
    const objectFormat = state.revisions.objectFormat;
    const result = this.db
      .query(
        `UPDATE review_cycles
         SET object_format = ?, base_sha = ?, head_sha = ?, state = ?, state_version = ?,
             review_context_hash = ?, manifest_hash = ?, version_binding_json = ?, state_json = ?, updated_at_utc = ?
         WHERE cycle_id = ? AND state_version = ?`,
      )
      .run(
        objectFormat,
        state.revisions.baseSha,
        state.revisions.headSha,
        state.state,
        state.stateVersion,
        state.reviewContextHash,
        state.manifestHash,
        encodeJson(state.versionBinding),
        encodeJson(state),
        updatedAt,
        row.cycle_id,
        row.state_version,
      );
    if (result.changes !== 1) {
      throw conflict("Review cycle changed before compare-and-swap completed.");
    }
  }

  private assertFencingToken(
    fencing: FencingToken | undefined,
    now: string,
    expectedResourceId: string,
  ): void {
    if (fencing === undefined) return;
    validateFencingToken(fencing);
    if (fencing.resourceId !== expectedResourceId) {
      throw conflict("Fencing token resource does not match the target cycle.");
    }
    const current = this.currentLease(fencing.resourceId);
    if (
      current === null ||
      current.owner_id !== fencing.ownerId ||
      current.fencing_token !== fencing.token ||
      current.expires_at_utc === null ||
      current.expires_at_utc <= now
    ) {
      throw conflict(
        "Mutation supplied a stale, expired, or non-current fencing token.",
      );
    }
  }

  private assertDaemonFencingToken(
    fencing: FencingToken | undefined,
    now: string,
  ): void {
    if (fencing === undefined) return;
    this.assertFencingToken(
      fencing,
      now,
      daemonOwnershipResourceId(this.rootDir),
    );
  }

  private assertSnapshotManifestRecorded(
    cycleId: string,
    state: ReviewCycleState,
  ): void {
    if (state.manifestHash === null) {
      throw invariantViolation(
        "REVIEWING state must retain a committed snapshot manifest hash.",
      );
    }
    const snapshot = this.db
      .query(
        `SELECT snapshot_id, object_format, base_sha, head_sha,
                manifest_hash, manifest_json
         FROM snapshots
         WHERE cycle_id = ? AND object_format = ? AND base_sha = ? AND head_sha = ?
           AND manifest_hash = ?
         LIMIT 1`,
      )
      .get(
        cycleId,
        state.revisions.objectFormat,
        state.revisions.baseSha,
        state.revisions.headSha,
        state.manifestHash,
      ) as {
      snapshot_id: string;
      object_format: "sha1" | "sha256";
      base_sha: string;
      head_sha: string;
      manifest_hash: string;
      manifest_json: string;
    } | null;
    if (snapshot == null) {
      throw conflict(
        "REVIEWING state requires a stored snapshot with matching pinned revisions and manifest hash.",
      );
    }
    const manifest = parseJson<ProtocolJsonValue>(snapshot.manifest_json);
    let manifestMatchesStorage = false;
    try {
      manifestMatchesStorage =
        canonicalJson(manifest) === snapshot.manifest_json &&
        hashCanonicalJson(manifest) === snapshot.manifest_hash;
    } catch {
      manifestMatchesStorage = false;
    }
    if (!manifestMatchesStorage) {
      throw needsReconciliation(
        "Persisted snapshot manifest is not canonical or does not match its immutable hash.",
      );
    }
    if (!isJsonObject(manifest)) {
      throw needsReconciliation(
        "Persisted snapshot manifest does not match its pinned snapshot identity.",
      );
    }
    if (
      manifest.snapshotId !== snapshot.snapshot_id ||
      manifest.cycleId !== cycleId ||
      manifest.objectFormat !== snapshot.object_format ||
      manifest.baseSha !== snapshot.base_sha ||
      manifest.headSha !== snapshot.head_sha
    ) {
      throw needsReconciliation(
        "Persisted snapshot manifest does not match its pinned snapshot identity.",
      );
    }
    const coverage = manifest.coverage;
    if (!isJsonObject(coverage) || coverage.complete !== true) {
      throw conflict(
        "REVIEWING state requires complete snapshot content coverage.",
      );
    }
  }

  private currentLease(resourceId: string): {
    owner_id: string | null;
    fencing_token: number;
    expires_at_utc: string | null;
  } | null {
    return this.db
      .query(
        "SELECT owner_id, fencing_token, expires_at_utc FROM leases WHERE resource_id = ?",
      )
      .get(resourceId) as {
      owner_id: string | null;
      fencing_token: number;
      expires_at_utc: string | null;
    } | null;
  }

  private insertEventOutbox(input: EventInput): string {
    validateIdentifier(input.eventType, "eventType");
    const payloadJson = encodeJson(input.payload);
    const eventId = randomUUID();
    const eventSeqRow = this.db
      .query(
        "SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq FROM events WHERE cycle_id = ?",
      )
      .get(input.cycleId) as { next_seq: number };
    const outboxSeqRow = this.db
      .query("SELECT COALESCE(MAX(outbox_seq), 0) + 1 AS next_seq FROM outbox")
      .get() as { next_seq: number };
    this.db
      .query(
        `INSERT INTO events
         (event_id, review_id, cycle_id, event_seq, event_type, payload_json, occurred_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        input.reviewId,
        input.cycleId,
        eventSeqRow.next_seq,
        input.eventType,
        payloadJson,
        input.occurredAtUtc,
      );
    this.db
      .query(
        `INSERT INTO outbox
         (outbox_seq, outbox_id, event_id, event_type, payload_json, created_at_utc)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        outboxSeqRow.next_seq,
        randomUUID(),
        eventId,
        input.eventType,
        payloadJson,
        input.occurredAtUtc,
      );
    return eventId;
  }

  private insertSnapshot(
    input: SnapshotInput,
    manifestHash: string,
    createdAt: string,
    artifact?: ArtifactReference,
    pinnedCycle?: CycleRow,
  ): void {
    const cycle = pinnedCycle ?? this.requireSnapshotCycle(input);
    const state = decodeCycle(cycle.state_json);
    this.assertSnapshotCycleMatches(input, cycle);
    this.db
      .query(
        `INSERT INTO snapshots
         (snapshot_id, cycle_id, object_format, base_sha, head_sha, manifest_hash, manifest_json, created_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.snapshotId,
        input.cycleId,
        input.objectFormat,
        input.baseSha,
        input.headSha,
        manifestHash,
        encodeJson(input.manifest),
        createdAt,
      );
    this.insertEventOutbox({
      reviewId: cycle.review_id,
      cycleId: input.cycleId,
      eventType: "snapshot.recorded",
      payload: {
        snapshotId: input.snapshotId,
        manifestHash,
        objectFormat: input.objectFormat,
        baseSha: input.baseSha,
        headSha: input.headSha,
        state: state.state,
        stateVersion: state.stateVersion,
        ...(artifact === undefined ? {} : { artifact }),
      },
      occurredAtUtc: createdAt,
    });
  }

  private requireSnapshotCycle(input: SnapshotInput): CycleRow {
    const cycle = this.readCycleRow(input.cycleId);
    this.assertSnapshotCycleMatches(input, cycle);
    return cycle;
  }

  private assertSnapshotCycleMatches(
    input: SnapshotInput,
    cycle: CycleRow,
  ): void {
    if (
      cycle.object_format !== input.objectFormat ||
      cycle.base_sha !== input.baseSha ||
      cycle.head_sha !== input.headSha
    ) {
      throw conflict(
        "Snapshot revisions do not match the pinned review cycle.",
      );
    }
  }

  private insertArtifactRecord(
    reference: ArtifactReference,
    contentType: string,
    createdAt: string,
  ): void {
    const canonicalPath = artifactRelativePath(reference.sha256);
    if (reference.relativePath !== canonicalPath) {
      throw invariantViolation(
        "Artifact reference is not the owned content-addressed path.",
      );
    }
    this.db
      .query(
        `INSERT INTO raw_artifacts (sha256, relative_path, byte_size, content_type, created_at_utc)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sha256) DO NOTHING`,
      )
      .run(
        reference.sha256,
        reference.relativePath,
        reference.sizeBytes,
        contentType,
        createdAt,
      );
    const stored = this.db
      .query(
        "SELECT relative_path, byte_size FROM raw_artifacts WHERE sha256 = ?",
      )
      .get(reference.sha256) as {
      relative_path: string;
      byte_size: number;
    } | null;
    if (
      stored === null ||
      stored.relative_path !== reference.relativePath ||
      stored.byte_size !== reference.sizeBytes
    ) {
      throw invariantViolation(
        "Existing artifact metadata conflicts with its content hash.",
      );
    }
  }

  private schedulerBackendMetadata(cycleId: string) {
    const binding = this.readSchedulerBackendBinding(cycleId);
    if (binding === undefined) {
      throw invariantViolation(
        "Scheduler event has no immutable backend binding.",
      );
    }
    return {
      backend: binding.backend,
      qualification: binding.qualification,
      backendProtocol: binding.backendProtocol,
      bridgeVersionPin: binding.bridgeVersionPin,
      requestedModel: binding.model,
      requestedReasoningEffort: binding.reasoningEffort,
      configurationDigest: binding.configurationDigest,
    };
  }

  private recordSchedulerAttemptArtifact(
    attemptId: string,
    artifact: NonNullable<
      SchedulerAttemptResultInput["auxiliaryArtifacts"]
    >[number],
    createdAt: string,
  ): void {
    this.insertArtifactRecord(
      artifact.reference,
      schedulerArtifactContentType(artifact.purpose),
      createdAt,
    );
    const existing = this.db
      .query(
        `SELECT artifact_sha256 FROM scheduler_attempt_artifacts
         WHERE attempt_id = ? AND purpose = ?`,
      )
      .get(attemptId, artifact.purpose) as { artifact_sha256: string } | null;
    if (existing !== null) {
      if (existing.artifact_sha256 !== artifact.reference.sha256) {
        throw conflict(
          "Scheduler attempt artifact purpose was recorded with different bytes.",
        );
      }
      return;
    }
    this.db
      .query(
        `INSERT INTO scheduler_attempt_artifacts
         (attempt_id, purpose, artifact_sha256) VALUES (?, ?, ?)`,
      )
      .run(attemptId, artifact.purpose, artifact.reference.sha256);
  }

  private recordSchedulerAttemptReceipt(
    attemptId: string,
    artifact: ArtifactReference | undefined,
  ): void {
    if (artifact === undefined) return;
    const row = this.db
      .query(
        "SELECT backend_receipt_sha256 FROM scheduler_attempts WHERE attempt_id = ?",
      )
      .get(attemptId) as { backend_receipt_sha256: string | null } | null;
    if (row === null) {
      throw invariantViolation("Scheduler receipt has no worker attempt.");
    }
    if (
      row.backend_receipt_sha256 !== null &&
      row.backend_receipt_sha256 !== artifact.sha256
    ) {
      throw conflict(
        "Scheduler attempt receipt changed after it was recorded.",
      );
    }
    if (row.backend_receipt_sha256 === null) {
      this.db
        .query(
          `UPDATE scheduler_attempts SET backend_receipt_sha256 = ?
           WHERE attempt_id = ? AND backend_receipt_sha256 IS NULL`,
        )
        .run(artifact.sha256, attemptId);
    }
  }

  private recordSchedulerAttemptSendState(
    attemptId: string,
    sendState: SchedulerAttemptResultInput["sendState"],
  ): void {
    if (sendState === undefined) return;
    if (!(["UNSENT", "SENT", "UNKNOWN"] as const).includes(sendState)) {
      throw invalidArgument("Scheduler attempt send state is invalid.");
    }
    const row = this.db
      .query(
        "SELECT backend_send_state FROM scheduler_attempts WHERE attempt_id = ?",
      )
      .get(attemptId) as {
      backend_send_state: "UNSENT" | "SENT" | "UNKNOWN" | null;
    } | null;
    if (row === null) {
      throw invariantViolation("Scheduler send state has no worker attempt.");
    }
    if (
      row.backend_send_state !== null &&
      row.backend_send_state !== "UNKNOWN" &&
      sendState !== "UNKNOWN" &&
      row.backend_send_state !== sendState
    ) {
      throw conflict("Scheduler attempt send state changed incompatibly.");
    }
    if (
      row.backend_send_state === null ||
      (row.backend_send_state === "UNKNOWN" && sendState !== "UNKNOWN")
    ) {
      this.db
        .query(
          `UPDATE scheduler_attempts SET backend_send_state = ?
           WHERE attempt_id = ? AND backend_send_state IS ?`,
        )
        .run(sendState, attemptId, row.backend_send_state);
    }
  }

  private insertIdempotencyRecord(input: {
    callerId: string;
    operation: string;
    idempotencyKey: string;
    normalizedPayloadHash: string;
    resultType: string;
    resultId: string;
    result: unknown;
    createdAtUtc: string;
  }): void {
    this.db
      .query(
        `INSERT INTO idempotency_keys
         (caller_id, operation, idempotency_key, normalized_request_sha256, result_type, result_id, result_json, created_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.callerId,
        input.operation,
        input.idempotencyKey,
        input.normalizedPayloadHash,
        input.resultType,
        input.resultId,
        encodeJson(input.result),
        input.createdAtUtc,
      );
  }

  private lookupWithinTransaction(
    callerId: string,
    operation: string,
    idempotencyKey: string,
    normalizedPayloadHash: string,
  ): PersistedIdempotencyRecord | undefined {
    const row = this.lookupRow(callerId, operation, idempotencyKey);
    if (row === undefined) return undefined;
    if (row.normalized_request_sha256 !== normalizedPayloadHash) {
      throw conflict(
        "Idempotency key was reused with a different normalized request; no data was written.",
      );
    }
    return {
      binding: {
        idempotencyKey,
        normalizedPayloadHash: row.normalized_request_sha256,
      },
      resultType: row.result_type,
      resultId: row.result_id,
      result: parseJson(row.result_json),
      createdAtUtc: row.created_at_utc,
    };
  }

  private lookupRow(
    callerId: string,
    operation: string,
    idempotencyKey: string,
  ): IdempotencyRow | undefined {
    const row = this.db
      .query(
        `SELECT normalized_request_sha256, result_type, result_id, result_json, created_at_utc
         FROM idempotency_keys WHERE caller_id = ? AND operation = ? AND idempotency_key = ?`,
      )
      .get(callerId, operation, idempotencyKey) as IdempotencyRow | null;
    return row ?? undefined;
  }

  private schedulerJobRow(runId: string): SchedulerJobRow {
    const row = this.db
      .query(
        `SELECT run_id, review_id, cycle_id, direction, replica_index,
                state, attempt_count, max_attempts, deadline_at_utc,
                active_attempt_id, active_work_kind, lease_owner_id, lease_token,
                lease_expires_at_utc, latest_error_class, next_attempt_at_utc
         FROM scheduler_jobs WHERE run_id = ?`,
      )
      .get(runId) as SchedulerJobRow | null;
    if (row === null) {
      throw new StorageError("NOT_FOUND", "Scheduler job was not found.");
    }
    return row;
  }

  private isCurrentSchedulerClaim(
    job: SchedulerJobRow,
    attemptId: string,
    lease: FencingToken,
    now: string,
  ): boolean {
    if (
      job.state !== "LEASED" ||
      job.active_attempt_id !== attemptId ||
      job.lease_owner_id !== lease.ownerId ||
      job.lease_token !== lease.token ||
      job.lease_expires_at_utc === null ||
      job.lease_expires_at_utc <= now ||
      lease.resourceId !== schedulerLeaseResourceId(job.run_id)
    ) {
      return false;
    }
    const current = this.currentLease(lease.resourceId);
    return (
      current !== null &&
      current.owner_id === lease.ownerId &&
      current.fencing_token === lease.token &&
      current.expires_at_utc !== null &&
      current.expires_at_utc > now
    );
  }

  private clearSchedulerJobLease(
    runId: string,
    attemptId: string,
    lease: FencingToken,
    now: string,
    update: {
      readonly state: SchedulerJobState;
      readonly retryAtUtc?: string;
      readonly latestErrorClass?: string | null;
    },
  ): void {
    const job = this.schedulerJobRow(runId);
    if (!this.isCurrentSchedulerClaim(job, attemptId, lease, now)) {
      throw conflict(
        "Scheduler completion supplied a stale job fencing token.",
      );
    }
    const retryAt =
      update.retryAtUtc === undefined
        ? job.next_attempt_at_utc
        : makeUtcTimestamp(update.retryAtUtc);
    const errorClass =
      update.latestErrorClass === undefined
        ? job.latest_error_class
        : update.latestErrorClass;
    const changed = this.db
      .query(
        `UPDATE scheduler_jobs SET state = ?, next_attempt_at_utc = ?,
         active_attempt_id = NULL, active_work_kind = NULL, lease_owner_id = NULL,
         lease_expires_at_utc = NULL, latest_error_class = ?, updated_at_utc = ?
         WHERE run_id = ? AND state = 'LEASED' AND active_attempt_id = ?
         AND lease_owner_id = ? AND lease_token = ?`,
      )
      .run(
        update.state,
        retryAt,
        errorClass,
        now,
        runId,
        attemptId,
        lease.ownerId,
        lease.token,
      );
    if (changed.changes !== 1) {
      throw conflict("Scheduler job changed before completion was committed.");
    }
    const released = this.db
      .query(
        `UPDATE leases SET owner_id = NULL, expires_at_utc = NULL,
         updated_at_utc = ? WHERE resource_id = ? AND owner_id = ? AND fencing_token = ?`,
      )
      .run(now, lease.resourceId, lease.ownerId, lease.token);
    if (released.changes !== 1) {
      throw conflict("Scheduler lease changed before it could be released.");
    }
  }

  private recordSchedulerRawFindings(
    job: SchedulerJobRow,
    resultId: string,
    findings: readonly WorkerFinding[],
    now: string,
  ): void {
    for (const finding of findings) {
      const rawFindingId = randomUUID();
      this.db
        .query(
          `INSERT INTO raw_findings
           (raw_finding_id, result_id, local_id, payload_json, created_at_utc)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(rawFindingId, resultId, finding.localId, encodeJson(finding), now);
      this.insertEventOutbox({
        reviewId: job.review_id,
        cycleId: job.cycle_id,
        eventType: "finding.raw_recorded",
        payload: {
          ...this.schedulerBackendMetadata(job.cycle_id),
          rawFindingId,
          resultId,
          runId: job.run_id,
          localId: finding.localId,
          provisional: true,
          semanticAdjudication: "NOT_PERFORMED",
        },
        occurredAtUtc: now,
      });
    }
  }

  private assertSchedulerOutput(
    job: SchedulerJobRow,
    attemptId: string,
    output: ProtocolValueBySchema["workerOutput"],
  ): void {
    const row = this.db
      .query(
        `SELECT c.object_format, c.base_sha, c.head_sha, dr.prompt_hash
         FROM direction_runs dr
         JOIN review_cycles c ON c.cycle_id = dr.cycle_id
         WHERE dr.direction_run_id = ? AND c.cycle_id = ?`,
      )
      .get(job.run_id, job.cycle_id) as {
      object_format: "sha1" | "sha256";
      base_sha: string;
      head_sha: string;
      prompt_hash: string;
    } | null;
    if (
      row === null ||
      output.reviewId !== job.review_id ||
      output.cycleId !== job.cycle_id ||
      output.runId !== job.run_id ||
      output.attemptId !== attemptId ||
      output.direction !== job.direction ||
      output.objectFormat !== row.object_format ||
      output.reviewedBaseSha !== row.base_sha ||
      output.reviewedHeadSha !== row.head_sha ||
      output.promptHash !== row.prompt_hash ||
      output.verdict === "INCOMPLETE" ||
      output.coverage.complete !== true ||
      (output.findings.length === 0 && output.verdict !== "NO_FINDINGS") ||
      (output.findings.length > 0 && output.verdict !== "FINDINGS")
    ) {
      throw invalidArgument(
        "Worker output identity or completeness does not match its scheduler job.",
      );
    }
  }

  private recoverExpiredSchedulerLeases(now: string): void {
    const rows = this.db
      .query(
        `SELECT j.run_id, j.review_id, j.cycle_id, j.state, j.active_attempt_id,
                j.active_work_kind, j.lease_owner_id, j.lease_token, c.state AS cycle_state
         FROM scheduler_jobs j
         JOIN review_cycles c ON c.cycle_id = j.cycle_id
         WHERE j.state = 'LEASED' AND j.lease_expires_at_utc <= ?
         ORDER BY j.run_id`,
      )
      .all(now) as Array<{
      run_id: string;
      review_id: string;
      cycle_id: string;
      state: SchedulerJobState;
      active_attempt_id: string;
      active_work_kind: "TURN" | "RECONCILIATION";
      lease_owner_id: string;
      lease_token: number;
      cycle_state: string;
    }>;
    for (const row of rows) {
      const backendMetadata = this.schedulerBackendMetadata(row.cycle_id);
      const cancelled =
        row.cycle_state === "CANCEL_REQUESTED" ||
        row.cycle_state === "CANCELLED";
      const obsolete =
        row.cycle_state === "APPROVED" || row.cycle_state === "FAILED";
      const nextState = cancelled
        ? "CANCELLED"
        : obsolete
          ? "OBSOLETE"
          : "RECONCILIATION_REQUIRED";
      const attemptState = cancelled
        ? "CANCELLED"
        : obsolete
          ? "OBSOLETE"
          : row.active_work_kind === "TURN"
            ? "UNKNOWN_SEND"
            : "RECONCILIATION_UNKNOWN";
      this.db
        .query(
          `UPDATE scheduler_attempts SET state = ?, error_class = ?,
           reconciliation_outcome = CASE WHEN ? = 'RECONCILIATION_UNKNOWN'
             THEN 'STILL_UNKNOWN' ELSE reconciliation_outcome END,
           finished_at_utc = ? WHERE attempt_id = ? AND state IN (
             'RUNNING', 'UNKNOWN_SEND', 'RECONCILIATION_UNKNOWN'
           )`,
        )
        .run(
          attemptState,
          nextState === "RECONCILIATION_REQUIRED" ? "LEASE_EXPIRED" : null,
          attemptState,
          now,
          row.active_attempt_id,
        );
      if (row.active_work_kind === "TURN") {
        this.recordSchedulerAttemptSendState(row.active_attempt_id, "UNKNOWN");
      }
      this.db
        .query(
          `UPDATE scheduler_jobs SET state = ?, active_attempt_id = NULL,
           active_work_kind = NULL, lease_owner_id = NULL, lease_expires_at_utc = NULL,
           latest_error_class = ?, updated_at_utc = ? WHERE run_id = ? AND state = 'LEASED'`,
        )
        .run(
          nextState,
          nextState === "RECONCILIATION_REQUIRED" ? "LEASE_EXPIRED" : null,
          now,
          row.run_id,
        );
      this.db
        .query(
          `UPDATE leases SET owner_id = NULL, expires_at_utc = NULL,
           updated_at_utc = ? WHERE resource_id = ? AND owner_id = ? AND fencing_token = ?`,
        )
        .run(
          now,
          schedulerLeaseResourceId(row.run_id),
          row.lease_owner_id,
          row.lease_token,
        );
      this.insertEventOutbox({
        reviewId: row.review_id,
        cycleId: row.cycle_id,
        eventType:
          nextState === "RECONCILIATION_REQUIRED"
            ? "scheduler.lease_expired_unknown_send"
            : "scheduler.lease_expired_obsolete",
        payload: {
          ...backendMetadata,
          runId: row.run_id,
          attemptId: row.active_attempt_id,
          previousWorkKind: row.active_work_kind,
          state: nextState,
          automaticRetry: false,
        },
        occurredAtUtc: now,
      });
    }
  }

  private failExpiredQueuedSchedulerJobs(now: string): void {
    const rows = this.db
      .query(
        `SELECT j.run_id, j.review_id, j.cycle_id, j.direction, dr.status
         FROM scheduler_jobs j
         JOIN direction_runs dr ON dr.direction_run_id = j.run_id
         JOIN review_cycles c ON c.cycle_id = j.cycle_id
         WHERE c.state = 'REVIEWING' AND j.state IN ('QUEUED', 'RETRY_WAIT')
           AND j.deadline_at_utc <= ?
         ORDER BY j.run_id`,
      )
      .all(now) as Array<{
      run_id: string;
      review_id: string;
      cycle_id: string;
      direction: string;
      status: DirectionRunStatus;
    }>;
    for (const row of rows) {
      const backendMetadata = this.schedulerBackendMetadata(row.cycle_id);
      this.db
        .query(
          `UPDATE scheduler_jobs SET state = 'FAILED',
           latest_error_class = 'DEADLINE_EXCEEDED', updated_at_utc = ?
           WHERE run_id = ? AND state IN ('QUEUED', 'RETRY_WAIT')`,
        )
        .run(now, row.run_id);
      if (row.status === "PENDING" || row.status === "RUNNING") {
        this.db
          .query(
            `UPDATE direction_runs SET status = 'FAILED'
             WHERE direction_run_id = ?`,
          )
          .run(row.run_id);
        this.insertEventOutbox({
          reviewId: row.review_id,
          cycleId: row.cycle_id,
          eventType: "direction_run.status_changed",
          payload: {
            ...backendMetadata,
            directionRunId: row.run_id,
            direction: row.direction,
            previousStatus: row.status,
            status: "FAILED",
            errorClass: "DEADLINE_EXCEEDED",
          },
          occurredAtUtc: now,
        });
      }
      this.insertEventOutbox({
        reviewId: row.review_id,
        cycleId: row.cycle_id,
        eventType: "scheduler.run_failed",
        payload: {
          ...backendMetadata,
          runId: row.run_id,
          errorClass: "DEADLINE_EXCEEDED",
          jobState: "FAILED",
        },
        occurredAtUtc: now,
      });
    }
  }

  private failSchedulerJobWithinTransaction(
    runId: string,
    errorClass: string,
    now: string,
  ): void {
    const job = this.schedulerJobRow(runId);
    const backendMetadata = this.schedulerBackendMetadata(job.cycle_id);
    if (
      job.state === "COMPLETE" ||
      job.state === "FAILED" ||
      job.state === "CANCELLED" ||
      job.state === "OBSOLETE"
    ) {
      return;
    }
    if (job.lease_owner_id !== null) {
      this.db
        .query(
          `UPDATE leases SET owner_id = NULL, expires_at_utc = NULL,
           updated_at_utc = ? WHERE resource_id = ? AND owner_id = ? AND fencing_token = ?`,
        )
        .run(
          now,
          schedulerLeaseResourceId(runId),
          job.lease_owner_id,
          job.lease_token,
        );
    }
    if (job.active_attempt_id !== null) {
      if (job.active_work_kind === "TURN") {
        this.recordSchedulerAttemptSendState(job.active_attempt_id, "UNKNOWN");
      }
      this.db
        .query(
          `UPDATE scheduler_attempts SET state = 'PERMANENT_FAILURE',
           error_class = ?, finished_at_utc = ? WHERE attempt_id = ?
           AND state IN ('RUNNING', 'UNKNOWN_SEND', 'RECONCILIATION_UNKNOWN')`,
        )
        .run(errorClass, now, job.active_attempt_id);
    }
    this.db
      .query(
        `UPDATE scheduler_jobs SET state = 'FAILED', active_attempt_id = NULL,
         active_work_kind = NULL, lease_owner_id = NULL, lease_expires_at_utc = NULL,
         latest_error_class = ?, updated_at_utc = ? WHERE run_id = ?`,
      )
      .run(errorClass, now, runId);
    this.db
      .query(
        `UPDATE direction_runs SET status = 'FAILED'
         WHERE direction_run_id = ? AND status IN ('PENDING', 'RUNNING')`,
      )
      .run(runId);
    this.insertEventOutbox({
      reviewId: job.review_id,
      cycleId: job.cycle_id,
      eventType: "scheduler.run_failed",
      payload: {
        ...backendMetadata,
        runId,
        errorClass,
        jobState: "FAILED",
      },
      occurredAtUtc: now,
    });
  }

  private reviewIdForCycle(cycleId: string): string {
    const row = this.db
      .query("SELECT review_id FROM review_cycles WHERE cycle_id = ?")
      .get(cycleId) as { review_id: string } | null;
    if (row === null)
      throw new StorageError("NOT_FOUND", "Review cycle was not found.");
    return row.review_id;
  }

  private withImmediateTransaction<T>(operation: () => T): T {
    const transaction = this.db.transaction(operation);
    try {
      return transaction.immediate();
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  private async withAsyncImmediateTransaction<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const result = await operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.inTransaction) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // The original operation error is authoritative if rollback also fails.
        }
      }
      throw mapStorageError(error);
    }
  }
}

interface OutboxSqlRow {
  outbox_seq: number;
  outbox_id: string;
  event_id: string;
  event_type: string;
  payload_json: string;
  created_at_utc: string;
  acknowledged_at_utc: string | null;
}

export async function openStorage(
  options: OpenStorageOptions,
): Promise<SqliteStorage> {
  return SqliteStorage.open(options);
}

export async function restoreStorageBackup(
  backupDir: string,
  destinationDir: string,
): Promise<SqliteStorage> {
  const backup = await verifyBackupAt(backupDir);
  const sourceRoot = path.resolve(backupDir);
  const destination = await ensureEmptyOwnedDirectory(destinationDir);
  const databaseBytes = new Uint8Array(
    await Bun.file(path.join(sourceRoot, DATABASE_NAME)).arrayBuffer(),
  );
  if (
    databaseBytes.byteLength !== backup.database.sizeBytes ||
    sha256Hex(databaseBytes) !== backup.database.sha256
  ) {
    throw needsReconciliation(
      "Backup database changed after verification began.",
    );
  }
  await writeAtomicFile(destination, DATABASE_NAME, databaseBytes);
  await ensurePrivateChildDirectory(destination, "artifacts/sha256");
  for (const reference of backup.artifacts) {
    const bytes = await readVerifiedArtifact(sourceRoot, reference);
    const restored = await persistArtifactFile(destination, bytes);
    if (
      restored.sha256 !== reference.sha256 ||
      restored.sizeBytes !== reference.sizeBytes ||
      restored.relativePath !== reference.relativePath
    ) {
      throw needsReconciliation(
        "Restored artifact differs from its immutable backup identity.",
      );
    }
  }
  const storage = await openStorage({ rootDir: destination });
  try {
    const report = await storage.reconcileArtifacts();
    if (report.issues.length > 0) {
      throw needsReconciliation(
        "Restored store contains unresolved artifact reconciliation issues.",
      );
    }
    const integrity = storage.integrityCheck();
    if (integrity.integrity !== "ok" || integrity.foreignKeyViolations > 0) {
      throw needsReconciliation(
        "Restored SQLite state failed integrity verification.",
      );
    }
    return storage;
  } catch (error) {
    try {
      storage.close();
    } catch {
      // Preserve the restoration error if closing also fails.
    }
    throw error;
  }
}

function insertCycle(
  db: Database,
  reviewId: string,
  cycle: ReviewCycleState,
  now: string,
): void {
  db.query(
    `INSERT INTO review_cycles
       (cycle_id, review_id, parent_cycle_id, cycle_number, repo_id, object_format, base_sha, head_sha,
        state, state_version, review_context_hash, manifest_hash, version_binding_json, state_json,
        created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    cycle.cycleId,
    reviewId,
    cycle.parentCycleId,
    cycle.cycleNumber,
    cycle.repoId,
    cycle.revisions.objectFormat,
    cycle.revisions.baseSha,
    cycle.revisions.headSha,
    cycle.state,
    cycle.stateVersion,
    cycle.reviewContextHash,
    cycle.manifestHash,
    encodeJson(cycle.versionBinding),
    encodeJson(cycle),
    now,
    now,
  );
}

function assertCycleIdentity(row: CycleRow, next: ReviewCycleState): void {
  const current = decodeCycle(row.state_json);
  if (
    next.cycleId !== current.cycleId ||
    next.parentCycleId !== current.parentCycleId ||
    next.cycleNumber !== current.cycleNumber ||
    next.repoId !== current.repoId ||
    canonicalJson(next.revisions) !== canonicalJson(current.revisions) ||
    next.reviewContextHash !== current.reviewContextHash ||
    canonicalJson(next.versionBinding) !== canonicalJson(current.versionBinding)
  ) {
    throw invariantViolation(
      "Cycle transition attempted to change immutable cycle identity or bindings.",
    );
  }
}

function decodeCycle(json: string): ReviewCycleState {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw needsReconciliation("Persisted review cycle JSON is malformed.");
  }
  const validation = validateProtocolValue("reviewCycleState", value);
  if (!validation.ok)
    throw needsReconciliation(
      "Persisted review cycle failed NR-03 schema validation.",
    );
  return validation.value;
}

function decodeOutbox(row: OutboxSqlRow): OutboxRecord {
  return {
    outboxSeq: row.outbox_seq,
    outboxId: row.outbox_id,
    eventId: row.event_id,
    eventType: row.event_type,
    payload: parseJson(row.payload_json),
    createdAtUtc: row.created_at_utc,
    acknowledgedAtUtc: row.acknowledged_at_utc,
  };
}

function requireValidSubmission(value: ReviewSubmitInput): ReviewSubmitInput {
  const validation = validateProtocolValue("reviewSubmitInput", value);
  if (!validation.ok)
    throw invalidArgument(
      "Review submission does not satisfy the NR-03 protocol schema.",
    );
  return validation.value;
}

function requireVersionBinding(value: VersionHashBinding): VersionHashBinding {
  const validation = validateProtocolValue("versionHashBinding", value);
  if (!validation.ok)
    throw invalidArgument(
      "Version/hash binding does not satisfy the NR-03 protocol schema.",
    );
  return validation.value;
}

function submissionPayload(submission: ReviewSubmitInput): unknown {
  return {
    repoId: submission.repoId,
    task: submission.task,
    acceptanceCriteria: submission.acceptanceCriteria,
    profile: submission.profile,
    objectFormat: submission.objectFormat,
    baseSha: submission.baseSha,
    headSha: submission.headSha,
  };
}

function requireIdempotencyBinding(
  idempotencyKey: string,
  payload: unknown,
): {
  idempotencyKey: string;
  normalizedPayloadHash: string;
} {
  const result = createIdempotencyBinding(idempotencyKey, payload, "storage");
  if (!result.ok) throw invalidArgument(result.error.message);
  return result.binding;
}

function validateSnapshotInput(input: SnapshotInput): {
  manifestHash: string;
  createdAt: string;
} {
  validateIdentifier(input.snapshotId, "snapshotId");
  validateIdentifier(input.cycleId, "cycleId");
  const oidLength = input.objectFormat === "sha1" ? 40 : 64;
  const oidPattern = new RegExp(`^[0-9a-f]{${oidLength}}$`);
  if (
    (input.objectFormat !== "sha1" && input.objectFormat !== "sha256") ||
    !oidPattern.test(input.baseSha) ||
    !oidPattern.test(input.headSha)
  ) {
    throw invalidArgument(
      "Snapshot revisions must be full object IDs in the declared format.",
    );
  }
  const manifestHash = requireSha256(input.manifestHash, "manifestHash");
  if (manifestHash !== hashCanonicalJson(input.manifest)) {
    throw invalidArgument(
      "Snapshot manifest hash does not match its canonical JSON.",
    );
  }
  return { manifestHash, createdAt: makeUtcTimestamp(input.createdAtUtc) };
}

function snapshotArtifactReference(
  manifest: ProtocolJsonValue,
): ArtifactReference {
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    throw invalidArgument(
      "Snapshot manifest must contain an artifact reference.",
    );
  }
  const artifact = (manifest as { readonly [key: string]: ProtocolJsonValue })
    .snapshotArtifact;
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    Array.isArray(artifact)
  ) {
    throw invalidArgument(
      "Snapshot manifest must contain an artifact reference.",
    );
  }
  const { sha256, sizeBytes, relativePath } = artifact as {
    readonly [key: string]: ProtocolJsonValue;
  };
  if (
    typeof sha256 !== "string" ||
    typeof sizeBytes !== "number" ||
    typeof relativePath !== "string"
  ) {
    throw invalidArgument("Snapshot manifest artifact reference is malformed.");
  }
  return { sha256, sizeBytes, relativePath };
}

function validateIdentifier(value: string, name: string): void {
  if (!ID_PATTERN.test(value))
    throw invalidArgument(`${name} is not a valid protocol identifier.`);
}

function requireSha256(value: string, name: string): string {
  if (!HASH_PATTERN.test(value))
    throw invalidArgument(`${name} must be a lowercase SHA-256 digest.`);
  return value;
}

function requireArtifactReference(value: ArtifactReference): ArtifactReference {
  if (typeof value !== "object" || value === null) {
    throw invalidArgument(
      "Worker result requires a persisted artifact reference.",
    );
  }
  const sha256 = requireSha256(value.sha256, "rawArtifact.sha256");
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0) {
    throw invalidArgument(
      "Raw artifact size must be a non-negative safe integer.",
    );
  }
  const relativePath = artifactRelativePath(sha256);
  if (value.relativePath !== relativePath) {
    throw invalidArgument("Raw artifact path must match its content address.");
  }
  return { sha256, sizeBytes: value.sizeBytes, relativePath };
}

function requireGitSha(
  value: string,
  objectFormat: "sha1" | "sha256",
  name: string,
): string {
  const expectedLength = objectFormat === "sha1" ? 40 : 64;
  if (
    typeof value !== "string" ||
    value.length !== expectedLength ||
    !/^[0-9a-f]+$/.test(value)
  ) {
    throw invalidArgument(
      `${name} must be a full lowercase ${objectFormat} Git object ID.`,
    );
  }
  return value;
}

function fixTransitionKey(callerId: string, idempotencyKey: string): string {
  const scopeHash = sha256Hex(
    new TextEncoder().encode(`${callerId}\u0000${idempotencyKey}`),
  );
  return `fix-${scopeHash}`;
}

function validateExpectedVersion(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= Number.MAX_SAFE_INTEGER
  ) {
    throw invalidArgument(
      "expectedVersion must be a non-negative safe integer below the version limit.",
    );
  }
}

function validateFencingToken(value: FencingToken): void {
  validateIdentifier(value.resourceId, "resourceId");
  validateIdentifier(value.ownerId, "ownerId");
  if (!Number.isSafeInteger(value.token) || value.token < 1) {
    throw invalidArgument("Fencing token must be a positive safe integer.");
  }
}

function encodeJson(value: unknown): string {
  try {
    return canonicalJson(value as ProtocolJsonValue);
  } catch {
    throw invalidArgument(
      "Value is outside the NR-03 canonical JSON data model.",
    );
  }
}

function parseJson<T = unknown>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    throw needsReconciliation("Persisted JSON value is malformed.");
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapProtocolTransitionError(code: string): StorageError {
  switch (code) {
    case "CONFLICT":
      return conflict(
        "NR-03 rejected the requested cycle command as a conflict.",
      );
    case "INVALID_ARGUMENT":
    case "SCHEMA_INVALID":
      return invalidArgument("NR-03 rejected the requested cycle command.");
    case "NEEDS_RECONCILIATION":
      return needsReconciliation(
        "NR-03 requires cycle reconciliation before this command.",
      );
    case "RESOURCE_EXHAUSTED":
      return new StorageError("CONFLICT", "NR-03 cycle limit was reached.");
    default:
      return new StorageError(
        "INVARIANT_VIOLATION",
        "NR-03 rejected the requested cycle command.",
      );
  }
}

function mapStorageError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("busy") || message.includes("locked")) {
      return new StorageError(
        "CONFLICT",
        "SQLite writer is busy; retry the operation.",
        {
          cause: error,
          retryable: true,
        },
      );
    }
    if (message.includes("unique constraint")) {
      return new StorageError(
        "CONFLICT",
        "A storage identity already exists.",
        { cause: error },
      );
    }
    if (
      message.includes("constraint failed") ||
      message.includes("foreign key constraint") ||
      message.includes("check constraint")
    ) {
      return new StorageError(
        "INVARIANT_VIOLATION",
        "SQLite rejected a violated storage invariant.",
        {
          cause: error,
        },
      );
    }
  }
  return new StorageError("IO_ERROR", "SQLite storage operation failed.", {
    cause: error,
  });
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
