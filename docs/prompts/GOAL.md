# Основной goal-промпт

Этот текст — полное задание для длительной implementation-сессии. Он не запускается автоматически публикацией документа. Перед началом заполнить параметры из `config/session.example.json` локально и инициализировать чаты bootstrap-промптами. `/goal` используется только если поддерживается конкретным клиентом; ниже содержимое цели, а не обещание синтаксиса или фонового исполнения.

```text
GOAL: довести https://github.com/ShabanovBoris/NightReviewer до полностью
рабочей стабильной v1 на main и получить явное принятие проекта lead.

Входы пользователя (локально, не коммитить приватные значения):
REPOSITORY = https://github.com/ShabanovBoris/NightReviewer
TARGET_BRANCH = main
LEAD_CHAT_URL = <пользовательская сохранённая ветка ChatGPT lead>
REVIEWER_CHAT_URL = <другая сохранённая ветка ChatGPT reviewer>
SESSION_ID = <создай уникальный ID>
MODEL/EFFORT = <проверь доступное; high если поддерживается>

Ты исполняющий агент. Реализуй проект, а не только предложи план.
Действуй по AGENTS.md и спецификациям репозитория. Контекст/решения, которые
могут повлиять на acceptance, уточняй у lead; рутинные инженерные детали решай сам.
В пределах этой цели разрешены необходимые edits/tests/branches/commits/push,
создание PR, сообщения в указанные lead/reviewer чаты и merge в main после
всех предусмотренных approvals/checks. Это не разрешение обходить внешние
права, правила GitHub, аутентификацию или ограничения среды.

1. BOOTSTRAP
Прочитай README.md, AGENTS.md, docs/PRODUCT.md, docs/ROADMAP.md,
docs/ARCHITECTURE.md, docs/ACCEPTANCE.md, docs/DEFINITION_OF_DONE.md,
docs/protocols/DEVELOPMENT.md, docs/protocols/RUNTIME.md и docs/STATUS.md.
Проверь реальный repository/main/открытые PR: документы не означают готовый код.
Сохрани параметры по config/session.example.json в ignored local config.
Если URL чатов отсутствуют, подготовь доступную работу, но не имитируй lead/reviewer:
запроси именно недостающие URL перед действиями, которым они необходимы.
Передай docs/prompts/LEAD.md и REVIEWER.md в соответствующие чаты с manifest
документов, получи READY. Если история уже инициализирована, восстанови её
по журналу и сверке session ID; не сбрасывай существующие решения.
Bootstrap использует BOOTSTRAP_REQUEST/READY schemas из DEVELOPMENT.md;
READY имеет taskId=null, cycle=0 и точный inReplyTo.

2. PLAN AND ASSIGNMENT
Отправь lead PLAN_REQUEST с текущим состоянием и запроси TASK_ASSIGNMENT.
Основной маршрут — NR-01…NR-20, отдельные ТЗ docs/specs/NR-XX.md и
исполняемые задания docs/tasks/NR-XX.md. Каждый пункт должен закончиться
merged PR в main, а не просто готовой веткой.
Не начинай зависимую задачу до подтверждённой поставки prerequisites.
Lead может разбить scope или назначить corrective PR с сохранением критериев.

3. IMPLEMENT → REVIEW → MERGE
Для задания: isolated feature branch от main → минимальная реализация →
проверки по ТЗ/DoD → commit/push → PR base=main с AC→evidence.
Отправь REVIEW_REQUEST в REVIEWER_CHAT_URL по nr-dev/1, сохрани raw response,
проверь session/message correlation, base/head и bundle hash.
bundleHash вычисляй по всему каноническому reviewContext (spec/AC/scope/files/
diff/evidence/limitations/fix context), а не по одному списку файлов. Проверяй
полную approval identity. Новый evidence или scope требует нового verdict даже
при прежнем head; FIX_REVIEW_RESULT валидируй по явной схеме DEVELOPMENT.md.
При NEEDS_FIX исправь concrete blockers, запушь новый commit и запроси
FIX_REVIEW_REQUEST для нового SHA. Не подменяй заключения reviewer.
На 3-м безуспешном fix round, ambiguity или scope conflict отправь lead
DECISION_REQUEST с evidence; после решения продолжай ограниченный cycle.
После reviewer APPROVED отправь lead MERGE_REQUEST. Получив MERGE_AUTHORIZED
на ту же пару base/head, перечитай GitHub checks/rules/base/head и выполни merge.
Если revision изменился, обнови проверки и approvals. Direct push в main,
self-approval и обход branch protection запрещены.
Проверь resulting main SHA/CI/tree equivalence, отправь TASK_COMPLETED lead.
Возвращайся к следующему assignment, пока цель полностью не достигнута.

4. ENGINEERING REQUIREMENTS
Отдельный TypeScript/Bun/SQLite сервис с immutable Git snapshots и versioned MCP.
codex-chatgpt-web — закреплённый backend, сначала доказанный live spike.
Read-only run-bound context через tunnel; никаких unrestricted tools reviewer-ам.
Strict профиль: correctness/tests/design ×3 independent fresh contexts,
общая concurrency 3 в пределах фактически доступного upstream pool.
Raw persistence, complete provenance, schema validation, semantic adjudication,
exact-SHA approval и scoped fix verification. Неполные/ошибочные/неопределённые
результаты не превращаются в APPROVED. Recovery/limits/cancel и clean install
являются частью продукта. Конкретные договорённости — в ТЗ и ADR.

5. HONEST VERIFICATION AND RECOVERY
Сохраняй реальные команды/exit codes/raw artifacts и версии. Различай
FAKE/CONTRACT/LIVE. Не обещай запуск, которого не было. Live corpus, 30-cycle
soak, fault tests и установка обязательны согласно ACCEPTANCE.md.
Не обходи account limits, login walls, CAPTCHA или чужие access controls.
Если tools/browser/login/permissions недоступны, сохрани checkpoint с точной
причиной и минимальным действием оператора. Выполни доступную независимую работу.
Состояние WAITING_EXTERNAL/BLOCKED — пауза с возможностью продолжить, не SUCCESS.
Не делай бесконечных retries и не повторяй неоднозначно отправленное сообщение.

6. COMPACTION AND CONTINUITY
После каждого meaningful boundary сохраняй локальный checkpoint: task/spec
revision, branch/PR/base/head, lead decision IDs, reviewer findings/receipts,
test evidence, следующий шаг, blockers. Private URLs/secrets остаются локально.
После компакции перечитай AGENTS и checkpoint, сверяй GitHub и исходные receipts.
Не теряй прежние решения, не повторяй завершённые задачи и не считай summaries
заменой raw approval. Непроверенный ответ модели — не разрешение на merge.

7. FINAL ACCEPTANCE — ЕДИНСТВЕННЫЙ КРИТЕРИЙ УСПЕШНОГО ЗАВЕРШЕНИЯ
Все обязательные задачи NR-01…NR-20 поставлены через merged PR.
Final main/artifact запускается по инструкции, MCP/реальный ChatGPT tunnel/
strict review/fix approval работают; acceptance gates имеют PASS evidence.
Нет открытых reviewer blockers и проваленных обязательных checks.
Подготовь immutable acceptance manifest + artifact hashes, exact main SHA,
candidate equivalence, список PR и честные ограничения.
Отправь lead PROJECT_ACCEPTANCE_REQUEST с полным доступным evidence.
Завершай /goal успехом ТОЛЬКО после подлинного PROJECT_ACCEPTED от lead,
который повторяет exact main SHA и hash этого manifest.
Сам lead receipt хранится отдельно, чтобы не менять hash принятого manifest.
Если PROJECT_REJECTED — получи corrective assignment, исправь и повтори приёмку.

Финальный ответ пользователю: что работает, main/release SHA, ссылки на PR/release,
как запустить, какие live проверки выполнены и ссылка/receipt принятия lead.
Не объявляй завершение по документации, мокам, открытому PR или своему мнению.
```
