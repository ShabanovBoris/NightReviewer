# Реестр реализации

Исходный статус: подготовлены только план и задания; продукт не реализован и не принят.

Источник истины выполнения — GitHub merged state + development receipt ledger, не галочка автора. В task PR обновлять planned/in-progress/evidence refs до финального review. Факт merge отражать в следующем reviewable обновлении либо external ledger, чтобы не менять одобренный SHA ради self-referential отчёта.

| Task | Status | PR / evidence |
|---|---|---|
| NR-01 | COMPLETE | [PR #2](https://github.com/ShabanovBoris/NightReviewer/pull/2), merged main `e9e7812ff4058ce9fc1184e7275be2ebdcd99588`; lead receipt `c842056b-9571-4f04-8f42-f3b96863f54d`; resulting-main CI run `36325969092` |
| NR-02 | IN_PROGRESS | lead assignment `7f7e2cc4-12a6-44c9-84e6-e50a0c2ff3be`; branch `nr-02-chatgpt-web-spike`; D3 keeps the isolated production-profile 6.1.1 route for qualifying live tests. The user and lead allow ordinary DEV for NightReviewer development, but `purpose=dev-harness` still cannot own `/v1/responses`. Current DEV status is `mcpRuntime.ready=false`; the launcher-owned tunnel has no standalone system service. Supported `dev setup --full` stopped before prompt/config save because the launcher ChatGPT session could not be verified. The unique `Codex Native2 NR-02` connector is absent. Lead D5 authorizes one isolated temporary `appName`/`automaticAppName` override to probe a deliberately nonexistent connector, followed by mandatory restoration and health verification; the probe has not run. AC1–AC3 remain blocked, and AC4 is in progress until its ADR records the actual D5 result. |
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

Session prerequisites: lead and reviewer returned READY for `main@e9e7812ff4058ce9fc1184e7275be2ebdcd99588`; ignored local config contains two different chat URLs; project Bun 1.4.2 and `config:doctor` are verified on macOS arm64; qualifying live bridge/model capabilities remain NOT_VERIFIED.

Lead decision `NR-02-D3-ALLOW-ISOLATED-6_1_1-PRODUCTION-SPIKE` remains the qualifying live route. The user later authorized the ordinary DEV contour for all NightReviewer development, and lead acknowledged that persistent permission. This broadens where DEV may be used for development and diagnostics; it does not change qualification rules. The exact-pin `purpose=dev-harness` profile still cannot start a Responses listener, and simulated receipts do not satisfy NR-02 AC1–AC3. Current local `dev status` reports `mcpRuntime.ready=false` / `state=starting`. DEV tunnel lifecycle is owned by the launcher supervisor, so a standalone `tunnel restart` command is not applicable. The supported `dev setup --full` attempt stopped before configuration was saved because the launcher ChatGPT session could not be verified. The `Codex Native2 NR-02` connector is still absent from ChatGPT settings. AC1–AC3 remain blocked; AC4's documentation criteria pass; the task remains in progress.

Lead decision `NR-02-D5-TEMPORARY-ISOLATED-MISSING-CONNECTOR-PROBE` permits one unavailable-connector LIVE probe only after the isolated D3 6.1.1 profile is healthy with its normal unique connector identity. The probe may temporarily change only the isolated config's `appName` and `automaticAppName` to a unique nonexistent identity, then must restore both values and verify parser, identity, and health. It does not authorize external permission, tunnel, or credential changes. The unique connector is not installed; its action-time Create confirmation remains pending. No D5 probe has run, so AC2 is still blocked and AC4 remains in progress pending the ADR result.

Lead decision `NR-02-D6-ACK-PLUS-CORRELATED-STREAM-TERMINATION` defines cancellation qualification as the exact control acknowledgement (`HTTP 200`, `status=ok`, `cancelled_http_turns=1`) plus termination of the correlated non-completed stream between acknowledgement receipt and 10 seconds later. The harness preserves the actual SSE/read disposition, rejects a prior or later `response.completed`, and never counts its own timeout abort as cancellation evidence; D6 does not authorize a live probe. No D3 profile or cancellation receipt exists, so AC2 remains blocked and AC4 remains in progress.

Final acceptance: NOT_REQUESTED. Main release SHA: отсутствует. PROJECT_ACCEPTED: отсутствует.
