# Реестр реализации

Источник истины выполнения — merged state GitHub и receipt ledger. NR-01…NR-20 остаются отдельными bounded PR; документация сама по себе не означает реализацию или приёмку.

| Task | Status | PR / evidence |
|---|---|---|
| NR-01 | COMPLETE | [PR #2](https://github.com/ShabanovBoris/NightReviewer/pull/2), merged main e9e7812ff4058ce9fc1184e7275be2ebdcd99588; lead acceptance c842056b-9571-4f04-8f42-f3b96863f54d; resulting-main CI 36325969092 |
| NR-02 | COMPLETE — Lead D109 accepted; AC3 remains deferred non-blocking hardening | [PR #3](https://github.com/ShabanovBoris/NightReviewer/pull/3), merge/resulting main `be3efa9c39e8215a1c984ad9d7d37ce50e38896e` |
| NR-03 | COMPLETE — Lead D114 accepted | [PR #4](https://github.com/ShabanovBoris/NightReviewer/pull/4), merge/resulting `main` `c0a70dcc6e46e5fec0f37751c7abb0f724e73c93`; resulting-main CI 37109137657 succeeded |
| NR-04 | COMPLETE — Lead D120 accepted | [PR #5](https://github.com/ShabanovBoris/NightReviewer/pull/5), merged `main` `8c38e07a351f81ff602d02f0191bacc9ef77b366`; resulting-main CI 37144869002; [local evidence](evidence/NR-04.json) |
| NR-05 | COMPLETE — Lead D123 accepted | [PR #6](https://github.com/ShabanovBoris/NightReviewer/pull/6), merged `main` `bac217d5f96f0fe47f222f45acb643a9b05206a7`; resulting-main CI 37161382656; [evidence index](evidence/NR-05.json) |
| NR-06 | IN_PROGRESS — D124 assignment; reviewer finding R1-F1 fixed, exact-head fix review pending | [PR #7](https://github.com/ShabanovBoris/NightReviewer/pull/7), branch `nr-06-bounded-readonly-review-context`, base `bac217d5f96f0fe47f222f45acb643a9b05206a7`; LFS-pointer fix commit `a535c6adb8d8033e922f6c0a24318f6c7b1d8003` passed exact-head CI 37196325348 |
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

## Accepted completion: NR-02 — Lead D109

Lead decision `NR-02-D109-TASK-COMPLETION-ACCEPTED` accepts PR #3 at reviewed base `e9e7812ff4058ce9fc1184e7275be2ebdcd99588` and head `18b079e6c5dd930f510fa6bd78647be6d9269533`, bundle `sha256:f55b618473323fdd137387339312d22a28a355cc49cf60388f3b3cd3e1b15323`. The merge commit and resulting `main` are `be3efa9c39e8215a1c984ad9d7d37ce50e38896e`; reviewed-head CI `37055467239` and resulting-main CI `37074470542` succeeded. Lead acceptance records AC1, AC2 cancellation, AC2 unavailable and AC4 as reviewed pass; AC3 remains `DEFERRED_HARDENING_NON_BLOCKING`. This deferred item is not implicitly activated. NR-02 requires no further action.

## Accepted dependency: NR-03 — Lead D114

Lead D114 accepted NR-03 after PR #4 merged to `main` at `c0a70dcc6e46e5fec0f37751c7abb0f724e73c93`. The resulting-main workflow run `37109137657` completed successfully. This verified dependency enables NR-04.

## Accepted dependency: NR-04 — Lead D120

Lead D120 accepted NR-04 after PR #5 merged to `main` at `8c38e07a351f81ff602d02f0191bacc9ef77b366`. The resulting-main workflow run `37144869002` succeeded. The original implementation evidence remains at [docs/evidence/NR-04.json](evidence/NR-04.json).

## Accepted dependency: NR-05 — Lead D123

Lead D123 accepted NR-05 after PR #6 merged to `main` at `bac217d5f96f0fe47f222f45acb643a9b05206a7`. The merged PR head was `f83f129427709a60e64b39e8fddbcd5384d99a93` on base `8c38e07a351f81ff602d02f0191bacc9ef77b366`; resulting-main CI 37161382656 succeeded. The acceptance receipt and implementation evidence are indexed in [docs/evidence/NR-05.json](evidence/NR-05.json).

## Current assignment: NR-06 — D124

Assignment `NR-06-C1-D124-BOUNDED-READONLY-REVIEW-CONTEXT` starts from exact `main` base `bac217d5f96f0fe47f222f45acb643a9b05206a7`, on feature branch `nr-06-bounded-readonly-review-context`. Roadmap `docs/ROADMAP.md` is bound to SHA-256 `54ea2e6c1c4149b4e8671a969dbac65d2a7087b072177ad9cb8a94244b517e15`; spec `docs/specs/NR-06.md` is bound to SHA-256 `b7abaeb94377063a2477dbaf608ea44a5f5408592df2e802b67a992bf68d92c5`; task `docs/tasks/NR-06.md` is bound to SHA-256 `18c8088c4b008291d05e55b7c1ec559b411e37727d4b27b30620258639d816a2`. D124 starts NR-06 after accepted NR-05. The initial correlated review returned `NEEDS_FIX` for `NR-06-R1-F1`: unchanged LFS pointer blobs could appear as available text. The fix in `a535c6adb8d8033e922f6c0a24318f6c7b1d8003` classifies pointers explicitly, reports inspection-budget skips, and adds list/read/search regression coverage; exact-head CI run 37196325348 succeeded on Bun 1.4.2. Fresh readiness and reviewer fix verification for the changed revision are pending. No final reviewer approval, merge authorization, or task completion is claimed. See [docs/evidence/NR-06.json](evidence/NR-06.json).

## Historical record: NR-02 cycle 2 — D105 snapshot (before D109)

Lead D105 was bound to PR #3, base `e9e7812ff4058ce9fc1184e7275be2ebdcd99588`, starting head `08f0951b0692ebe60deb84b999eaa935b7aa3180`, and the NR-02 spec revision supplied with that assignment. Its offline evidence audit found a qualifying D66 AC1 round-trip receipt and D67 cancellation receipt. At that point they remained `PASS_LIVE_PENDING_INDEPENDENT_REVIEW`; neither was final acceptance. The original D66/D67 receipts and D100 pre-health files remain immutable in the private session evidence store.

At the D105 snapshot, acceptance state was: AC1 `PASS_LIVE_PENDING_INDEPENDENT_REVIEW`; AC2 cancellation `PASS_LIVE_PENDING_INDEPENDENT_REVIEW`; AC2 unavailable `PENDING_INDEPENDENT_REVIEW_OF_REVISED_CONTRACT_AND_D100_EVIDENCE`; AC2 overall `INCOMPLETE`; AC3 `DEFERRED_HARDENING`; AC4 `PASS_DOCUMENTATION_ONLY_PENDING_INDEPENDENT_REVIEW`. Reviewer bootstrap and one fix review were conditionally authorized after D105 publication, exact-head CI, and final review-context construction. Merge was not authorized. D105 permitted no new LIVE, runtime, browser, connector, tunnel, or credential action.

### Operative AC2-unavailable contract from D102

Lead D102 is bound to PR #3 base `e9e7812ff4058ce9fc1184e7275be2ebdcd99588`, starting head `323ec1f142b59fe04f2c1b34666c7c2fe08512c3`, and spec hash `e1475e7deffd4063c87bcfdd51f2e05b3e0f001349b39b83334f92baf5bfc6dd`. It formally replaces the numeric `error.status=424` AC2-unavailable gate with the pinned 6.1.3 observable SSE fields `response.failed`, `response.status="failed"`, `error.type=connector_error`, and `error.code=connector_not_found`, while retaining complete-stream, no-tool/no-continuation, exact pre/post identity, and idle-health guards.

D100's sole LIVE request is consumed as `D100_UNAVAILABLE_OUTCOME_MISMATCH` with `acceptanceCredit=NONE`; it will not be retried. D101 shows the old parser's `502` was a local fallback. D102 authorizes an offline parser/runner/test/docs correction, frozen-D100 reevaluation as a candidate for independent review, commit/push to the existing PR #3 branch, PR narrative update, and exact-head CI. It authorizes no runtime, bridge, browser, connector, fixture, tunnel, or credential action.

At the time of D102, AC1 and cancellation were already recorded as pending independent review, AC2 overall was incomplete, and reviewer-request authorization had not been granted. D105 supplies the qualifying D66/D67 receipts and governs the current reviewer step above.

The preserved D99B isolated broker PID `54713` / port `4181`, authenticated D97 development Electron PID `49134`, and protected PID `11169` are outside D102 scope and must remain unchanged.

## Historical implementation context — D53–D56

Lead D56 requires NR-02 AC1 to traverse the ChatGPT-Web browser adapter on the existing production Codex Web GPT runtime `6.1.3` and unchanged connector `Codex Native2`, selected by production `config.appName`. The runtime version and routed browser model are distinct: the only assigned AC1 route is `chatgpt-web/gpt-5.6-sol` with `high` reasoning. AC1–AC4 are unchanged.

Historical state at D53/D56:
- D53's one AC1 invocation was consumed. Its health and catalog guards passed; its initial `/v1/responses` call returned HTTP 400 before any tool call, fixture read, or continuation. That attempt had no acceptance credit; the later qualifying D66 receipt now sets current AC1 status to `PASS_LIVE_PENDING_INDEPENDENT_REVIEW`.
- D55 classifies the 400 as `NON_REQUEST_CONTRACT_400`: `gpt-6.1-sol` selects the native passthrough in upstream 6.1.3, not the browser adapter. The exact downstream 400 cause is unknown and is not attributed to the model-routing discrepancy.
- D56 authorized offline route remediation, deterministic tests, documentation, commit/push to the existing PR #3 branch, PR narrative update, and exact-head CI. It required rejecting every model except `chatgpt-web/gpt-5.6-sol` before network-capable execution, verifying that exact catalog row advertises `high`, and recording the route/effort in sanitized stage evidence.
- D52 durable evidence capture remains in place. D56 authorizes no production HTTP, connector call, LIVE retry, cancellation, unavailable-connector/tool probe, AC3 matrix, DEV operation, or production/DEV runtime, tunnel, connector, credential, permission, or configuration change.
- At D56, AC2 cancellation was `NOT_RUN`; D67 later supplied a qualifying cancellation receipt pending independent review. The unavailable connector/tool remains pending review of the D102 contract and frozen D100 evidence. AC3 remains `DEFERRED_HARDENING`; AC4 remains documentation-only and pending independent review.
- At D56, reviewer request was not authorized and merge authorization had not been granted. D105 now conditionally authorizes one fresh reviewer bootstrap and fix review after publication, exact-head CI, and context finalization; merge remains unauthorized.

D52 requires a stable run ID and exact PR head before any network-capable child stage; synchronously flushed events for attempts before their side effects; distinct request-attempt and response-receipt stages; a terminal success/failure with the last proven stage; exact UTC start/finish and child exit code/signal; and host-native private capture of complete stdout/stderr. The wrapper precreates owner-only artifacts before child spawn, stores raw streams only under ignored `.nightreviewer/`, and returns a sanitized receipt with hashes, byte counts, allowlisted metadata and terminal classification. A missing, malformed, reordered, unsafe or incomplete ledger fails closed.

The D56 offline verification covered route rejection before the first fetch, canonical settings, catalog/high reasoning, simulated request preservation, route evidence, and zero real fetches. Those checks did not establish AC1; the later D66 LIVE receipt is the evidence now pending independent review. D105 supersedes D56's next-step instructions: publish the status/evidence correction, obtain exact-head CI, finalize the new context, and perform only the conditionally authorized reviewer bootstrap and fix review. No new LIVE attempt is authorized.

D49–D56 source receipts and the D53/D55 route findings are recorded in the private session ledger and summarized in `docs/evidence/NR-02.json`. D43's catalog correction and earlier CI remain historical; they do not verify the D56 head.

## Historical decisions and evidence

Lead decisions D1–D40, cycle 1 source-audit material, DEV diagnostics, D3/D5/D6 procedures, and prior reviewer receipts remain preserved in the private session journal and evidence history. Their 6.1.1, shared-runtime handoff, connector `Codex Native2 NR-02`, and three-context acceptance assumptions are historical where they conflict with D40/D41. No earlier LIVE request, tool round-trip, cancellation receipt, or three-context result is promoted to current acceptance.

Финальная приёмка: NOT_REQUESTED. Release main SHA: отсутствует. PROJECT_ACCEPTED: отсутствует.
