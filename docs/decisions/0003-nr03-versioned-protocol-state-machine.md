# ADR 0003 — NR-03 versioned protocol and review-cycle state machine

- Status: implemented in NR-03 assignment D110; PR acceptance is still pending.
- Date: 2026-10-03.
- Scope: offline protocol contracts, deterministic validation, strict policy, canonical hashing and a pure review-cycle reducer.
- Authority: Lead assignment `NR-03-C1-D110-VERSIONED-SCHEMAS-STATE-MACHINE`.

## Context

Later MCP, storage and backend work needs a stable executable contract. Keeping JSON Schema, runtime validation and TypeScript types in separate hand-maintained definitions would let authority-bearing fields drift. NR-03 is intentionally offline: it does not implement persistence, scheduling, snapshots, an MCP server, model calls or semantic adjudication.

## Decisions

### Schema source and evolution

- Use JSON Schema Draft 2020-12 with `typebox@1.3.34` pinned in the lockfile. Each public schema declaration in `src/protocol/schemas.ts` is the source for its derived `Type.Static` type and runtime `Schema.Compile` validator. Exported documents retain `$schema`, `$id` and `title`; object variants close their properties so unknown fields are rejected.
- TypeBox is the only new dependency. Its schema declarations support the one-source requirement: the same declarations produce TS types, serializable JSON Schema and the validator consumed by production code. Tests compile the JSON-stringified and reparsed exported documents, not only the in-memory declarations.
- The supported protocol is `nr-review/1`. Unknown enum values and unsupported schema versions fail validation. Authority-semantic breaking changes require a new protocol/schema version and ADR. Schema, prompt and policy bindings carry independent versions and SHA-256 hashes; changing schema or policy data under the same version changes its hash.
- Exported valid and invalid examples are executable validation fixtures, not alternate or informal contracts.
- Policy input is validated as `strict/1` before a binding is produced. Prompt hashes cover the exact UTF-8 bytes for string input or the exact supplied byte array. Schema hashes cover canonical JSON Schema serialization.
- Before any v1 data is persisted, rollback to the previous implementation is allowed. Once v1 data exists, breaking changes require an explicit migration path.

### Canonical JSON and identity

- Recursively sort object keys by ASCII lexical order. Preserve array order and string scalar values without Unicode normalization. Encode canonical JSON as UTF-8, with no insignificant whitespace, BOM or final newline.
- Reject values outside the protocol JSON domain rather than coercing them: cycles, accessors, sparse arrays, symbol keys, non-plain objects, unsupported numbers, non-ASCII object keys and non-JSON values are errors. TypeBox's non-enumerable `~kind` marker is omitted only when projecting a declared schema to its JSON document; other non-enumerable schema data is rejected.
- SHA-256 digests are lowercase hexadecimal. Git object IDs are full-length lowercase hexadecimal values bound to the explicit `sha1` or `sha256` object format; abbreviations and format/length mismatches are invalid.
- Idempotency hashes the normalized payload without its idempotency key. Reusing a key with the same canonical payload is replay-equivalent; using it with a different payload is a typed `CONFLICT`. Collections retain order because their order may be semantic.

### Strict policy defaults

The following finite defaults complete the NR-03 strict baseline. Values below are NR-03 choices, not claims about earlier specifications:

| Limit | Default |
|---|---:|
| Open reviews | 12 |
| Required runs | 3 directions × 3 replicas = 9 per initial cycle |
| Runs per cycle | 36 (nine initial runs plus at most three nine-run fix rounds) |
| Worker attempts per run | 2 |
| Model requests per run | 3 (initial request, one semantic retry, one schema repair) |
| Schema repair attempts | 1 |
| Fix rounds | 3 |
| Findings per run / evidence items per finding | 100 / 20 |
| Files per snapshot / file size / review context | 10,000 / 1 MiB / 10 MiB |
| Events per status page | 100 |
| Review / worker / adjudicator deadlines | 15 min / 3 min / 3 min |
| Fix verification / cancellation fence | 10 min / 10 sec |

Critical, high and medium findings block approval; low findings do not. Unknown coverage, unresolved validation and malformed mandatory work fail closed. The approval guard requires exactly one successful run for each direction/replica slot in the 3×3 matrix, complete coverage and adjudication, valid bindings, no confirmed blocking severity, and—when approving a fix cycle—at least one `FIXED` result with no fresh-review requirement.

### State machine and authority boundary

- `allowedReviewStateTransitions` mirrors the normative table in `docs/protocols/RUNTIME.md`. A pure reducer validates both current state and command, enforces `expectedVersion`, returns a new state with a monotonically incremented version, and does not mutate its inputs.
- `APPROVED`, `FAILED` and `CANCELLED` are terminal. Approval is reachable only from `AGGREGATING` or `VERIFYING_FIX` after the strict evidence guard and receipt bindings pass. `PAUSED` retains its reason and stage; only the guarded resume command may return to that stored stage after clearance.
- Cancellation moves through `CANCEL_REQUESTED`; final cancellation requires a command whose schema requires the fencing/revocation confirmation. Late results cannot transition that state to approval. A fresh review creates a distinct child cycle with parent linkage, new context hash and state version zero; the old cycle remains `REQUIRES_FRESH_REVIEW`.
- This reducer validates evidence shape and declared predicates; it cannot prove that an external run actually happened. Later service code must create these evidence records from server-controlled run state, bind them to exact revisions and manifests, and persist transitions with compare-and-swap. Client input must never be treated as the source of approval evidence.
- The NR-03 reducer keeps the latest command binding in the in-memory state only. Persistent storage work must add a durable idempotency ledger before claiming replay guarantees across process restarts or arbitrarily old commands.

## Consequences

- Consumers can validate offline without a daemon or network and can hash stable protocol payloads across key insertion orders.
- Strict unions and exact SHA formats reject ambiguous authority data early. The 3×3 run matrix and policy limits are versioned inputs rather than implicit runtime assumptions.
- This ADR does not claim live review, durable state, cross-restart idempotency, verified evidence provenance, or product acceptance. Those guarantees belong to later assigned tasks.

## Rollback

Before v1 data is persisted, the schema package and reducer can be reverted together. After persistence begins, do not roll back across an authority-semantic schema change without an explicit migration plan and versioned compatibility decision.
