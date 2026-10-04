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
  type ReviewCycleState,
  type ReviewSubmitInput,
  type ReviewTransitionCommand,
  transitionReviewCycle,
  type VersionHashBinding,
  validateProtocolValue,
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
  CanonicalFindingInput,
  CanonicalFindingRecord,
  CreatedReview,
  CreateReviewInput,
  DirectionRunBinding,
  DirectionRunInput,
  DirectionRunStatus,
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

export function daemonOwnershipResourceId(storageRootDir: string): string {
  const canonicalRoot = path.resolve(storageRootDir);
  const digest = createHash("sha256").update(canonicalRoot).digest("hex");
  return `daemon:${digest}`;
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
      const eventPayload = { command, state: transition.state };
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
    return this.withAsyncImmediateTransaction(async () =>
      persistArtifactFile(this.rootDir, bytes),
    );
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
