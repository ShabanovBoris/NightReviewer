# Реестр реализации

Источник истины выполнения — merged state GitHub и receipt ledger. NR-01…NR-20 остаются отдельными bounded PR; документация сама по себе не означает реализацию или приёмку.

| Task | Status | PR / evidence |
|---|---|---|
| NR-01 | COMPLETE | [PR #2](https://github.com/ShabanovBoris/NightReviewer/pull/2), merged main e9e7812ff4058ce9fc1184e7275be2ebdcd99588; lead acceptance c842056b-9571-4f04-8f42-f3b96863f54d; resulting-main CI 36325969092 |
| NR-02 | IN_PROGRESS — D52 offline evidence durability remediation; D49 AC1 is UNVERIFIED, no new LIVE action authorized | [PR #3](https://github.com/ShabanovBoris/NightReviewer/pull/3); assignment NR-02-C2-DURABLE-LIVE-EVIDENCE-CAPTURE; branch nr-02-chatgpt-web-spike; base e9e7812ff4058ce9fc1184e7275be2ebdcd99588 |
| NR-03 | PLANNED | — |
| NR-04 | PLANNED | — |
| NR-05 | PLANNED | — |
| NR-06 | PLANNED | — |
| NR-07 | PLANNED | — |
| NR-08 | PLANNED | — |
| NR-09 | PLANNED | — |
| NR-10 | PLANNED | — |
| NR-11 | PLANNED | — |
| NR-12 | PLANNED | — |
| NR-13 | PLANNED | — |
| NR-14 | PLANNED | — |
| NR-15 | PLANNED | — |
| NR-16 | PLANNED | — |
| NR-17 | PLANNED | — |
| NR-18 | PLANNED | — |
| NR-19 | PLANNED | — |
| NR-20 | PLANNED | — |

## NR-02 current cycle 2 — D52

Lead D40/D41's acceptance target remains the existing production Codex Web GPT `6.1.3` and unchanged `Codex Native2`, selected by production `config.appName`. D52 assigns offline durable-evidence remediation only; AC1–AC4 are unchanged and D52 does not authorize a LIVE attempt.

Current state:
- D49's single AC1 attempt is consumed. An internal guard passed, but terminal evidence was discarded; AC1 is `UNVERIFIED`, not PASS or FAIL.
- D50 found no relevant logs and did not retain D49's exact interval. The missing evidence does not establish `NOT_RUN` or a cause.
- D51's LIVE hold remains. D52 permits repository implementation, deterministic tests, documentation, commit/push to the existing PR #3 branch, and exact-head CI only.
- AC2 remains `NOT_RUN`; unavailable connector/tool remains `NOT_AUTHORIZED_NOT_RUN`. AC3 remains `DEFERRED_HARDENING`. AC4 remains documentation-only and is not LIVE acceptance.
- Reviewer request after D52: `NOT_AUTHORIZED`. Merge authorization: `NOT_GRANTED`.
- Production/DEV runtime, tunnel, connector, credentials, permissions and configuration changes: prohibited. Production bridge HTTP requests and connector calls during D52: `0`.

D52 requires a stable run ID and exact PR head before any network-capable child stage; synchronously flushed events for attempts before their side effects; distinct request-attempt and response-receipt stages; a terminal success/failure with the last proven stage; exact UTC start/finish and child exit code/signal; and host-native private capture of complete stdout/stderr. The wrapper precreates owner-only artifacts before child spawn, stores raw streams only under ignored `.nightreviewer/`, and returns a sanitized receipt with hashes, byte counts, allowlisted metadata and terminal classification. A missing, malformed, reordered, unsafe or incomplete ledger fails closed.

Offline verification covers injected failures before requests, at the initial Responses attempt, fixture read, continuation and final correlation, plus simulated success and redaction sentinels. These deterministic tests cannot change AC1's `UNVERIFIED` state. After implementation, publication and exact-head CI, the next required action is a correlated `DECISION_REQUEST` to Lead asking for a separate bounded host-native LIVE authorization. D52 does not automatically authorize that attempt, a reviewer request or merge.

D49–D52 source receipts and the D52 accessibility-capture limitation are recorded in the private session ledger and summarized in `docs/evidence/NR-02.json`. D43's catalog correction and old CI remain historical; they do not verify the D52 head.

## Historical decisions and evidence

Lead decisions D1–D40, cycle 1 source-audit material, DEV diagnostics, D3/D5/D6 procedures, and prior reviewer receipts remain preserved in the private session journal and evidence history. Their 6.1.1, shared-runtime handoff, connector `Codex Native2 NR-02`, and three-context acceptance assumptions are historical where they conflict with D40/D41. No earlier LIVE request, tool round-trip, cancellation receipt, or three-context result is promoted to current acceptance.

Финальная приёмка: NOT_REQUESTED. Release main SHA: отсутствует. PROJECT_ACCEPTED: отсутствует.
