# Runtime protocol — nr-review/1 (design contract)

Это требования к реализации NR-03; здесь нет утверждения, что API уже доступен. Schema draft выбирается и закрепляется NR-03; runtime validation и exported JSON Schema должны совпадать.

## Implementer MCP

| Tool | Input | Result |
|---|---|---|
| `review_submit` | repoId из allowlist, baseSha, headSha, task, acceptanceCriteria[], profile, idempotencyKey | reviewId, cycleId, headSha, state |
| `review_status` | reviewId, optional cursor | bound revisions, state, progress, findings, coverage, nextAction, typed errors, paged events |
| `review_submit_fix` | reviewId, previousSha, headSha, resolutions[{findingId,note}], idempotencyKey | fixId, cycleId, state |
| `review_cancel` | reviewId, reason, idempotencyKey | cancellation state |

repoId разрешается в локальной конфигурации; произвольный путь клиента не становится доступом к filesystem. SHA разрешаются в полные commit IDs и фиксируются на submit. Для fix по умолчанию new head должен быть потомком previous; history rewrite требует нового cycle. previous должен совпадать с текущей ожидаемой ревизией, иначе CONFLICT. Повтор idempotencyKey с другим normalized input — CONFLICT; с тем же — исходный ID/result. Клиентский disconnect не отменяет review автоматически.

Errors: `INVALID_ARGUMENT`, `NOT_FOUND`, `FORBIDDEN`, `CONFLICT`, `RESOURCE_EXHAUSTED`, `BACKEND_UNAVAILABLE`, `AUTH_REQUIRED`, `RATE_LIMITED`, `CONTEXT_TOO_LARGE`, `SCHEMA_INVALID`, `NEEDS_RECONCILIATION`, `INTERNAL_ERROR`. У ошибки есть safe message, retryable, retryAfter при наличии, correlationId. Не возвращать стек с секретами.

## Review states

| State | Allowed next / condition |
|---|---|
| QUEUED | SNAPSHOTTING, CANCEL_REQUESTED, FAILED |
| SNAPSHOTTING | REVIEWING после durable manifest; FAILED/CANCEL_REQUESTED |
| REVIEWING | AGGREGATING при полном наборе valid runs; PAUSED/FAILED/CANCEL_REQUESTED |
| AGGREGATING | APPROVED либо NEEDS_FIX после всех adjudicators; PAUSED/FAILED/CANCEL_REQUESTED |
| NEEDS_FIX | VERIFYING_FIX после atomic validated fix submission; CANCEL_REQUESTED |
| VERIFYING_FIX | APPROVED, NEEDS_FIX, REQUIRES_FRESH_REVIEW, PAUSED, FAILED, CANCEL_REQUESTED |
| PAUSED | Сохранённая стадия после устранения причины; FAILED/CANCEL_REQUESTED |
| REQUIRES_FRESH_REVIEW | Новый child cycle по explicit submit; исходный остаётся без approval |
| CANCEL_REQUESTED | CANCELLED после fencing/revocation; late results audit-only |
| APPROVED / FAILED / CANCELLED | Terminal для cycle; retry/review создаёт явный новый cycle/attempt согласно policy |

State/version обновляются CAS в транзакции, event и outbox вместе. PAUSED хранит reason/resumeStage; in-flight неоднозначность — PAUSED с NEEDS_RECONCILIATION. Рестарт не меняет FAILED на APPROVED. Terminal events идемпотентны. Конфликт fix/cancel/retry разрешается одним победителем CAS.

## Context MCP

`review_context_manifest`, `review_context_diff`, `review_context_read_file`, `review_context_search`, `review_context_list_files`, `review_context_test_results`.

Run binding: reviewId/cycleId/runId/attemptId, role, direction, snapshotId, base/head, expiry, разрешённые tools. Capability — opaque secret, короткий срок, revoke при cancel/finish; сервер проверяет его на каждом вызове. Клиент не может выбрать другой review или SHA. Версия файла `base|head` выбирается только внутри bound pair; fix verifier также имеет заранее bound previous/new pair. Reviewer не видит чужие outputs, adjudicator видит только свои input reports и context. Запрещены absolute paths, `..`, NUL, symlink escapes, Git option injection и подмена capability.

Каждый tool ограничивает bytes/lines/results, возвращает cursor/total/truncated и snapshot identity. Missing binary/LFS/submodule content явно отражается в coverage; нельзя молча пропустить файл и одобрить. Search bounded literal by default; regex только при гарантированном time limit. Test results включают commit SHA, command, exit code, timestamps, environment, producer и artifact hash; пользовательские assertions не выдаются за выполненные сервисом проверки.

NR-06 core принимает только literal UTF-8 search; запрос `mode="regex"` возвращает `INVALID_ARGUMENT`. Regex остаётся выключенным, пока реализация не сможет гарантировать отдельный жёсткий time bound. `review_context_test_results` читает только отчёты, связанные с текущей capability; ingest разрешён только reviewer run в направлении `tests`, проверяет точные байты по SHA-256 и размеру, затем сохраняет отчёт как raw artifact этого attempt. Схема `nr-test-result/1`: `schemaVersion`, `commitSha`, `command`, `exitCode`, `startedAtUtc`, `finishedAtUtc`, `environment{os,arch,runtime,runtimeVersion,ci}`, `producer`. Producer и environment — утверждения отправителя; результат всегда имеет `executionTrust="UNVERIFIED"`, а commit вне выбранной snapshot-пары помечается stale.

## Worker output

Envelope: schemaVersion, reviewId/cycleId/runId/attemptId, reviewedBaseSha/headSha, promptHash, coverage{paths,limitations}, verdict `FINDINGS|NO_FINDINGS|INCOMPLETE`, findings[]. Finding: localId, severity (`critical|high|medium|low`), title, claim, evidence[] (path/revision/line range или test artifact), impact, location, optional reproduction/suggestedFix/confidence. Evidence непустой для каждого finding. NO_FINDINGS допускается только после complete coverage; response parsing не угадывает отсутствующие поля. Confidence не является вероятностью истинности и не заменяет validation.

Raw result сохраняется прежде JSON parsing. При malformed output допускается один schema-repair attempt с сохранённым оригиналом и тем же binding; semantic mismatch требует обычного retry policy. Не добавлять вымышленные evidence при repair. Каждый attempt имеет отдельную запись; selected successful attempt единственный участвует в adjudication.

## Canonicalization и fix

Canonical finding имеет стабильный ID, direction, evidence, blocking policy, sources[{runId,attemptId,localId}], validation `CONFIRMED|REJECTED|UNCERTAIN`, rationale. Для **каждого** raw candidate нужен adjudication disposition и provenance: отсутствие у остальных reviewer-ов не основание rejection. Межнаправленные дубли можно link-овать, но нельзя терять владельца проверки.

Fix verification: input immutable old/new snapshots, canonical findings, resolution notes; output по каждому ID `FIXED|NOT_FIXED|REGRESSION|UNCERTAIN`, evidence и requiresFreshReview. Каждое направление проверяет также непосредственный fix diff, даже если ранее не имело findings. Регрессия получает новый ID и связь с fix. Крупный diff/смена scope → REQUIRES_FRESH_REVIEW по versioned policy, решение хранится.

APPROVED только при полном наборе успешно проверенных обязательных runs/adjudications, отсутствии unresolved uncertainty/coverage gap и confirmed blockers, валидных bindings и полном provenance. Approval record содержит exact head SHA, manifestHash, policyVersion/hash, timestamp и evidence digest; для нового SHA не переносится.
