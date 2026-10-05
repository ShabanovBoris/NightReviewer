# ADR 0009 — LIVE scheduler qualification boundary

**Status:** Accepted by Lead D140 for NR-09 cycle 1
**Date:** 2026-10-05
**Scope:** Durable LIVE transport execution for one NR-09 qualification run; semantic review remains disabled.

## Authority

Lead decision `NR-09-D140-RATIFY-D139-CORRELATED-B-NARROWED` is correlated to the implementer's `DECISION_REQUEST` `0bd8f31d-44fb-41e0-9f03-d7c39d04ddf5`; the raw decision receipt is preserved in the private session journal. D140 supersedes the uncorrelated D139 envelope while ratifying its narrowed architecture.

## Decision

- `DurableScheduler` accepts an injected LIVE backend. The default remains the deterministic FAKE backend.
- Before the first scheduler claim, storage records an immutable per-cycle backend binding: backend kind and protocol, bridge pin, requested model and effort, qualification class, run plan, and a non-secret configuration digest.
- Schema v4 backfills existing NR-08 cycles as `FAKE` / `OFFLINE_ONLY`. A restart with a different binding fails closed; an in-flight FAKE cycle is never converted to LIVE.
- The NR-08 FAKE run plan remains nine runs across correctness, tests, and design, with the existing offline aggregation and approval behavior unchanged.
- The NR-09 LIVE qualification plan contains one fresh reviewer session and one durable run. It proves transport execution only. A successful run leaves the review non-approved; LIVE aggregation, canonical finding promotion, semantic adjudication, and production 3×3 are disabled.
- Lease ownership, fencing, fairness, deadlines, bounded retry, reconciliation, and late-result obsolescence apply to both backend kinds. An ambiguous LIVE send is never blindly resent. A late completion is retained as audit evidence and remains unselected.
- LIVE response bytes are persisted before parsing. A bound receipt records run, attempt, review SHA pair, bridge/model/effort observations, thread/turn identity, raw references, and terminal/send-state classification. Credentials, cookies, bearer tokens, and context capabilities are never persisted.
- The adapter's explicit expected-version compatibility check supports a read-only upgrade canary. Normal reviewer invocation remains pinned to `6.1.3` and does not silently fall back or adopt a candidate version.

## Live gate

Lead D140 does not authorize a bridge, runtime, model, connector, tunnel, credential, or LIVE HTTP action. After implementation, offline contract verification, and exact-head CI, the implementer must submit the separate D138 pre-LIVE `DECISION_REQUEST`. NR-10 owns production Context MCP, NR-11 owns independent replicas and strict 3×3, and NR-12 owns semantic adjudication.

## Consequences

Scheduler status and events derive backend and qualification from the persisted cycle binding. A complete LIVE qualification can be reported as transport-complete while the product review remains in `REVIEWING`; it cannot advance to `APPROVED` through the NR-08 fake aggregation path.
