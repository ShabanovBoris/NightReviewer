# ADR 0008: Durable scheduler and offline fake backend

**Status:** Accepted for NR-08 by Lead D130

**Date:** 2026-10-04
**Scope:** NR-08 offline scheduling only. Live transport, fresh reviewer sessions, direction adjudication and fix verification remain later tasks.

## Context

NR-07 leaves accepted reviews durably in `REVIEWING`. NR-08 must exercise scheduling and state transitions reproducibly without a model, connector or network. SQLite and the NR-03 state reducer remain authoritative. The strict profile uses nine logical scheduler runs; these slots do not represent nine independent chats or a production 3×3 review.

## Decisions

### Job, run and attempt identity

A durable job is identified by `(cycleId, runId)`. `runId` stays stable across retries. Every backend invocation gets a new `attemptId`; a reconciliation turn refers to the original attempt instead of creating a replacement reviewer run. The seeded run binds the immutable review revisions, role, direction, prompt hash, schema hash, policy hash, deadline and retry limit.

### Lease and fencing ownership

The daemon owner must hold the current root fencing token before it creates or advances scheduler state. A job has its own lease resource and monotonically increasing token. Claim, attempt creation and fairness-cursor update commit in one SQLite transaction. Only the holder of the current daemon and job fences can select a result. Expired leases become reconciliation work; expiry alone never authorizes a stale result. A late artifact is retained with `selected=false` and an obsolete event.

### Concurrency and fairness

The single daemon scheduler admits at most three active backend turns by default, including reconciliation calls. SQLite serializes each claim; the persistent cursor chooses reviews round-robin so one review cannot take every newly available slot. With one eligible review, it may use all configured slots. A configured bound must be a positive integer no greater than 36.

### Deadline, retry and error classification

Each run has one immutable review deadline and each attempt has a bounded deadline. The default is three attempts per run with exponential backoff capped at 30 seconds and injectable deterministic jitter. Authentication, authorization/policy, invalid-schema and permanent failures are terminal. A declared transient failure may retry only when its send state is known `UNSENT`. `SENT` or `UNKNOWN` outcomes require reconciliation.

### Unknown sends

Unknown send is a durable `RECONCILIATION_REQUIRED` state and never schedules a blind replacement attempt. `PROVEN_UNSENT` may retry under the original budget and deadline. `PROVEN_ACCEPTED_WITH_RESULT` is schema/binding checked and selected once. `STILL_UNKNOWN` remains blocked for reconciliation; the automatic reconciliation count is bounded at three.

### Fake qualification and aggregation boundary

The backend is fixed to `FAKE`; construction rejects a LIVE backend. Every scheduler-produced output, report and scheduler event carries `backend=FAKE` and `qualification=OFFLINE_ONLY`. A complete, schema-valid set of all nine selected no-finding outputs may pass the existing NR-03 policy gate as an offline protocol-state exercise. It is not live qualification, semantic review or project acceptance.

Finding outputs remain provisional, are visible in durable scheduler status and do not become canonical findings. The cycle stays in `AGGREGATING`; no adjudication is fabricated. NR-12 owns semantic adjudication, deduplication and canonical validation. Missing, malformed, failed or unresolved required runs cannot approve.

### Raw artifact persistence

Exact bytes are atomically written to the content-addressed artifact directory before result selection. The subsequent fenced SQLite transaction records the artifact reference together with attempt disposition, selected result, findings and event. A crash between file publication and DB association leaves an orphan that existing artifact reconciliation can report; it cannot create a selected result without a DB record. The filesystem write does not hold an open SQLite transaction across an `await`, so concurrent backend completions cannot overlap transactions on the Bun SQLite connection.

## Consequences

- Storage schema v3 adds scheduler control, jobs, attempts and immutable aggregation records.
- Restart resumes queued and retry-wait jobs; expired running work is reconciled before any replacement attempt.
- Fake approval proves only the offline scheduler/state-machine mechanics. It cannot be used as LIVE evidence for later roadmap tasks.
- Automatic `STILL_UNKNOWN` handling may leave a review blocked until a later reconciliation capability or operator policy exists.
