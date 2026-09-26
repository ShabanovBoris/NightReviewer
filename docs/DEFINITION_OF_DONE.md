# Общий Definition of Done

Этот контракт дополняет каждое ТЗ. Локально выполненный код и merged PR — разные состояния.

## До review

- Lead assignment привязан к task/spec hash и актуальному base; prerequisites подтверждены evidence.
- Реализован scope и relevant AC; code diff ограничен задачей, public API/doc/schema согласованы.
- Выполнен `bun run verify` после появления команды в NR-01, плюс конкретные проверки из ТЗ. Неизвестная команда не считается доступной заранее.
- Evidence таблица содержит command, exit code, environment, tested SHA, artifact hash/URL; live отдельно от fake/contract.
- Errors/cancellation/limits, миграция и rollback покрыты там, где задача их меняет.
- Секреты и private raw не добавлены в Git; raw receipts сохранены локально, публичная копия редактирована.

## Перед merge

Reviewer выдал APPROVED для точных base/head/bundle hash; blocking findings закрыты им, coverage соответствует ТЗ. Lead выдал MERGE_AUTHORIZED на тот же tuple. GitHub checks и branch rules выполнены; approvals не перенесены на новый commit. Веб-approval — evidence в протоколе, не обход отдельного обязательного GitHub approval.

Критерии, которые физически возможны только **после merge** (merged state, resulting main smoke, TASK_COMPLETED, PROJECT_ACCEPTED), отмечаются `POST_MERGE_PENDING`. Reviewer проверяет готовность выполнить их и разрешает pre-merge часть, а не утверждает, что они уже выполнены. Задача остаётся незавершённой до post-merge проверки. Так приёмка не требует доказательства merge до самого merge.

## После merge

Проверить GitHub merged state, resulting main SHA, checks и artifact equivalence. Squash/rebase меняет SHA: approval относится к reviewed tuple, а release evidence — к resulting main; соответствие дерева кода и build inputs должно быть доказано. Конфликт, неожиданный diff или изменение build inputs требует нового review/checks. CI failure на main блокирует следующую зависимую задачу: corrective PR или revert по решению lead.

Отправить TASK_COMPLETED с ссылками на merged PR, evidence, выполненные AC и риски. Сохранить внешнюю receipt; не создавать unreviewed commit только для записи собственного approval.

## Review bundle

Manifest должен включать: repo/task/spec revision, base/head/diff-base, changed paths и полные нужные файлы, diff, команды/exit codes, test artifact hashes, known gaps, dependency PRs, scope/non-goals. Большие материалы передавать частями с hashes и confirmation полноты. Если reviewer не видит материалы, verdict CONTEXT_REQUIRED.

`bundleHash` связывает весь канонический `reviewContext` по DEVELOPMENT.md: ТЗ, AC, scope/non-goals, файлы/diff и evidence/decision digests, ограничения и fix context. Хеш только списка файлов недостаточен. Reviewer и lead повторяют ту же approval identity; изменение любого review input требует нового hash/verdict даже при неизменном head. READY и FIX_REVIEW_RESULT должны соответствовать явным схемам development protocol.

## Шаблон PR description

```text
Task: NR-XX / spec revision+hash / lead assignment ID
Problem: какой наблюдаемый сценарий не работал
Change: что изменено и какое поведение стало доступным
Scope: включено / не включено согласно ТЗ
Revision: base / head / diff-base / bundle hash
Acceptance: AC ID → evidence → PASS/FAIL/NOT_RUN/POST_MERGE_PENDING
Validation: command, exit code, environment, artifact reference
Risks and rollback: конкретные ограничения и шаги отката
Review: request ID, latest raw receipt reference; никакого self-approval
Post-merge: resulting main SHA/checks, TASK_COMPLETED reference (после merge)
```
