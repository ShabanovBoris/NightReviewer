# ADR-0001 — исходная точка и решения v1

Дата: 2026-09-26; baseline принят lead в NR-01-D1-BUN-BASELINE от 2026-09-27. Статус: принято для NR-01 foundation; live bridge/tool-loop/cancellation compatibility остаётся открытой проверкой NR-02.

GitHub API при подготовке комплекта сообщил, что `ShabanovBoris/NightReviewer` пуст; default branch — `main`. Первоначальная публикация документов требует минимального bootstrap-коммита. Это единственный технический bootstrap, не разрешение обходить PR для последующей реализации.

Проверен upstream `miuuyy/codex-chatgpt-web` на commit `a13cd09950969f43e3b7e25c71fa43efaf5446c5`:

- [package.json](https://github.com/miuuyy/codex-chatgpt-web/blob/a13cd09950969f43e3b7e25c71fa43efaf5446c5/package.json): версия проекта 6.1.1, TypeScript, Bun 1.4.0.
- [architecture.md](https://github.com/miuuyy/codex-chatgpt-web/blob/a13cd09950969f43e3b7e25c71fa43efaf5446c5/docs/architecture.md): loopback Responses bridge, task-bound tabs, разные browser-only/full режимы, turn capabilities, DEV driver с симулированными результатами tools.
- [concurrency.ts](https://github.com/miuuyy/codex-chatgpt-web/blob/a13cd09950969f43e3b7e25c71fa43efaf5446c5/src/adapters/chatgpt-web/concurrency.ts): верхний предел 5 вкладок.
- [README](https://github.com/miuuyy/codex-chatgpt-web/blob/a13cd09950969f43e3b7e25c71fa43efaf5446c5/README.md): full mode использует tunnel и custom connector; browser-only не предоставляет локальные tools.

Это подтверждает наличие компонентов, но **не доказывает**, что простой POST в Responses endpoint достаточно реализует outer tool loop, изоляцию NightReviewer, отмену и возврат JSON. NR-02 обязан проверить wire contract и зафиксировать bridge pin. DEV simulated receipts не являются live end-to-end проверкой.

Решения по умолчанию:

1. NightReviewer — отдельный репозиторий и сервис; upstream — закреплённый backend. Изменения upstream — минимальный документированный adapter patch только если spike доказал необходимость.
2. Для NightReviewer foundation закреплены TypeScript 7.0.2 и Bun 1.4.2; Bun 1.4.2 — также точная версия package manager. Репозиторий фиксирует её в `.bun-version`, `packageManager` и lockfile, а Linux CI устанавливает ту же версию. TypeScript/Bun для NightReviewer — собственный runtime контура сервиса. Это отдельно от закреплённого `miuuyy/codex-chatgpt-web@a13cd09950969f43e3b7e25c71fa43efaf5446c5`, у которого upstream остаётся Bun 1.4.0. SQLite остаётся целевой технологией хранения; её runtime/driver выбирается в задаче реализации persistence, не копируя автоматически dependency graph upstream.
3. `strict` — correctness/tests/design × 3 независимых replica; общая concurrency 3 и никогда выше меньшего из настроенного/доступного/upstream лимита.
4. Поддерживаемые цели: macOS 13+ arm64/x64 для локального live-приложения и Linux для детерминированных CI-проверок. Dashboard, дополнительные провайдеры, Windows live, adaptive replicas — вне обязательного v1.
5. Под «PR в main» понимается merged PR после review и merge authorization. Push feature branch для review разрешён до approval; direct push реализации в main запрещён.
6. Веб-чаты разработки lead/reviewer постоянные и задаются пользователем. Runtime reviewer-workers свежие, изолированные и не получают историю этих чатов.

Изменение целей/порогов приёмки требует решения lead с evidence и явной фиксацией; implementer не снижает их ради завершения. Недоступный браузер/аккаунт/connector обозначается BLOCKED, не заменяется фиктивным успехом.

NR-01 runtime evidence:

- macOS 26.6.2 arm64: официальный Bun archive SHA-256 совпал с опубликованным release digest; `bun --version` = 1.4.2, `bun --revision` = `1.4.2+744846f84`; `bun install --frozen-lockfile` и `bun run verify` завершились с exit 0 на implementation SHA `7366db6e21f9e6490bde26b6b1c9b48e5d8a05f5`.
- Linux deterministic CI (`ubuntu-24.04`): GitHub Actions run [36308775820](https://github.com/ShabanovBoris/NightReviewer/actions/runs/36308775820) для `pull_request` и того же head завершился успешно. Workflow устанавливает версию из `.bun-version` и проверяет её перед frozen install и `bun run verify`.

Эти результаты подтверждают только foundation toolchain и CI на указанных средах. Выбор версии сам по себе не доказывает совместимость bridge/browser/tool-loop; её обязан проверить NR-02.
