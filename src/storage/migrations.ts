import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { StorageError } from "./errors";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const migrationOneSql = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at_utc TEXT NOT NULL
);

CREATE TABLE reviews (
  review_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  task TEXT NOT NULL,
  acceptance_criteria_json TEXT NOT NULL,
  profile TEXT NOT NULL CHECK (profile = 'strict/1'),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE review_cycles (
  cycle_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(review_id),
  parent_cycle_id TEXT REFERENCES review_cycles(cycle_id),
  cycle_number INTEGER NOT NULL CHECK (cycle_number > 0),
  repo_id TEXT NOT NULL,
  object_format TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'QUEUED', 'SNAPSHOTTING', 'REVIEWING', 'AGGREGATING', 'NEEDS_FIX',
    'VERIFYING_FIX', 'PAUSED', 'REQUIRES_FRESH_REVIEW', 'CANCEL_REQUESTED',
    'APPROVED', 'FAILED', 'CANCELLED'
  )),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  review_context_hash TEXT NOT NULL CHECK (
    length(review_context_hash) = 64 AND review_context_hash NOT GLOB '*[^0-9a-f]*'
  ),
  manifest_hash TEXT CHECK (
    manifest_hash IS NULL OR
    (length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*')
  ),
  version_binding_json TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  UNIQUE (review_id, cycle_number),
  CHECK (length(base_sha) IN (40, 64)),
  CHECK (length(head_sha) IN (40, 64)),
  CHECK (base_sha NOT GLOB '*[^0-9a-f]*'),
  CHECK (head_sha NOT GLOB '*[^0-9a-f]*'),
  CHECK ((object_format = 'sha1' AND length(base_sha) = 40 AND length(head_sha) = 40)
      OR (object_format = 'sha256' AND length(base_sha) = 64 AND length(head_sha) = 64))
);

CREATE INDEX review_cycles_by_review ON review_cycles(review_id, cycle_number DESC);

CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(review_id),
  cycle_id TEXT NOT NULL REFERENCES review_cycles(cycle_id),
  event_seq INTEGER NOT NULL CHECK (event_seq > 0),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at_utc TEXT NOT NULL,
  UNIQUE (cycle_id, event_seq)
);

CREATE TABLE outbox (
  outbox_seq INTEGER NOT NULL UNIQUE CHECK (outbox_seq > 0),
  outbox_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  acknowledged_at_utc TEXT,
  acknowledged_by TEXT
);

CREATE INDEX outbox_unacknowledged ON outbox(created_at_utc, outbox_id)
  WHERE acknowledged_at_utc IS NULL;

CREATE TABLE idempotency_keys (
  caller_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  normalized_request_sha256 TEXT NOT NULL CHECK (
    length(normalized_request_sha256) = 64 AND
    normalized_request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  result_type TEXT NOT NULL,
  result_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  PRIMARY KEY (caller_id, operation, idempotency_key)
);
`;

const migrationTwoSql = `
CREATE TABLE snapshots (
  snapshot_id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES review_cycles(cycle_id),
  object_format TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK (
    length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*'
  ),
  manifest_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  UNIQUE (cycle_id, manifest_hash)
);

CREATE TABLE raw_artifacts (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  relative_path TEXT NOT NULL UNIQUE CHECK (relative_path NOT LIKE '/%' AND instr(relative_path, '..') = 0),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 1 AND 255),
  created_at_utc TEXT NOT NULL
);

CREATE TABLE direction_runs (
  direction_run_id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES review_cycles(cycle_id),
  direction TEXT NOT NULL CHECK (direction IN ('correctness', 'tests', 'design')),
  role TEXT NOT NULL CHECK (role IN ('reviewer', 'adjudicator', 'fix_verifier')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETE', 'FAILED', 'OBSOLETE')),
  prompt_hash TEXT NOT NULL CHECK (
    length(prompt_hash) = 64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'
  ),
  schema_hash TEXT NOT NULL CHECK (
    length(schema_hash) = 64 AND schema_hash NOT GLOB '*[^0-9a-f]*'
  ),
  policy_hash TEXT NOT NULL CHECK (
    length(policy_hash) = 64 AND policy_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_utc TEXT NOT NULL,
  UNIQUE (cycle_id, direction_run_id)
);

CREATE TABLE worker_attempts (
  attempt_id TEXT PRIMARY KEY,
  direction_run_id TEXT NOT NULL REFERENCES direction_runs(direction_run_id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  model TEXT,
  effort TEXT,
  started_at_utc TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  UNIQUE (direction_run_id, attempt_number),
  UNIQUE (direction_run_id, attempt_id)
);

CREATE TABLE worker_attempt_results (
  result_id TEXT PRIMARY KEY,
  direction_run_id TEXT NOT NULL REFERENCES direction_runs(direction_run_id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES worker_attempts(attempt_id),
  raw_artifact_sha256 TEXT NOT NULL REFERENCES raw_artifacts(sha256),
  disposition TEXT NOT NULL CHECK (disposition IN ('VALID', 'MALFORMED', 'REJECTED', 'OBSOLETE', 'FAILED')),
  parsed_result_json TEXT,
  selected INTEGER NOT NULL CHECK (selected IN (0, 1)),
  recorded_at_utc TEXT NOT NULL,
  CHECK (selected = 0 OR disposition = 'VALID'),
  FOREIGN KEY (direction_run_id, attempt_id)
    REFERENCES worker_attempts(direction_run_id, attempt_id)
);

CREATE UNIQUE INDEX one_selected_result_per_direction
  ON worker_attempt_results(direction_run_id) WHERE selected = 1;

CREATE TABLE raw_findings (
  raw_finding_id TEXT PRIMARY KEY,
  result_id TEXT NOT NULL REFERENCES worker_attempt_results(result_id),
  local_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  UNIQUE (result_id, local_id)
);

CREATE TABLE canonical_findings (
  finding_id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES review_cycles(cycle_id),
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  validation TEXT NOT NULL CHECK (validation IN ('CONFIRMED', 'REJECTED', 'UNCERTAIN')),
  blocking INTEGER NOT NULL CHECK (blocking IN (0, 1)),
  payload_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  UNIQUE (cycle_id, finding_id)
);

CREATE TABLE finding_sources (
  finding_id TEXT NOT NULL REFERENCES canonical_findings(finding_id),
  raw_finding_id TEXT NOT NULL REFERENCES raw_findings(raw_finding_id),
  direction_run_id TEXT NOT NULL REFERENCES direction_runs(direction_run_id),
  attempt_id TEXT NOT NULL REFERENCES worker_attempts(attempt_id),
  source_local_id TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  PRIMARY KEY (finding_id, raw_finding_id)
);

CREATE TABLE adjudication_decisions (
  decision_id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES review_cycles(cycle_id),
  finding_id TEXT NOT NULL REFERENCES canonical_findings(finding_id),
  outcome TEXT NOT NULL CHECK (outcome IN ('CONFIRMED', 'REJECTED', 'UNCERTAIN')),
  rationale TEXT NOT NULL,
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_utc TEXT NOT NULL
);

CREATE TABLE fix_submissions (
  fix_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(review_id),
  cycle_id TEXT NOT NULL REFERENCES review_cycles(cycle_id),
  previous_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  resolutions_json TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  normalized_request_sha256 TEXT NOT NULL CHECK (
    length(normalized_request_sha256) = 64 AND
    normalized_request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  submitted_at_utc TEXT NOT NULL,
  UNIQUE (caller_id, operation, idempotency_key),
  CHECK (length(previous_sha) IN (40, 64)),
  CHECK (length(head_sha) = length(previous_sha)),
  CHECK (previous_sha NOT GLOB '*[^0-9a-f]*'),
  CHECK (head_sha NOT GLOB '*[^0-9a-f]*')
);

CREATE TABLE finding_verifications (
  verification_id TEXT PRIMARY KEY,
  fix_id TEXT NOT NULL REFERENCES fix_submissions(fix_id),
  finding_id TEXT NOT NULL REFERENCES canonical_findings(finding_id),
  status TEXT NOT NULL CHECK (status IN ('FIXED', 'NOT_FIXED', 'REGRESSION', 'UNCERTAIN')),
  requires_fresh_review INTEGER NOT NULL CHECK (requires_fresh_review IN (0, 1)),
  evidence_json TEXT NOT NULL,
  recorded_at_utc TEXT NOT NULL,
  UNIQUE (fix_id, finding_id)
);

CREATE TABLE leases (
  resource_id TEXT PRIMARY KEY,
  owner_id TEXT,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  expires_at_utc TEXT,
  updated_at_utc TEXT NOT NULL,
  CHECK ((owner_id IS NULL AND expires_at_utc IS NULL) OR (owner_id IS NOT NULL AND expires_at_utc IS NOT NULL))
);

CREATE TRIGGER raw_artifacts_no_update BEFORE UPDATE ON raw_artifacts
BEGIN SELECT RAISE(ABORT, 'raw artifacts are immutable'); END;
CREATE TRIGGER raw_artifacts_no_delete BEFORE DELETE ON raw_artifacts
BEGIN SELECT RAISE(ABORT, 'raw artifacts are immutable'); END;
CREATE TRIGGER snapshots_no_update BEFORE UPDATE ON snapshots
BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;
CREATE TRIGGER snapshots_no_delete BEFORE DELETE ON snapshots
BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;
CREATE TRIGGER direction_runs_no_delete BEFORE DELETE ON direction_runs
BEGIN SELECT RAISE(ABORT, 'direction runs are append-only'); END;
CREATE TRIGGER direction_runs_update_guard BEFORE UPDATE ON direction_runs
WHEN
  NEW.direction_run_id <> OLD.direction_run_id OR
  NEW.cycle_id <> OLD.cycle_id OR
  NEW.direction <> OLD.direction OR
  NEW.role <> OLD.role OR
  NEW.prompt_hash <> OLD.prompt_hash OR
  NEW.schema_hash <> OLD.schema_hash OR
  NEW.policy_hash <> OLD.policy_hash OR
  NEW.created_at_utc <> OLD.created_at_utc OR
  NOT (
    (OLD.status = 'PENDING' AND NEW.status IN ('RUNNING', 'FAILED', 'OBSOLETE')) OR
    (OLD.status = 'RUNNING' AND NEW.status IN ('COMPLETE', 'FAILED', 'OBSOLETE'))
  )
BEGIN SELECT RAISE(ABORT, 'invalid direction run status transition'); END;
CREATE TRIGGER worker_attempts_no_update BEFORE UPDATE ON worker_attempts
BEGIN SELECT RAISE(ABORT, 'worker attempts are append-only'); END;
CREATE TRIGGER worker_attempts_no_delete BEFORE DELETE ON worker_attempts
BEGIN SELECT RAISE(ABORT, 'worker attempts are append-only'); END;
CREATE TRIGGER worker_attempt_results_no_update BEFORE UPDATE ON worker_attempt_results
BEGIN SELECT RAISE(ABORT, 'worker attempt results are append-only'); END;
CREATE TRIGGER worker_attempt_results_no_delete BEFORE DELETE ON worker_attempt_results
BEGIN SELECT RAISE(ABORT, 'worker attempt results are append-only'); END;
CREATE TRIGGER raw_findings_no_update BEFORE UPDATE ON raw_findings
BEGIN SELECT RAISE(ABORT, 'raw findings are append-only'); END;
CREATE TRIGGER raw_findings_no_delete BEFORE DELETE ON raw_findings
BEGIN SELECT RAISE(ABORT, 'raw findings are append-only'); END;
CREATE TRIGGER canonical_findings_no_update BEFORE UPDATE ON canonical_findings
BEGIN SELECT RAISE(ABORT, 'canonical findings are append-only'); END;
CREATE TRIGGER canonical_findings_no_delete BEFORE DELETE ON canonical_findings
BEGIN SELECT RAISE(ABORT, 'canonical findings are append-only'); END;
CREATE TRIGGER finding_sources_no_update BEFORE UPDATE ON finding_sources
BEGIN SELECT RAISE(ABORT, 'finding sources are append-only'); END;
CREATE TRIGGER finding_sources_no_delete BEFORE DELETE ON finding_sources
BEGIN SELECT RAISE(ABORT, 'finding sources are append-only'); END;
CREATE TRIGGER adjudication_decisions_no_update BEFORE UPDATE ON adjudication_decisions
BEGIN SELECT RAISE(ABORT, 'adjudication decisions are append-only'); END;
CREATE TRIGGER adjudication_decisions_no_delete BEFORE DELETE ON adjudication_decisions
BEGIN SELECT RAISE(ABORT, 'adjudication decisions are append-only'); END;
CREATE TRIGGER fix_submissions_no_update BEFORE UPDATE ON fix_submissions
BEGIN SELECT RAISE(ABORT, 'fix submissions are append-only'); END;
CREATE TRIGGER fix_submissions_no_delete BEFORE DELETE ON fix_submissions
BEGIN SELECT RAISE(ABORT, 'fix submissions are append-only'); END;
CREATE TRIGGER finding_verifications_no_update BEFORE UPDATE ON finding_verifications
BEGIN SELECT RAISE(ABORT, 'finding verifications are append-only'); END;
CREATE TRIGGER finding_verifications_no_delete BEFORE DELETE ON finding_verifications
BEGIN SELECT RAISE(ABORT, 'finding verifications are append-only'); END;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER idempotency_keys_no_update BEFORE UPDATE ON idempotency_keys
BEGIN SELECT RAISE(ABORT, 'idempotency records are immutable'); END;
CREATE TRIGGER idempotency_keys_no_delete BEFORE DELETE ON idempotency_keys
BEGIN SELECT RAISE(ABORT, 'idempotency records are immutable'); END;
CREATE TRIGGER schema_migrations_no_update BEFORE UPDATE ON schema_migrations
BEGIN SELECT RAISE(ABORT, 'migration records are immutable'); END;
CREATE TRIGGER schema_migrations_no_delete BEFORE DELETE ON schema_migrations
BEGIN SELECT RAISE(ABORT, 'migration records are immutable'); END;
`;

const migrationThreeSql = `
CREATE TABLE scheduler_control (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  last_review_id TEXT
);
INSERT INTO scheduler_control (singleton_id, last_review_id) VALUES (1, NULL);

CREATE TABLE scheduler_jobs (
  run_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(review_id),
  cycle_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('correctness', 'tests', 'design')),
  replica_index INTEGER NOT NULL CHECK (replica_index BETWEEN 1 AND 3),
  state TEXT NOT NULL CHECK (state IN (
    'QUEUED', 'LEASED', 'RETRY_WAIT', 'RECONCILIATION_REQUIRED',
    'COMPLETE', 'FAILED', 'CANCELLED', 'OBSOLETE'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  reconciliation_count INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_count BETWEEN 0 AND 3),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at_utc TEXT NOT NULL,
  deadline_at_utc TEXT NOT NULL,
  active_attempt_id TEXT,
  active_work_kind TEXT CHECK (active_work_kind IN ('TURN', 'RECONCILIATION')),
  lease_owner_id TEXT,
  lease_token INTEGER NOT NULL DEFAULT 0 CHECK (lease_token >= 0),
  lease_expires_at_utc TEXT,
  latest_error_class TEXT,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  UNIQUE (cycle_id, run_id),
  UNIQUE (cycle_id, direction, replica_index),
  FOREIGN KEY (cycle_id, run_id)
    REFERENCES direction_runs(cycle_id, direction_run_id),
  CHECK ((state = 'LEASED' AND active_attempt_id IS NOT NULL
          AND active_work_kind IS NOT NULL AND lease_owner_id IS NOT NULL
          AND lease_expires_at_utc IS NOT NULL)
      OR (state <> 'LEASED' AND active_attempt_id IS NULL
          AND active_work_kind IS NULL AND lease_owner_id IS NULL
          AND lease_expires_at_utc IS NULL))
);
CREATE INDEX scheduler_jobs_eligible
  ON scheduler_jobs(state, next_attempt_at_utc, deadline_at_utc, review_id);
CREATE INDEX scheduler_jobs_by_cycle
  ON scheduler_jobs(cycle_id, state, direction, replica_index);

CREATE TABLE scheduler_attempts (
  attempt_id TEXT PRIMARY KEY REFERENCES worker_attempts(attempt_id),
  run_id TEXT NOT NULL REFERENCES scheduler_jobs(run_id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  state TEXT NOT NULL CHECK (state IN (
    'RUNNING', 'SUCCEEDED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE',
    'MALFORMED', 'UNKNOWN_SEND', 'RECONCILED_UNSENT',
    'RECONCILED_ACCEPTED', 'RECONCILIATION_UNKNOWN', 'OBSOLETE', 'CANCELLED'
  )),
  lease_token INTEGER NOT NULL CHECK (lease_token > 0),
  deadline_at_utc TEXT NOT NULL,
  raw_artifact_sha256 TEXT REFERENCES raw_artifacts(sha256),
  error_class TEXT,
  reconciliation_outcome TEXT CHECK (reconciliation_outcome IN (
    'PROVEN_UNSENT', 'PROVEN_ACCEPTED_WITH_RESULT', 'STILL_UNKNOWN'
  )),
  started_at_utc TEXT NOT NULL,
  finished_at_utc TEXT,
  UNIQUE (run_id, attempt_number)
);
CREATE INDEX scheduler_attempts_by_run
  ON scheduler_attempts(run_id, attempt_number);

CREATE TABLE scheduler_aggregations (
  cycle_id TEXT PRIMARY KEY REFERENCES review_cycles(cycle_id),
  backend TEXT NOT NULL CHECK (backend = 'FAKE'),
  qualification TEXT NOT NULL CHECK (qualification = 'OFFLINE_ONLY'),
  state TEXT NOT NULL CHECK (state IN ('NO_FINDINGS', 'PROVISIONAL_FINDINGS')),
  report_json TEXT NOT NULL,
  raw_artifact_sha256 TEXT NOT NULL REFERENCES raw_artifacts(sha256),
  created_at_utc TEXT NOT NULL
);

CREATE TRIGGER scheduler_jobs_identity_guard BEFORE UPDATE ON scheduler_jobs
WHEN
  NEW.run_id <> OLD.run_id OR NEW.review_id <> OLD.review_id OR
  NEW.cycle_id <> OLD.cycle_id OR NEW.direction <> OLD.direction OR
  NEW.replica_index <> OLD.replica_index OR NEW.max_attempts <> OLD.max_attempts OR
  NEW.deadline_at_utc <> OLD.deadline_at_utc OR NEW.created_at_utc <> OLD.created_at_utc OR
  NOT (
    (OLD.state = 'QUEUED' AND NEW.state IN ('LEASED', 'FAILED', 'CANCELLED', 'OBSOLETE')) OR
    (OLD.state = 'LEASED' AND NEW.state IN (
      'LEASED', 'RETRY_WAIT', 'RECONCILIATION_REQUIRED', 'COMPLETE', 'FAILED', 'CANCELLED', 'OBSOLETE'
    )) OR
    (OLD.state = 'RETRY_WAIT' AND NEW.state IN ('LEASED', 'FAILED', 'CANCELLED', 'OBSOLETE')) OR
    (OLD.state = 'RECONCILIATION_REQUIRED' AND NEW.state IN (
      'LEASED', 'RETRY_WAIT', 'COMPLETE', 'FAILED', 'CANCELLED', 'OBSOLETE'
    )) OR
    OLD.state = NEW.state
  )
BEGIN SELECT RAISE(ABORT, 'invalid scheduler job transition'); END;

CREATE TRIGGER scheduler_jobs_no_delete BEFORE DELETE ON scheduler_jobs
BEGIN SELECT RAISE(ABORT, 'scheduler jobs are durable'); END;
CREATE TRIGGER scheduler_attempts_no_delete BEFORE DELETE ON scheduler_attempts
BEGIN SELECT RAISE(ABORT, 'scheduler attempts are durable'); END;
CREATE TRIGGER scheduler_aggregations_no_update BEFORE UPDATE ON scheduler_aggregations
BEGIN SELECT RAISE(ABORT, 'scheduler aggregations are immutable'); END;
CREATE TRIGGER scheduler_aggregations_no_delete BEFORE DELETE ON scheduler_aggregations
BEGIN SELECT RAISE(ABORT, 'scheduler aggregations are immutable'); END;
`;

const migrationFourSql = `
ALTER TABLE scheduler_attempts
  ADD COLUMN backend_receipt_sha256 TEXT REFERENCES raw_artifacts(sha256);
ALTER TABLE scheduler_attempts
  ADD COLUMN backend_send_state TEXT CHECK (
    backend_send_state IS NULL OR backend_send_state IN ('UNSENT', 'SENT', 'UNKNOWN')
  );

CREATE TABLE scheduler_backend_bindings (
  cycle_id TEXT PRIMARY KEY REFERENCES review_cycles(cycle_id),
  backend_kind TEXT NOT NULL CHECK (backend_kind IN ('FAKE', 'LIVE')),
  backend_protocol TEXT NOT NULL CHECK (length(backend_protocol) BETWEEN 1 AND 128),
  bridge_version_pin TEXT NOT NULL CHECK (length(bridge_version_pin) BETWEEN 1 AND 64),
  requested_model TEXT NOT NULL CHECK (length(requested_model) BETWEEN 1 AND 256),
  requested_reasoning_effort TEXT NOT NULL CHECK (length(requested_reasoning_effort) BETWEEN 1 AND 32),
  qualification TEXT NOT NULL CHECK (qualification IN ('OFFLINE_ONLY', 'LIVE_PRODUCTION_BRIDGE')),
  configuration_digest TEXT NOT NULL CHECK (
    length(configuration_digest) = 64 AND configuration_digest NOT GLOB '*[^0-9a-f]*'
  ),
  run_plan TEXT NOT NULL CHECK (run_plan IN ('NR08_FAKE_3X3', 'NR09_LIVE_QUALIFICATION')),
  required_run_count INTEGER NOT NULL CHECK (required_run_count IN (1, 9)),
  binding_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  CHECK (
    (backend_kind = 'FAKE' AND qualification = 'OFFLINE_ONLY'
      AND run_plan = 'NR08_FAKE_3X3' AND required_run_count = 9) OR
    (backend_kind = 'LIVE' AND qualification = 'LIVE_PRODUCTION_BRIDGE'
      AND run_plan = 'NR09_LIVE_QUALIFICATION' AND required_run_count = 1)
  )
);

CREATE TRIGGER scheduler_backend_bindings_no_update BEFORE UPDATE ON scheduler_backend_bindings
BEGIN SELECT RAISE(ABORT, 'scheduler backend bindings are immutable'); END;
CREATE TRIGGER scheduler_backend_bindings_no_delete BEFORE DELETE ON scheduler_backend_bindings
BEGIN SELECT RAISE(ABORT, 'scheduler backend bindings are immutable'); END;

CREATE TABLE scheduler_attempt_artifacts (
  attempt_id TEXT NOT NULL REFERENCES scheduler_attempts(attempt_id),
  purpose TEXT NOT NULL CHECK (purpose IN (
    'HEALTH', 'MODEL_CATALOG', 'TURN_RESPONSE', 'SCHEMA_REPAIR_RESPONSE',
    'LOCAL_DIAGNOSTIC', 'RECEIPT'
  )),
  artifact_sha256 TEXT NOT NULL REFERENCES raw_artifacts(sha256),
  PRIMARY KEY (attempt_id, purpose)
);
CREATE INDEX scheduler_attempt_artifacts_by_hash
  ON scheduler_attempt_artifacts(artifact_sha256);
CREATE TRIGGER scheduler_attempt_artifacts_no_update BEFORE UPDATE ON scheduler_attempt_artifacts
BEGIN SELECT RAISE(ABORT, 'scheduler attempt artifacts are immutable'); END;
CREATE TRIGGER scheduler_attempt_artifacts_no_delete BEFORE DELETE ON scheduler_attempt_artifacts
BEGIN SELECT RAISE(ABORT, 'scheduler attempt artifacts are immutable'); END;

INSERT INTO scheduler_backend_bindings
  (cycle_id, backend_kind, backend_protocol, bridge_version_pin,
   requested_model, requested_reasoning_effort, qualification,
   configuration_digest, run_plan, required_run_count, binding_json,
   created_at_utc)
SELECT j.cycle_id, 'FAKE', 'nr-fake-scheduler/1', 'not_applicable',
       'deterministic-fake', 'offline', 'OFFLINE_ONLY',
       '34c8696160ef88ca5a45c232b0e41bd5535750f1320b4c7c4ed156c048e98988',
       'NR08_FAKE_3X3', 9,
       '{"backend":"FAKE","backendProtocol":"nr-fake-scheduler/1","bridgeVersionPin":"not_applicable","model":"deterministic-fake","reasoningEffort":"offline","qualification":"OFFLINE_ONLY","configurationDigest":"34c8696160ef88ca5a45c232b0e41bd5535750f1320b4c7c4ed156c048e98988","runPlan":"NR08_FAKE_3X3","requiredRuns":9}',
       MIN(j.created_at_utc)
FROM scheduler_jobs j
GROUP BY j.cycle_id;
`;

function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export const STORAGE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "core-review-state",
    sql: migrationOneSql,
    checksum: checksum(migrationOneSql),
  },
  {
    version: 2,
    name: "immutable-results-and-fencing",
    sql: migrationTwoSql,
    checksum: checksum(migrationTwoSql),
  },
  {
    version: 3,
    name: "durable-scheduler-fake-backend",
    sql: migrationThreeSql,
    checksum: checksum(migrationThreeSql),
  },
  {
    version: 4,
    name: "immutable-backend-binding-and-attempt-provenance",
    sql: migrationFourSql,
    checksum: checksum(migrationFourSql),
  },
];

export type BeforeMigration = (
  fromVersion: number,
  toVersion: number,
) => Promise<void>;

export async function applyStorageMigrations(
  db: Database,
  beforeMigration?: BeforeMigration,
): Promise<number> {
  const userVersionRow = db.query("PRAGMA user_version").get() as
    | { user_version?: number }
    | undefined;
  let version = Number(userVersionRow?.user_version ?? 0);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new StorageError(
      "UNSUPPORTED_SCHEMA",
      "Database user_version is not a supported non-negative integer.",
    );
  }
  const latestSupported = STORAGE_MIGRATIONS.at(-1)?.version ?? 0;
  if (version > latestSupported) {
    throw new StorageError(
      "UNSUPPORTED_SCHEMA",
      `Database schema ${version} is newer than supported schema ${latestSupported}.`,
    );
  }

  const userObjects = db
    .query(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'view', 'trigger', 'index') AND name NOT LIKE 'sqlite_%'",
    )
    .all() as Array<{ name: string }>;
  const hasMigrationLedger =
    db
      .query(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get() != null;
  if (version === 0 && userObjects.length > 0) {
    throw new StorageError(
      "UNSUPPORTED_SCHEMA",
      "An unversioned database already contains tables; refusing an in-place migration.",
    );
  }
  if (version > 0 && !hasMigrationLedger) {
    throw new StorageError(
      "UNSUPPORTED_SCHEMA",
      "Versioned database is missing its immutable migration ledger.",
    );
  }
  if (version > 0) verifyAppliedMigrations(db, version);

  for (const migration of STORAGE_MIGRATIONS) {
    if (migration.version <= version) continue;
    if (version > 0 && beforeMigration) {
      await beforeMigration(version, migration.version);
    }
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.query(
        `INSERT INTO schema_migrations (version, name, checksum, applied_at_utc)
         VALUES (?, ?, ?, ?)`,
      ).run(
        migration.version,
        migration.name,
        migration.checksum,
        new Date().toISOString(),
      );
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
    apply.immediate();
    version = migration.version;
  }

  verifyAppliedMigrations(db, version);
  return version;
}

function verifyAppliedMigrations(db: Database, version: number): void {
  const rows = db
    .query(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    )
    .all() as Array<{ version: number; name: string; checksum: string }>;
  const expected = STORAGE_MIGRATIONS.filter(
    (migration) => migration.version <= version,
  );
  if (rows.length !== expected.length) {
    throw new StorageError(
      "UNSUPPORTED_SCHEMA",
      "Migration ledger does not match the database schema version.",
    );
  }
  for (const [index, migration] of expected.entries()) {
    const row = rows[index];
    if (
      row === undefined ||
      row.version !== migration.version ||
      row.name !== migration.name ||
      row.checksum !== migration.checksum
    ) {
      throw new StorageError(
        "UNSUPPORTED_SCHEMA",
        `Migration ledger validation failed at version ${migration.version}.`,
      );
    }
  }
}
