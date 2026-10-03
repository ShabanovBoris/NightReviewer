# ADR 0004 — SQLite durable artifact store

- Status: implemented in NR-04 assignment D115; independent review and lead acceptance pending.
- Date: 2026-10-03.
- Scope: local durable persistence for NR-03 reviews and their raw results, findings, provenance, state transitions, outbox, leases, backups, and migrations.
- Authority: Lead assignment `NR-04-C1-D115-SQLITE-DURABLE-ARTIFACT-STORE`.

## Context

NR-03 defines the review protocol and pure state reducer, but it does not retain review state across process restarts. NR-04 needs one transactional persistence boundary without introducing an external database service or copying large raw responses into SQLite rows. The durable boundary must distinguish a committed result from bytes that survived a crash before the database commit.

## Decisions

### SQLite and schema evolution

- Use Bun's built-in `bun:sqlite` at the repository-pinned Bun 1.4.2. Do not add an ORM or external database dependency.
- Use WAL, `synchronous=FULL`, foreign-key enforcement, and a bounded busy timeout on every opened store. The owned root is mode `0700`; the SQLite file and artifact files are mode `0600`.
- Keep versioned SQL migrations and a checksummed, append-only migration ledger. Unknown future versions, mismatched ledgers, and unversioned nonempty databases fail closed. Downgrade is unsupported.
- Before moving an existing version forward, create and verify a consistent backup of that version. A version-zero database may migrate only when it has no user tables.

### Transactional repository boundary

- Persist NR-03 review cycles as validated state JSON and indexed columns. Apply NR-03 commands inside an immediate SQLite transaction and commit the cycle CAS, event, and outbox record together.
- Scope idempotency by caller and operation, bind it to the canonical payload hash, and persist the original result in the same transaction as the operation.
- A fix submission checks its expected state version and exact authoritative finding ID set, records the fix, advances the cycle to `VERIFYING_FIX`, and writes event/outbox entries atomically.
- Direction runs have a constrained status lifecycle. Attempts and their raw results are append-only. A run can become `COMPLETE` only after a selected valid result exists.
- Lease acquisition, renewal, release, and fenced cycle mutation use monotonically increasing fencing tokens and immediate transactions.

### Raw artifact durability

- The caller first persists exact response bytes through `persistRawArtifact`, before parsing. It later passes that reference to `recordWorkerResult`. Store bytes in an owned content-addressed path keyed by lowercase SHA-256; write a unique temporary file, sync its bytes, atomically rename it into place, and sync the containing directory before inserting database references.
- Commit artifact metadata, raw result disposition, selected state, parsed result when available, provenance, event, and outbox together. Malformed, rejected, obsolete, and failed results retain their raw bytes.
- If the database transaction fails after the file is published, keep the file as an orphan. Reconciliation reports orphan, missing, hash mismatch, size mismatch, and temporary files; it never promotes or deletes data automatically.

### Backup and restore

- Capture SQLite state and referenced artifact rows from one read transaction. Store every referenced immutable artifact and a canonical manifest containing exact sizes and SHA-256 values.
- The serialized WAL database image is normalized as a separate standalone copy before read-only integrity verification. The running database remains in WAL mode.
- Restore accepts only a new or empty destination. Validate manifest canonical form, database hash, SQLite integrity, foreign keys, and every artifact before declaring success; open and reconcile the restored store afterward.

## Consequences

- Process restart preserves reviews, cycles, snapshots, raw result bytes, provenance, and current statuses using only local files.
- SQLite transactions serialize competing writers and make state/outbox/idempotency effects all-or-nothing. `BEGIN IMMEDIATE` can return a typed retryable conflict after the configured busy timeout.
- A crash between artifact rename and database commit may consume disk space and produce an orphan report; automatic garbage collection is deliberately absent.
- The store verifies Git object ID shape and old/new fix bindings but does not inspect commit ancestry. A later Git snapshot/service layer must enforce the repository's ancestry policy.
- Backup copies are self-contained but require space for the SQLite image plus all referenced artifacts.

## Validation

`tests/storage/storage.test.ts` uses real temporary SQLite databases for restart/provenance, concurrent idempotent submissions, CAS, injected event/outbox rollback, fix transition, malformed raw-byte retention, artifact reconciliation, backup tampering, v1 forward-migration backup, unknown future schema, and unversioned-data preservation. Full repository verification and exact-head CI are recorded in `docs/evidence/NR-04.json` and the PR review comments.

## Rollback

Do not open a newer database with older code. Restore a verified backup into a new or empty directory and run the matching schema version. Do not delete or overwrite the original database or artifacts as an automatic rollback step.
