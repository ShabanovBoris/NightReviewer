# ADR 0006 — Bounded read-only review context

- Status: implemented in NR-06 assignment D124; independent review and lead acceptance pending.
- Date: 2026-10-04.
- Scope: expose pinned Git snapshot and explicitly bound test-result context to reviewer, adjudicator, and fix-verifier runs.
- Authority: Lead assignment `NR-06-C1-D124-BOUNDED-READONLY-REVIEW-CONTEXT`.

## Context

NR-05 retains exact base/head Git objects and an immutable review manifest. Reviewers need a small set of read operations without access to a developer's working tree, arbitrary repository paths, other review runs, or an unrestricted terminal. Existing NR-04 storage already records exact raw worker-result artifacts and their provenance, so the context service should reuse that boundary.

## Decisions

### Run-bound capabilities

- Issue a random 256-bit capability only after verifying its review, cycle, run, attempt, role, direction, and snapshot identities against SQLite records.
- Keep capabilities in a process-local authority; persist only a SHA-256 digest of each secret. Expiry, explicit revocation, run revocation, and service close invalidate access. A restart does not restore old capabilities.
- Check both the capability's declared tool set and an immutable role allowlist on every call. Only fix verifiers can select an explicitly bound previous snapshot. Adjudicators cannot search or enumerate the full tree.
- Never accept a repository or revision from a tool request. Resolve only snapshot identities already bound to the capability, then verify the loaded manifest and tree entries against the stored identity.

### Reads, search, and pagination

- Read file content from the retained Git object pack, including unchanged files and deleted paths on the base side. Do not resolve snapshot paths against the host filesystem.
- Bound path/query bytes, pages, response bytes, file chunks, search bytes, artifact bytes, and request duration. Reject traversal and invalid Unicode paths.
- Return valid UTF-8 in boundary-aligned chunks; return binary or invalid UTF-8 as base64 with an explicit content state. Search uses literal matching only and reports unsupported files instead of treating skipped content as an exact result count.
- Sign cursors with a process-local HMAC secret and bind each cursor to capability, snapshot pair, tool, query/options, and page size. A cursor from a different run, request, or snapshot cannot be reused.

### Test-result provenance

- Accept only bounded `nr-test-result/1` bytes on a reviewer run in the `tests` direction. Verify the supplied SHA-256 and size before storing the raw bytes with the existing worker-attempt result record.
- Adjudicators and fix verifiers may read only test artifacts explicitly bound to their capability and same review/cycle lineage. Reviewers can read only their own test-direction result.
- Report artifact integrity separately from execution trust. The service marks every producer claim `UNVERIFIED`, records stale commit applicability, and never claims to have executed a reported command.

## Consequences

- Context calls expose only the pinned review pair and explicitly authorized reports. Capabilities and cursors are intentionally lost on process restart.
- Large trees and unsupported content can produce partial search coverage, which is reported through skip counts and `totalExact: false`.
- External MCP, tunnel lifecycle, arbitrary execution, and model adjudication remain outside NR-06.

## Validation

NR-06 fixtures cover cross-run isolation, role ACLs, expiration and revocation, full-tree and base/head reads, stable pagination, literal search, UTF-8 and binary handling, bounds, and test-result provenance. Exact Bun 1.4.2 test/build results are recorded in `docs/evidence/NR-06.json`; no unrun check is represented as a pass.

## Rollback

Revoke capabilities for the affected run before stopping its context service. Revert through a reviewed PR; retained snapshot packs and raw test artifacts remain governed by NR-04 storage and reconciliation rules.
