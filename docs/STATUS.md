# Реестр реализации

Источник истины выполнения — merged state GitHub и receipt ledger. NR-01…NR-20 остаются отдельными bounded PR; документация сама по себе не означает реализацию или приёмку.

| Task | Status | PR / evidence |
|---|---|---|
| NR-01 | COMPLETE | [PR #2](https://github.com/ShabanovBoris/NightReviewer/pull/2), merged main e9e7812ff4058ce9fc1184e7275be2ebdcd99588; lead acceptance c842056b-9571-4f04-8f42-f3b96863f54d; resulting-main CI 36325969092 |
| NR-02 | IN_PROGRESS — cycle 2 D41 runner/docs adaptation; LIVE evidence pending | [PR #3](https://github.com/ShabanovBoris/NightReviewer/pull/3); assignment NR-02-C2-LIVE-613-MINIMUM-WORKING-BRIDGE; branch nr-02-chatgpt-web-spike; base e9e7812ff4058ce9fc1184e7275be2ebdcd99588; D41 assignment head cc9e7c5fcfb0ca50c97022cd821afe30faf0b04e |
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

## NR-02 current cycle 2 — D41

Lead D40 selects the current Codex Web GPT 6.1.3 production baseline and existing production tunnel. D41 corrects connector selection: unchanged production `config.appName` selects `Codex Native2`. Auxiliary `Codex Native2 NR-02` remains `KEEP_UNCHANGED` and is not used. No downtime, runtime/tunnel/config/connector change, new Tunnel ID/key, or DEV work is authorized or required.

Current state:
- Production 6.1.3 baseline: Lead-reported `PASS_READY`; the independent fixture callback is not yet observed.
- Selected production connector: `Codex Native2`, based on D41's source-checked exact `config.appName`; route binding is not independently proven by a tool receipt.
- Auxiliary `Codex Native2 NR-02`: unchanged and unused for D41 acceptance.
- AC1: `NOT_RUN`.
- AC2: `PARTIALLY_AUTHORIZED`, `NOT_RUN`; at most one bounded cancellation is authorized after gates. The unavailable connector/tool subcheck is not authorized and remains `NOT_RUN`.
- AC3: `DEFERRED_HARDENING`; do not run the former three-context matrix.
- AC4: `PASS_DOCUMENTATION_ONLY` after the D41 documentation consistency audit and local deterministic verification; this does not satisfy AC1/AC2.
- Reviewer cycle 1: `BLOCKED`, `NR-02-R1-F1 NOT_FIXED`; no cycle 2 reviewer approval.
- Merge authorization: `NOT_GRANTED`.

Phase A adapts the runner and documentation with local checks only. Phase B starts only after the exact adaptation is pushed and GitHub CI `verify` succeeds: one read-only preflight, then at most one AC1 and one cancellation. The runner's preflight requires exact version `6.1.3`, stable service identity, authenticated model catalog/high effort and zero active HTTP/browser turns at both health observations. A normal one-shot tool approval is limited to the currently authorized operation; any request for persistent permission or connector setting change is a stop condition.

## Historical decisions and evidence

Lead decisions D1–D40, cycle 1 source-audit material, DEV diagnostics, D3/D5/D6 procedures, and prior reviewer receipts remain preserved in the private session journal and evidence history. Their 6.1.1, shared-runtime handoff, connector `Codex Native2 NR-02`, and three-context acceptance assumptions are historical where they conflict with D40/D41. No earlier LIVE request, tool round-trip, cancellation receipt, or three-context result is promoted to current acceptance.

Финальная приёмка: NOT_REQUESTED. Release main SHA: отсутствует. PROJECT_ACCEPTED: отсутствует.
