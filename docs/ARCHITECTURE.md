# Архитектура v1

## Два разных контура

Контур разработки: user → lead chat → implementer → PR → reviewer chat → lead → merge. Он действует до появления NightReviewer и описан в [DEVELOPMENT.md](protocols/DEVELOPMENT.md).

Контур продукта: MCP client → локальный daemon → scheduler → backend → runtime workers → direction adjudicators → persisted verdict. Ни lead chat, ни development reviewer не являются зависимостями запуска поставляемого приложения.

```mermaid
flowchart TD
    C[Implementer MCP] --> D[Local daemon]
    D --> S[SQLite and snapshots]
    D --> Q[Scheduler]
    Q --> B[ChatGPT Web backend]
    B --> W[Fresh reviewer chats]
    W --> T[Bound context MCP]
    T --> S
    B --> A[Direction adjudicators]
    A --> D
```

## Компоненты

| Компонент | Ответственность | Не делает |
|---|---|---|
| MCP client adapter | Submit/status/fix/cancel; authenticated local RPC к daemon | Не теряет jobs при закрытии stdio клиента |
| Review service | State machine, policy, CAS transitions, audit | Не решает семантическую истинность finding |
| Snapshot/context | Git object reads, manifest, diff/search/read, limits | Не читает mutable working tree и arbitrary filesystem |
| Store | SQLite migrations, attempts, raw artifacts, provenance | Не превращает missing data в пустое успешное review |
| Scheduler | Durable leases, fencing, fair bounded dispatch | Не создаёт новые чаты при неоднозначном send |
| ReviewerBackend | Transport/cancel/capabilities/result envelope | Не хранит бизнес-правила направления |
| Direction adjudicator | Evidence validation, semantic dedup, fix verification | Не выполняет произвольный fresh review во время fix |
| Approval gate | Полнота runs, policy и точный SHA | Не принимает majority vote за доказательство |

Предлагаемые каталоги: `src/protocol`, `src/service`, `src/storage`, `src/snapshot`, `src/context`, `src/scheduler`, `src/backends`, `src/mcp`, `src/cli`, `src/prompts`, `tests/fixtures`. NR-01 может упростить структуру, сохраняя границы.

## Backend contract (проект, схемы реализуются NR-03)

`execute(request, abortSignal) → BackendResult`: request содержит immutable run/attempt IDs, role (`reviewer|adjudicator|fix_verifier`), binding handle, prompt/schema hash, model/effort и deadline. Result содержит transport receipt, raw artifact reference/hash, observed model, завершённость и parsed output либо typed error. Binding не сериализует секреты в публичный manifest.

`capabilities()` сообщает реальные доступные функции: fresh sessions, tool loop, cancellation, observed identity, concurrency. Не поддержанное требование даёт CONFIGURATION_ERROR, а не silent fallback. HTTP/SSE response done, browser completion и valid JSON — разные факты, все нужны для успешного run.

## Snapshot design

Detached worktree сам по себе не immutable. Источник истины — сохранённые Git objects для base/head и content-addressed manifest. Context читает blobs по pinned SHA, не через свободный filesystem path. Сохранить reachable objects в owned mirror/pinned refs или self-contained bundle, чтобы GC/source repo deletion не сломали review. Worktree — необязательный cache; symlinks не разыменовываются, submodules/LFS явно отмечены.

## Данные и восстановление

SQLite: `reviews`, `review_cycles`, `direction_runs`, `worker_attempts`, `snapshots`, `raw_artifacts`, `raw_findings`, `canonical_findings`, `finding_sources`, `adjudication_decisions`, `fix_submissions`, `finding_verifications`, `events`, `leases`, `idempotency_keys`. FK/unique constraints, migrations и транзакции проверяются crash tests. Attempt append-only, obsolete attempts не участвуют в verdict. Raw записывается до parsing; неуспешный parse не уничтожает оригинал. Большие payloads — atomic files + hashes + reconciliation для crash между file и DB write.

Семантика at-least-once orchestration, idempotent ingest. Exactly-once физическую отправку в браузер не обещаем. После неопределённого send — NEEDS_RECONCILIATION; повтор только после подтверждения отсутствия исходной отправки или явного нового attempt с журналом и исключением старого результата.

## Политика

Default `strict`: correctness/tests/design × 3; общая concurrency 3 для workers и adjudicators. Versioned policy: все confirmed critical/high/medium блокируют; low неблокирующие, но остаются в отчёте. Любой кандидат с unresolved validation, пропавший обязательный run, unknown coverage или malformed completion блокирует APPROVED. Reject finding можно по evidence; одиночное обнаружение не причина rejection. Scope escalation даёт новый cycle с parent link, не бесконечное расширение fix review.
