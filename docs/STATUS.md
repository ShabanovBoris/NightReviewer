# Реестр реализации

Источник истины выполнения — merged state GitHub и receipt ledger. NR-01…NR-20 остаются отдельными bounded PR; документация сама по себе не означает реализацию или приёмку.

| Task | Status | PR / evidence |
|---|---|---|
| NR-01 | COMPLETE | [PR #2](https://github.com/ShabanovBoris/NightReviewer/pull/2), merged main e9e7812ff4058ce9fc1184e7275be2ebdcd99588; lead acceptance c842056b-9571-4f04-8f42-f3b96863f54d; resulting-main CI 36325969092 |
| NR-02 | IN_PROGRESS — D56 offline ChatGPT-Web route remediation; D53 AC1 is UNVERIFIED after HTTP 400 before tool call; no new LIVE action authorized | [PR #3](https://github.com/ShabanovBoris/NightReviewer/pull/3); assignment NR-02-C2-D53-WEB-ROUTE-CONTRACT-REMEDIATION; branch nr-02-chatgpt-web-spike; base e9e7812ff4058ce9fc1184e7275be2ebdcd99588 |
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

## NR-02 current cycle 2 — D53–D56

Lead D56 requires NR-02 AC1 to traverse the ChatGPT-Web browser adapter on the existing production Codex Web GPT runtime `6.1.3` and unchanged connector `Codex Native2`, selected by production `config.appName`. The runtime version and routed browser model are distinct: the only assigned AC1 route is `chatgpt-web/gpt-5.6-sol` with `high` reasoning. AC1–AC4 are unchanged.

Current state:
- D53's one AC1 invocation is consumed. Its health and catalog guards passed; its initial `/v1/responses` call returned HTTP 400 before any tool call, fixture read, or continuation. AC1 remains `UNVERIFIED`, with no acceptance credit.
- D55 classifies the 400 as `NON_REQUEST_CONTRACT_400`: `gpt-6.1-sol` selects the native passthrough in upstream 6.1.3, not the browser adapter. The exact downstream 400 cause is unknown and is not attributed to the model-routing discrepancy.
- D56 authorizes offline route remediation, deterministic tests, documentation, commit/push to the existing PR #3 branch, PR narrative update, and exact-head CI only. It requires rejecting every model except `chatgpt-web/gpt-5.6-sol` before network-capable execution, verifying that exact catalog row advertises `high`, and recording the route/effort in sanitized stage evidence.
- D52 durable evidence capture remains in place. D56 authorizes no production HTTP, connector call, LIVE retry, cancellation, unavailable-connector/tool probe, AC3 matrix, DEV operation, or production/DEV runtime, tunnel, connector, credential, permission, or configuration change.
- AC2 remains `NOT_RUN`; unavailable connector/tool remains `NOT_AUTHORIZED_NOT_RUN`. AC3 remains `DEFERRED_HARDENING`. AC4 is documentation/contract verification only and cannot establish LIVE acceptance.
- Reviewer request: `NOT_AUTHORIZED`. Merge authorization: `NOT_GRANTED`.

D52 requires a stable run ID and exact PR head before any network-capable child stage; synchronously flushed events for attempts before their side effects; distinct request-attempt and response-receipt stages; a terminal success/failure with the last proven stage; exact UTC start/finish and child exit code/signal; and host-native private capture of complete stdout/stderr. The wrapper precreates owner-only artifacts before child spawn, stores raw streams only under ignored `.nightreviewer/`, and returns a sanitized receipt with hashes, byte counts, allowlisted metadata and terminal classification. A missing, malformed, reordered, unsafe or incomplete ledger fails closed.

Offline verification must cover route rejection before the first fetch, canonical settings acceptance, catalog presence/high reasoning, simulated request-body preservation, exact route/effort stage evidence, and zero real fetches, in addition to the D52 failure/success/redaction suite. These deterministic tests cannot change AC1's `UNVERIFIED` state. After implementation, publication and exact-head CI, the next required action is a correlated `DECISION_REQUEST` to Lead asking for separate host-native LIVE authorization. D56 does not automatically authorize that attempt, a reviewer request or merge.

D49–D56 source receipts and the D53/D55 route findings are recorded in the private session ledger and summarized in `docs/evidence/NR-02.json`. D43's catalog correction and earlier CI remain historical; they do not verify the D56 head.

## Historical decisions and evidence

Lead decisions D1–D40, cycle 1 source-audit material, DEV diagnostics, D3/D5/D6 procedures, and prior reviewer receipts remain preserved in the private session journal and evidence history. Their 6.1.1, shared-runtime handoff, connector `Codex Native2 NR-02`, and three-context acceptance assumptions are historical where they conflict with D40/D41. No earlier LIVE request, tool round-trip, cancellation receipt, or three-context result is promoted to current acceptance.

Финальная приёмка: NOT_REQUESTED. Release main SHA: отсутствует. PROJECT_ACCEPTED: отсутствует.
