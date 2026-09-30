# Реестр реализации

Источник истины выполнения — merged state GitHub и receipt ledger. NR-01…NR-20 остаются отдельными bounded PR; документация сама по себе не означает реализацию или приёмку.

| Task | Status | PR / evidence |
|---|---|---|
| NR-01 | COMPLETE | [PR #2](https://github.com/ShabanovBoris/NightReviewer/pull/2), merged main e9e7812ff4058ce9fc1184e7275be2ebdcd99588; lead acceptance c842056b-9571-4f04-8f42-f3b96863f54d; resulting-main CI 36325969092 |
| NR-02 | IN_PROGRESS — D42 preflight failed and was consumed; D43 offline correction is locally verified, awaiting publication | [PR #3](https://github.com/ShabanovBoris/NightReviewer/pull/3); assignment NR-02-C2-LIVE-613-MINIMUM-WORKING-BRIDGE; branch nr-02-chatgpt-web-spike; base e9e7812ff4058ce9fc1184e7275be2ebdcd99588; current published head c759e0a749561adec3cd6b56038d5571dcb6139b |
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

## NR-02 current cycle 2 — D43

Lead D40 selects the current Codex Web GPT 6.1.3 production baseline and existing production tunnel. D41 corrects connector selection: unchanged production `config.appName` selects `Codex Native2`. Auxiliary `Codex Native2 NR-02` remains `KEEP_UNCHANGED` and is not used. No downtime, runtime/tunnel/config/connector change, new Tunnel ID/key, or DEV work is authorized or required.

Current state:
- Production 6.1.3 baseline: Lead-reported `PASS_READY`; the independent fixture callback is not yet observed.
- Selected production connector: `Codex Native2`, based on D41's source-checked exact `config.appName`; route binding is not independently proven by a tool receipt.
- Auxiliary `Codex Native2 NR-02`: unchanged and unused for D41 acceptance.
- AC1: `NOT_RUN`.
- AC2: `NOT_RUN`; D41's cancellation gate depended on successful preflight and AC1, neither occurred. D43 authorizes no LIVE request; unavailable connector/tool remains `NOT_AUTHORIZED_NOT_RUN`.
- AC3: `DEFERRED_HARDENING`; do not run the former three-context matrix.
- AC4: `PASS_DOCUMENTATION_ONLY` after D43 documentation consistency audit and local deterministic verification; this does not satisfy AC1/AC2.
- Reviewer cycle 1: `BLOCKED`, `NR-02-R1-F1 NOT_FIXED`; no cycle 2 reviewer approval.
- Merge authorization: `NOT_GRANTED`.

Phase A contains only offline source, test, and documentation work. D42's replacement preflight reached `/healthz`, then authenticated `/v1/models` returned non-2xx; the exact HTTP status was not retained, `/v1/responses` and the second health check were not reached, and no connector call or production mutation occurred. That attempt is consumed. Lead D43 identified a plausible source-contract mismatch: the runner did not supply the required release-only `client_version` and its fetch User-Agent was not established as a recognized first-party Codex User-Agent. This is source-identified but not live-confirmed as the cause of D42.

D43 permits an offline correction only: require `BRIDGE_SPIKE_CLIENT_VERSION`, validate exact release `major.minor.patch`, and send it as the sole `client_version` query value. The current local active Codex executable reports `0.159.0`; this version was read locally from the active desktop app's embedded Codex executable. Authorization handling is unchanged and no speculative headers are added. The code must include safe non-2xx diagnostics with numeric HTTP status and allowlisted health catalog classification, without bodies, URLs, bearer values, or account data.

D42 consumed its one replacement preflight. D43 authorizes no network requests, connector calls, AC1/AC2, runtime changes, or DEV work. Do not run another preflight automatically after CI; a new Lead decision is required. The D43 offline correction is locally verified but not yet published. AC1/AC2 remain `NOT_RUN`; AC3 is `DEFERRED_HARDENING`; reviewer cycle 2 approval and merge authorization are absent.

The prior Phase A was published at `f6cf1ec6e6f4d5c443924757c486af67d1089aba`; its exact-head CI `verify` passed ([run 36742361543](https://github.com/ShabanovBoris/NightReviewer/actions/runs/36742361543)). The earlier D41 preflight invocation stopped before network access because local inputs were missing. D42's separate authorized replacement is recorded as a failed, consumed attempt in `docs/evidence/NR-02.json`.

## Historical decisions and evidence

Lead decisions D1–D40, cycle 1 source-audit material, DEV diagnostics, D3/D5/D6 procedures, and prior reviewer receipts remain preserved in the private session journal and evidence history. Their 6.1.1, shared-runtime handoff, connector `Codex Native2 NR-02`, and three-context acceptance assumptions are historical where they conflict with D40/D41. No earlier LIVE request, tool round-trip, cancellation receipt, or three-context result is promoted to current acceptance.

Финальная приёмка: NOT_REQUESTED. Release main SHA: отсутствует. PROJECT_ACCEPTED: отсутствует.
