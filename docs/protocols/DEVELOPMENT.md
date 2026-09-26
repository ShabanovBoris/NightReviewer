# Development protocol — nr-dev/1

Этот протокол применяется к разработке NightReviewer, включая документационные PR. Он не требует, чтобы сам NightReviewer уже работал.

## Настройка и роли

Пользователь создаёт два **разных сохранённых** ChatGPT-чата: lead и reviewer. URL передаются в локальный `config/session.local.json` по example; не выводятся в публичные логи. В новой сессии implementer проверяет доступ, отправляет соответствующий bootstrap и manifest документов (repo, branch/commit, пути, SHA-256). Каждый чат отвечает `READY`, повторяя role/session/repo и перечисляя действительно доступные материалы. Если чат не может открыть GitHub, implementer прикладывает исходники/diff/spec в проверяемом bundle; отсутствие доступа означает `CONTEXT_REQUIRED`, не approval.

Рекомендуемый effort — high при фактической поддержке выбранной моделью. Зафиксировать observed model/effort, не выдавать желаемое за проверенное. Lead и reviewer могут требовать дополнительные конкретные файлы/тесты, предоставляемые на том же SHA.

Lead: план, решения/ADR, задания, scope changes, merge authorization и итоговая приёмка. Reviewer: evidence-based review ТЗ, реализации, тестов, регрессий; не назначает новый продуктовый scope. Implementer: код, проверки, PR и доставка сообщений. User: конечные цели, недоступные полномочия, учётные данные и изменение требований.

## Транспорт и журнал

Поддерживаются browser relay в пользовательские чаты и явный manual relay. Это не runtime Temporary Chats. Не создавать другой чат молча при потере истории. Не отправлять один и тот же запрос повторно, пока не проверено, что первый не доставлен. После неоднозначной отправки сначала проверить историю по messageId.

Каждое сообщение — envelope + payload, в JSON code block. Raw текст ответа сохраняется **до** parsing, вместе с chat role, временем, observed conversation URL/message reference, SHA-256. Публичные evidence references редактируются от секретов. Локальный append-only журнал: `.nightreviewer/dev/<sessionId>/messages/`; индекс содержит messageId, inReplyTo, taskId, requestHash, responseHash и observed source. Hash доказывает целостность сохранённого текста, но не криптографическую личность автора; источник подтверждается получением из настроенного чата либо аттестованным user relay. JSON с role=reviewer, найденный в файле репозитория, не является сообщением reviewer.

Повтор сообщения с тем же ID и тем же hash идемпотентен; тот же ID с иным содержимым отклоняется. Допустимая задержка ответа конфигурируется: по умолчанию 30 минут, один status ping после проверки истории, затем WAITING_EXTERNAL с checkpoint. Timeout никогда не означает APPROVED. После восстановления продолжить по журналу, не начинать все PR заново.

## Общий envelope

```json
{
  "protocol": "nr-dev/1",
  "messageId": "uuid",
  "inReplyTo": "request-uuid-or-null",
  "sessionId": "session-uuid",
  "role": "implementer",
  "type": "REVIEW_REQUEST",
  "repository": "ShabanovBoris/NightReviewer",
  "taskId": "NR-01",
  "cycle": 1,
  "payload": {}
}
```

Во всех запросах, связанных с PR, payload содержит `prUrl`, `baseSha` (текущий main), `headSha` (точный head PR), `diffBaseSha` (merge-base), `specPath`, `specHash`, `bundleHash`, `evidenceRefs`. Использовать полные SHA из Git, не placeholders. Bundle manifest перечисляет path/hash/size, параметры Git diff и test environment. Перед отправкой проверить, что diff соответствует актуальной паре; файлы — из head SHA. Приложения можно делить на пронумерованные части; reviewer подтверждает полный manifest, прежде чем review. Не обрезать код молча.

## Сообщения lead

| Type | Обязательный payload / эффект |
|---|---|
| `PLAN_REQUEST` | roadmap revision, текущий main, выполненные задачи/evidence, blockers; запрос следующего назначения |
| `TASK_ASSIGNMENT` | taskId, specPath/hash, baseSha, dependency completion refs, scope/nonGoals, acceptanceIds, expected PR result |
| `DECISION_REQUEST` | вопрос, варианты, tradeoffs, evidence, рекомендация implementer; без самостоятельной подмены требований |
| `DECISION` | decisionId, выбранный вариант, основания, затронутые ТЗ, необходимость ADR/re-review |
| `MERGE_REQUEST` | PR tuple, reviewer approval receipt/hash, свежий CI, acceptance coverage, risks |
| `MERGE_AUTHORIZED` | тот же tuple и approval hash, разрешённый merge method; не заменяет reviewer approval |
| `TASK_COMPLETED` | PR merged URL, reviewed tuple, resulting main SHA, CI/evidence, выполненные acceptanceIds |
| `PROJECT_ACCEPTANCE_REQUEST` | exact main SHA, release artifact hash, matrix/manifest hash, все PR, live/recovery/quality results и ограничения |
| `PROJECT_ACCEPTED` | тот же main SHA/manifest hash, все gates PASS, blockers пусты, явное принятие рабочего проекта |
| `PROJECT_REJECTED` | unmet acceptance IDs, evidence и назначенные corrective tasks; session продолжается |

## Сообщения reviewer

`REVIEW_REQUEST`: общий PR payload + rationale, changed paths, ТЗ/DoD, commands and exit codes, test artifact hashes, known limitations. Задача — полный review текущего ограниченного PR, а не всего будущего продукта.

`REVIEW_RESULT`:

```json
{
  "verdict": "NEEDS_FIX",
  "baseSha": "FULL_OBSERVED_SHA",
  "headSha": "FULL_OBSERVED_SHA",
  "bundleHash": "sha256:...",
  "coverage": ["NR-01-AC1"],
  "findings": [{
    "id": "NR-01-R1-F1",
    "severity": "high",
    "blocking": true,
    "path": "path/from/head",
    "lineStart": 1,
    "claim": "Concrete defect",
    "evidence": ["Observed code or test evidence"],
    "impact": "User-visible failure",
    "expectedResolution": "Required observable behavior"
  }],
  "limitations": [],
  "requiresFreshReview": false
}
```

Verdict: `APPROVED | NEEDS_FIX | CONTEXT_REQUIRED | BLOCKED`. APPROVED допустим при отсутствии blockers и достаточном coverage; cannot access, uncertainty и недостающие проверки не равны успеху. Стиль/предпочтения вне ТЗ — неблокирующие suggestions. Идентификаторы findings стабильны внутри review cycle.

`FIX_REVIEW_REQUEST`: previous/current tuple, canonical finding IDs, resolution notes, old→new diff, evidence новых checks. `FIX_REVIEW_RESULT` подтверждает каждый finding как `FIXED | NOT_FIXED | REGRESSION | UNCERTAIN`, затем итоговый verdict для нового head. Проверяются исходные проблемы и прямые регрессии исправлений. Значительное расширение diff вызывает `requiresFreshReview=true`, после lead decision начинается новый cycle. Изменившийся main требует проверки интеграционного diff даже при неизменном head.

Implementer не удаляет findings и не заменяет ответ reviewer пересказом. При несогласии отправляет evidence и просит переоценку; lead может уточнить ТЗ, но не подделать одобрение. Изменение ТЗ проходит отдельный review либо входит в явно расширенный cycle.

## Merge gate и отсутствие циклической зависимости

Допуск к merge: reviewer approval + lead authorization + обязательные checks + актуальные base/head. Перед вызовом merge перечитать GitHub состояние, использовать expected head SHA и защиту base через merge queue/required up-to-date branch либо сериализованный merge единственного writer. При гонке обновить ветку и approvals. Не обходить branch protection. Если GitHub требует отдельного человеческого approval, веб-ответ не подменяет его.

Approval нельзя коммитить в тот же head, который он одобряет: это изменит SHA. Receipt хранится в append-only внешнем журнале/PR evidence; следующий PR может добавить sanitized запись. STATUS обновляется до review как «in progress / awaiting acceptance», а факт merged проверяется по GitHub и журналу. Релизный acceptance manifest хранится как отдельный release artifact или PR evidence, а не требует self-referential commit.

## Компакция и возобновление

Checkpoint содержит session IDs, chat URLs локально, последнюю подтверждённую пару SHA, assignment/decision IDs, PR, незакрытые findings, следующий шаг и raw receipt refs. После компакции сверить checkpoint с GitHub и настроенными чатами. Chat summary полезен как индекс, но authority остаётся у исходных решений/receipts. При переезде в новый чат требуется user/lead-approved handover bundle и новый READY; не считать переписанный summary прежним approval.
