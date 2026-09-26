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

Во всех запросах, связанных с PR, payload содержит `prUrl`, `baseSha` (текущий main), `headSha` (точный head PR), `diffBaseSha` (merge-base), `specPath`, `specHash`, `bundleHash`, `evidenceRefs`. Использовать полные SHA из Git, не placeholders. REVIEW_REQUEST и FIX_REVIEW_REQUEST также передают полный `reviewContext`, определённый ниже. Повторённые поля должны точно совпадать с ним; несовпадение отклоняется. Перед отправкой проверить, что diff соответствует актуальной паре; файлы — из head SHA. Приложения можно делить на пронумерованные части; reviewer подтверждает полный manifest, прежде чем review. Не обрезать код молча.

### Каноническая идентичность review context

`bundleHash` = `sha256:` + lowercase hex SHA-256 канонических UTF-8 bytes **всего reviewContext**, а не только списка файлов или архива. `reviewContext` содержит все обязательные поля:

- `schemaVersion` = `nr-review-context/1`, `repository`, `sessionId`, `taskId`, `cycle`, `prUrl`;
- `baseSha`, `headSha`, `diffBaseSha`, `specPath`, `specHash` (SHA-256 точных bytes ТЗ);
- `acceptanceCriteria` (массив `{id, requirement}`), `scope`, `nonGoals`, `knownLimitations` (массивы строк);
- `files` (массив `{path, revision, sha256, size}` для всех изменённых и всех дополнительно прочитанных нормативных/context файлов; size в bytes);
- `diffs` (массив `{id, baseSha, headSha, parameters, sha256, size}` для точных bytes переданных diff artifacts);
- `evidence` (массив `{id, sha256, size}`), `dependencyRefs` и `decisionRefs` (массивы `{id, sha256, size}` для точных bytes evidence/receipt artifacts). Каждый command, exit code, environment, testedSha, PASS/FAIL/NOT_RUN, limitation и AC mapping находится внутри этих хешированных artifacts или самого reviewContext. Одних mutable URL недостаточно;
- `fixContext`: `null` для initial review, иначе `{previousTuple, findingIds, resolutionNotes}`; previousTuple содержит `prUrl`, `baseSha`, `headSha`, `bundleHash`, а resolutionNotes — массив `{id, note}`. Old→new diff и новые checks входят в `diffs`/`evidence` текущего context.

Все поля обязательны; пустые массивы допустимы только когда данных действительно нет. Неизвестные поля и duplicate object keys отклоняются. Object keys — ASCII identifiers; сериализация рекурсивно сортирует их в ASCII порядке, сохраняет порядок массивов и значения строк без Unicode normalization, не добавляет пробелы/BOM/final newline. Строки сериализуются по JSON.stringify (Unicode scalars, без lone surrogates), числа допускаются только неотрицательные safe integers; undefined, NaN, Infinity и -0 запрещены. SHA-256/size считаются по исходным bytes артефактов, не по отрендеренному Markdown. Review context не включает собственный hash, transport messageId, будущий approval или сам себя как artifact: циклических hashes нет. Например `{ "b": 2, "a": "x" }` сериализуется точно как `{"a":"x","b":2}`.

`evidenceRefs` — только transport locations для artifacts, перечисленных по id/digest в context. Reviewer до verdict пересчитывает bundleHash и сверяет artifact hashes/sizes; недоступный artifact даёт CONTEXT_REQUIRED, mismatch — BLOCKED. Никакая дополнительная acceptance-changing информация вне context не может молча участвовать в approval: сначала новый context/hash и review. Исправление evidence, ТЗ, scope, AC, limitations или решений меняет bundleHash даже при неизменном Git SHA и требует нового verdict. Отдельный `requestHash` журнала связывает доставку envelope, но не заменяет bundleHash.

Approval identity: `(repository, sessionId, taskId, cycle, prUrl, baseSha, headSha, bundleHash)`. REVIEW_RESULT, FIX_REVIEW_RESULT, MERGE_REQUEST и MERGE_AUTHORIZED повторяют эту identity (общие поля — в envelope); MERGE_AUTHORIZED дополнительно связывает SHA-256 исходного reviewer receipt и merge method. Lead/implementer перепроверяют hashes/correlation и совпадение context; старый approval к новому context не переносится. Свежая проверка GitHub checks перед merge остаётся обязательной; если новый check artifact меняет основания review, обновить context и получить новый verdict, а не только merge authorization.

### Bootstrap request и READY

Implementer посылает `type=BOOTSTRAP_REQUEST`, `taskId=null`, `cycle=0`, `inReplyTo=null` с payload `{targetRole, revision, documents, target, constraints}`. targetRole — `lead|reviewer`; revision — exact commit; documents — массив `{path, sha256, size}`; target — строка, constraints — массив строк. Каждый role получает отдельный messageId при одном sessionId. READY не является approval. Частично доступные материалы дают `type=CONTEXT_REQUIRED` с тем же correlation и payload `{revision, missingDocuments, reason}`, а не READY.

READY использует envelope ниже; все поля обязательны. messageId — новый UUID, inReplyTo — точный BOOTSTRAP_REQUEST.messageId, sessionId/repository повторяются без изменений, role соответствует targetRole, taskId=null и cycle=0 обозначают bootstrap вне task review. documentsAvailableAndRead содержит только действительно прочитанные документы из request; хеши сверены. missingPrerequisites описывает внешние условия, которые не препятствуют чтению (например, будущий live setup).

```json
{
  "protocol": "nr-dev/1",
  "messageId": "READY_UUID",
  "inReplyTo": "BOOTSTRAP_REQUEST_UUID",
  "sessionId": "SESSION_UUID",
  "role": "reviewer",
  "type": "READY",
  "repository": "owner/repo",
  "taskId": null,
  "cycle": 0,
  "payload": {
    "revision": "FULL_COMMIT_SHA",
    "documentsAvailableAndRead": [{"path": "AGENTS.md", "sha256": "64_LOWERCASE_HEX", "size": 1}],
    "understoodTarget": "Working stable v1 with exact-SHA lead acceptance",
    "understoodConstraints": ["Separate lead/reviewer authorities"],
    "missingPrerequisites": []
  }
}
```

Значения UUID/SHA/size в примерах — метасинтаксис; в реальной отправке требуются наблюдённые значения. При изменении session/revision bootstrap проводится заново без удаления старых receipts; старые task decisions остаются в журнале, но не становятся READY для нового revision.

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

`REVIEW_RESULT.payload` (в общем envelope с role=reviewer и inReplyTo точного REVIEW_REQUEST):

```json
{
  "verdict": "NEEDS_FIX",
  "prUrl": "PR_URL",
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

FIX_REVIEW_REQUEST.payload содержит `previousTuple`, `currentTuple`, `findingIds`, `resolutionNotes`, `reviewContext`, `evidenceRefs` плюс общие PR fields. Tuple = `{prUrl, baseSha, headSha, bundleHash}`. currentTuple соответствует общим PR fields и reviewContext; previousTuple/findingIds/resolutionNotes совпадают с reviewContext.fixContext. findingIds — все открытые blockers и остальные findings, заявленные к повторной проверке; ID не переименовываются. Старый receipt прикладывается как хешированный evidence artifact. Ответ имеет точную форму ниже; все поля обязательны:

```json
{
  "protocol": "nr-dev/1",
  "messageId": "FIX_RESULT_UUID",
  "inReplyTo": "FIX_REQUEST_UUID",
  "sessionId": "SESSION_UUID",
  "role": "reviewer",
  "type": "FIX_REVIEW_RESULT",
  "repository": "owner/repo",
  "taskId": "NR-XX",
  "cycle": 1,
  "payload": {
    "previousTuple": {"prUrl": "PR_URL", "baseSha": "OLD_BASE", "headSha": "OLD_HEAD", "bundleHash": "sha256:OLD_CONTEXT_HASH"},
    "currentTuple": {"prUrl": "PR_URL", "baseSha": "NEW_BASE", "headSha": "NEW_HEAD", "bundleHash": "sha256:NEW_CONTEXT_HASH"},
    "verdict": "APPROVED",
    "findingResults": [{"id": "NR-XX-R1-F1", "status": "FIXED", "evidence": ["Artifact id and precise supporting location"]}],
    "findings": [],
    "coverage": ["NR-XX-AC1"],
    "limitations": [],
    "requiresFreshReview": false
  }
}
```

Each requested findingId appears exactly once in findingResults; missing/duplicate/unknown IDs invalidate the receipt. status is `FIXED|NOT_FIXED|REGRESSION|UNCERTAIN`, evidence is a nonempty string array. New direct regressions use new stable IDs in findings with the REVIEW_RESULT finding schema. verdict uses `APPROVED|NEEDS_FIX|CONTEXT_REQUIRED|BLOCKED`. APPROVED requires all prior blockers FIXED, no new blocking findings, sufficient coverage and requiresFreshReview=false. Uncertain or incomplete verification never approves. inReplyTo targets the exact FIX_REVIEW_REQUEST; session/repository/task/cycle must match. For a fresh cycle, use a new REVIEW_REQUEST; do not disguise it as a fix response.

Implementer не удаляет findings и не заменяет ответ reviewer пересказом. При несогласии отправляет evidence и просит переоценку; lead может уточнить ТЗ, но не подделать одобрение. Изменение ТЗ проходит отдельный review либо входит в явно расширенный cycle.

## Merge gate и отсутствие циклической зависимости

Допуск к merge: reviewer approval + lead authorization + обязательные checks + актуальные base/head. Перед вызовом merge перечитать GitHub состояние, использовать expected head SHA и защиту base через merge queue/required up-to-date branch либо сериализованный merge единственного writer. При гонке обновить ветку и approvals. Не обходить branch protection. Если GitHub требует отдельного человеческого approval, веб-ответ не подменяет его.

Approval нельзя коммитить в тот же head, который он одобряет: это изменит SHA. Receipt хранится в append-only внешнем журнале/PR evidence; следующий PR может добавить sanitized запись. STATUS обновляется до review как «in progress / awaiting acceptance», а факт merged проверяется по GitHub и журналу. Релизный acceptance manifest хранится как отдельный release artifact или PR evidence, а не требует self-referential commit.

## Компакция и возобновление

Checkpoint содержит session IDs, chat URLs локально, последнюю подтверждённую пару SHA, assignment/decision IDs, PR, незакрытые findings, следующий шаг и raw receipt refs. После компакции сверить checkpoint с GitHub и настроенными чатами. Chat summary полезен как индекс, но authority остаётся у исходных решений/receipts. При переезде в новый чат требуется user/lead-approved handover bundle и новый READY; не считать переписанный summary прежним approval.
