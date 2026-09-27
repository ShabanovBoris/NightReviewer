# NightReviewer

Локальный сервис независимого ревью кода через ChatGPT Web, с MCP-контрактом для implementer, проверкой замечаний и повторной проверкой исправлений.

**Статус: NR-01 foundation в работе.** Продуктовый daemon и review-процесс пока не реализованы; наличие документации не означает успешных тестов, live review или приёмки.

## Разработка и проверка

Для foundation используется Bun **1.4.2**. Команды и локальная конфигурация описаны в [CONTRIBUTING.md](CONTRIBUTING.md): `bun install --frozen-lockfile`, `bun run config:doctor` и `bun run verify`.

`config/session.example.json` содержит безопасные структурные примеры. Скопируйте его в игнорируемый `config/session.local.json`, замените ссылки на два разных сохранённых чата и не публикуйте их в PR или логах.

## Начать разработку

1. Создать два отдельных сохранённых чата ChatGPT: **lead** и **reviewer**.
2. Передать им [lead bootstrap](docs/prompts/LEAD.md) и [reviewer bootstrap](docs/prompts/REVIEWER.md), а также доступ к комплекту документов и коду. Ссылка сама по себе не доказывает доступ.
3. Заполнить локальные параметры по [шаблону](config/session.example.json). Проверить ответы `READY` от обоих чатов по [протоколу](docs/protocols/DEVELOPMENT.md).
4. Передать исполняющему агенту [GOAL.md](docs/prompts/GOAL.md) как содержимое целевой `/goal`-сессии. Если конкретный клиент не поддерживает `/goal`, использовать тот же текст как длительное задание; сам этот репозиторий такую команду не устанавливает.
5. Пройти [roadmap](docs/ROADMAP.md). Каждая задача имеет отдельное ТЗ и отдельный запускаемый промпт. Исполнение начинается с NR-01 после назначения lead.

## Основные документы

- [AGENTS.md](AGENTS.md) — правила реализации и merge.
- [Цель, границы и приёмка](docs/PRODUCT.md).
- [Архитектура и ключевые контракты](docs/ARCHITECTURE.md).
- [Roadmap и зависимости](docs/ROADMAP.md).
- [Протокол разработки: implementer / reviewer / lead](docs/protocols/DEVELOPMENT.md).
- [Протокол review-сервиса](docs/protocols/RUNTIME.md).
- [Общий Definition of Done](docs/DEFINITION_OF_DONE.md).
- [Разработка и локальный запуск](CONTRIBUTING.md).
- [Матрица приёмки](docs/ACCEPTANCE.md).
- [Проверенные исходные данные](docs/decisions/0001-baseline.md).
- [Реестр выполнения](docs/STATUS.md).

Документация на русском, идентификаторы протокола и код — на английском. Target v1: macOS 13+ arm64/x64; Linux используется для детерминированных CI-проверок. Остальные платформы не объявляются поддержанными без отдельной проверки.
