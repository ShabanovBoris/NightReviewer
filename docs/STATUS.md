# Реестр реализации

Источник истины выполнения — merged state GitHub и receipt ledger. NR-01…NR-20 остаются отдельными bounded PR; документация сама по себе не означает реализацию или приёмку.

| Task | Status | PR / evidence |
|---|---|---|
| NR-01 | COMPLETE | [PR #2](https://github.com/ShabanovBoris/NightReviewer/pull/2), merged main e9e7812ff4058ce9fc1184e7275be2ebdcd99588; lead acceptance c842056b-9571-4f04-8f42-f3b96863f54d; resulting-main CI 36325969092 |
| NR-02 | IN_PROGRESS — cycle 2 documentation update; LIVE evidence pending | [PR #3](https://github.com/ShabanovBoris/NightReviewer/pull/3); assignment NR-02-C2-D40-MINIMUM-WORKING-613-BRIDGE; branch nr-02-chatgpt-web-spike; base e9e7812ff4058ce9fc1184e7275be2ebdcd99588; head at assignment e2f28cc067baee7c6408b051bf4a20ca2ee70a9f |
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

## NR-02 current cycle 2 — D40

Lead decision NR-02-D40-REBASE-ON-CURRENT-613-PROD-MINIMUM-WORKING-BRIDGE replaces the previous 6.1.1 runtime gate with the current Codex Web GPT 6.1.3 production baseline and existing production tunnel. No downtime, new Tunnel ID, or runtime key is required for this route. DEV remains non-authoritative for LIVE acceptance.

Current baseline as recorded by Lead D40:
- Shared 6.1.3 runtime: PASS_READY.
- Codex Native2 NR-02: PASS_CONNECTED; Authentication=None; permission=Always ask.
- Connector-to-transport binding: PASS_BY_USER_ATTESTATION; no independent tool callback is implied.
- NR-02-AC1: NOT_RUN; NR-02-AC2: NOT_RUN.
- NR-02-AC3: DEFERRED_HARDENING.
- NR-02-AC4: PASS for the documentation criterion after local audit; this does not satisfy AC1/AC2 or complete NR-02.
- Reviewer cycle 1: BLOCKED, finding NR-02-R1-F1 NOT_FIXED; this verdict cannot approve cycle 2.
- Merge authorization: NOT_GRANTED.

The cycle 2 assignment is documentation/evidence only. The current spike runner still hardcodes 6.1.1 and cannot be treated as a 6.1.3 harness. Connector calls and production actions are excluded from this assignment. The next executable step requires a separate Lead assignment/authorization to adapt the harness to 6.1.3 and run the limited AC1/AC2 probes; AC3 remains deferred hardening.

## Historical decisions and evidence

Lead decisions D1–D39, cycle 1 source-audit material, DEV diagnostics, D3/D5/D6 procedures, and the prior reviewer receipts remain preserved in the private session journal and existing evidence history. Their 6.1.1, shared-runtime handoff, and three-context acceptance assumptions are historical where they conflict with D40. No earlier LIVE request, tool round-trip, cancellation receipt, or three-context result is promoted to the new acceptance state.

Финальная приёмка: NOT_REQUESTED. Release main SHA: отсутствует. PROJECT_ACCEPTED: отсутствует.
