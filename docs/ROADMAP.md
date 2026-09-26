# Roadmap до стабильной v1

Все 20 пунктов обязательны. Каждый — отдельное ТЗ, отдельный промпт и один bounded PR в main (или lead-approved child PRs). Номера задают рекомендуемый последовательный порядок; зависимости — минимальные prerequisites. Время в календаре не обещается: live проверки зависят от доступа, модели и лимитов аккаунта.

| ID | Результат этапа | Зависимости | Документы |
|---|---|---|---|
| NR-01 | Основа проекта и рабочий процесс | — | [ТЗ](specs/NR-01.md) · [промпт](tasks/NR-01.md) |
| NR-02 | Технический spike ChatGPT Web backend | NR-01 | [ТЗ](specs/NR-02.md) · [промпт](tasks/NR-02.md) |
| NR-03 | Версионированные схемы и машина состояний | NR-01, NR-02 | [ТЗ](specs/NR-03.md) · [промпт](tasks/NR-03.md) |
| NR-04 | SQLite и неизменяемые артефакты | NR-03 | [ТЗ](specs/NR-04.md) · [промпт](tasks/NR-04.md) |
| NR-05 | Git snapshots и review manifest | NR-03, NR-04 | [ТЗ](specs/NR-05.md) · [промпт](tasks/NR-05.md) |
| NR-06 | Ограниченный read-only review context | NR-05 | [ТЗ](specs/NR-06.md) · [промпт](tasks/NR-06.md) |
| NR-07 | Daemon и внешний MCP lifecycle | NR-04, NR-05, NR-06 | [ТЗ](specs/NR-07.md) · [промпт](tasks/NR-07.md) |
| NR-08 | Durable scheduler и fake backend | NR-07 | [ТЗ](specs/NR-08.md) · [промпт](tasks/NR-08.md) |
| NR-09 | Production bridge adapter | NR-02, NR-08 | [ТЗ](specs/NR-09.md) · [промпт](tasks/NR-09.md) |
| NR-10 | Tunnel и production context MCP | NR-06, NR-09 | [ТЗ](specs/NR-10.md) · [промпт](tasks/NR-10.md) |
| NR-11 | Независимые replica и направления | NR-10 | [ТЗ](specs/NR-11.md) · [промпт](tasks/NR-11.md) |
| NR-12 | Direction adjudication и canonical findings | NR-11 | [ТЗ](specs/NR-12.md) · [промпт](tasks/NR-12.md) |
| NR-13 | Fix verification и точный approval gate | NR-12 | [ТЗ](specs/NR-13.md) · [промпт](tasks/NR-13.md) |
| NR-14 | Crash recovery, cancellation и пределы ресурсов | NR-13 | [ТЗ](specs/NR-14.md) · [промпт](tasks/NR-14.md) |
| NR-15 | CLI, diagnostics и эксплуатация | NR-14 | [ТЗ](specs/NR-15.md) · [промпт](tasks/NR-15.md) |
| NR-16 | Проверка изоляции и защитных границ | NR-15 | [ТЗ](specs/NR-16.md) · [промпт](tasks/NR-16.md) |
| NR-17 | Регрессионный corpus и метрики качества | NR-16 | [ТЗ](specs/NR-17.md) · [промпт](tasks/NR-17.md) |
| NR-18 | Установка и release candidate | NR-17 | [ТЗ](specs/NR-18.md) · [промпт](tasks/NR-18.md) |
| NR-19 | Live soak и стабильность | NR-18 | [ТЗ](specs/NR-19.md) · [промпт](tasks/NR-19.md) |
| NR-20 | Финальная поставка и приёмка lead | NR-19 | [ТЗ](specs/NR-20.md) · [промпт](tasks/NR-20.md) |

## Контрольные точки

| Milestone | После | Gate |
|---|---|---|
| M0 — доказанная интеграция | NR-02 | Реальный isolated turn, tool roundtrip, cancellation, transport ADR |
| M1 — offline core | NR-08 | Durable submit/status/cancel, snapshots, context ACL, fake recovery |
| M2 — Web MVP | NR-11 | Реальные fresh sessions, tunnel и strict replica execution |
| M3 — функциональная v1 | NR-13 | 3×3 + adjudication + fixes + exact-SHA approval |
| M4 — защищённая эксплуатация | NR-16 | Recovery, CLI/runbook, isolation tests |
| M5 — release candidate | NR-19 | Corpus, install, 30 live cycles и stability thresholds |
| M6 — принятый проект | NR-20 | Рабочий main, evidence manifest, PROJECT_ACCEPTED от lead |

## Правило управления

Lead назначает следующую ready-задачу, принимает архитектурные решения и выдаёт merge authorization. Reviewer проверяет каждый PR по [протоколу](protocols/DEVELOPMENT.md). Implementer не обязан угадывать будущие задачи: берёт одно назначение, завершает его и возвращается к lead. Документационные и corrective PR подчиняются тому же gate.

До доказательства M0 не инвестировать в дополнительные transport abstractions. До M3 не объявлять сервис рабочим. До M6 не завершать `/goal` успехом. Временная недоступность аккаунта — checkpoint/BLOCKED, а не причина обхода live gates.

## Изменения плана

Lead может разделить пункт, уточнить порядок и назначить corrective PR без потери acceptance IDs. Изменение scope/порогов оформляется DECISION + ADR + обновление затронутых ТЗ, проходит review. Нельзя silently исключить Web/tunnel, заменить live проверки fake или убрать приёмку lead. Расширения после v1 (dashboard, API backends, adaptive replicas, Windows, target test sandbox) не блокируют текущую цель и не добавляются бесконечно в release review.

Матрица завершения: [ACCEPTANCE.md](ACCEPTANCE.md). Реестр: [STATUS.md](STATUS.md). Общий запуск: [GOAL.md](prompts/GOAL.md).
