# Разработка NightReviewer

## Локальная настройка

Foundation закреплён на Bun 1.4.2 и TypeScript 7.0.2. Проверьте `bun --version`, затем установите только locked dependencies:

```sh
curl -fsSL https://bun.com/install | bash -s "bun-v1.4.2"
bun install --frozen-lockfile
```

Локальные URL lead/reviewer держите только в игнорируемом `config/session.local.json`. Скопируйте `config/session.example.json`, замените оба примера на разные сохранённые чаты и назначьте уникальный UUID v4. Проверка конфигурации не выводит URL:

```sh
bun run config:doctor
```

Для структурной проверки sample config, typecheck, lint, tests и build используйте:

```sh
bun run verify
```

## Скрипты

| Команда | Назначение |
|---|---|
| `bun run config:doctor` | Проверяет обязательную локальную session config и redacts chat URLs в выводе |
| `bun run typecheck` | Запускает строгую проверку TypeScript для source, tests и scripts |
| `bun run lint` | Проверяет формат и lint rules в source, tests и scripts |
| `bun run test` | Выполняет реальные тесты через Bun test runner |
| `bun run build` | Собирает TypeScript entry point в `dist/` |
| `bun run verify` | Последовательно выполняет typecheck, lint, tests и build |

CI повторяет frozen install и `bun run verify` на Linux с тем же Bun 1.4.2.

Workflow `verify` — check для каждого PR в `main` и push в `main`; он использует только `contents: read`. При проверке GitHub Settings → Branches показал, что classic branch protections не настроены, а Settings → Rulesets — что rulesets не созданы. Временная отметка и видимые сигналы сохранены в [docs/evidence/NR-01-settings.json](docs/evidence/NR-01-settings.json). Check не обходится и не заменяется локальным PASS; перед merge следует заново проверить меняющиеся настройки.

## Pull requests

Каждая назначенная задача получает отдельную feature branch от актуального `main` и отдельный PR в `main`. Заполните PR template: task/spec identity, каждый AC, команды с exit codes, точные SHA, evidence и ограничения. Не добавляйте `config/session.local.json`, приватные URL чатов или credentials.
