# Цель и границы v1

NightReviewer принимает конкретную пару Git commit SHA и задачу разработчика, выполняет независимые ревью через ChatGPT Web, валидирует замечания по исходному коду, возвращает canonical findings и проверяет исправления. Сервис работает локально, сохраняет историю и переживает рестарт без потери принятых результатов или ложного APPROVED.

## Пользовательский сценарий

1. Implementer коммитит изменение и вызывает `review_submit` через MCP.
2. Сервис фиксирует manifest, snapshots и review ID; запрос быстро возвращает ID, работа продолжается в daemon.
3. Три направления × три независимых reviewer-а читают один и тот же immutable контекст через ограниченный MCP. Direction adjudicator проверяет кандидаты, объединяет дубли и сохраняет происхождение.
4. Implementer через `review_status` получает NEEDS_FIX, APPROVED либо явно незавершённое/ошибочное состояние.
5. Для NEEDS_FIX implementer коммитит исправление и вызывает `review_submit_fix` с previous SHA и объяснением по finding ID.
6. Adjudicators проверяют исходные проблемы и прямые регрессии fix. Существенный новый scope требует нового review cycle.
7. APPROVED действительно только для точного SHA, manifest/policy версии и успешно завершённого полного набора обязательных runs.

## Обязательные свойства

- Установка по инструкции на чистом поддерживаемом окружении; `doctor` и fake demo работают без ChatGPT.
- Live backend использует реальный аккаунт, проверяет доступную модель/effort и явно сообщает об ограничениях.
- Никакой зависимости от авто-merge внешнего upstream PR для базового запуска: pin/patch и установка должны быть воспроизводимы.
- Read-only context, изоляция run/repo/SHA, bounded resources, отсутствие unrestricted terminal у reviewer.
- Durable очередь, raw output, schema validation, provenance, bounded retry/cancel/recovery.
- Полный цикл submit → findings → fix → approval, CLI и MCP, отчёт и diagnostics.
- Регрессионный fixture corpus, live qualification и письменная приёмка lead.

## Граница обещаний

Сервис не гарантирует отсутствие багов после APPROVED. Он гарантирует исполнение зафиксированной процедуры и доказуемую привязку результата к версии кода. Три повтора одной модели не считаются тремя независимыми статистическими экспертами; полезность измеряется corpus/метриками.

Подписка ChatGPT, вход, connector availability и разрешённый доступ к репозиторию — внешние предпосылки. UI drift и лимиты аккаунта дают явную паузу/ошибку, а не скрытую смену модели. Никаких обходов ограничений или CAPTCHA.

В v1 не входят SaaS, биллинг, web UI, автономный merge чужих репозиториев, дополнительные LLM backends и исполнение произвольного кода review target. Тесты target repo принимаются как аттестованные внешние результаты; runner чужих тестов требует отдельной sandbox-задачи после v1.

## Конец /goal

Завершение — логическое AND: все обязательные NR-01…NR-20 слиты через PR; все acceptance gates PASS с доказательствами для release candidate; main содержит проверенный артефакт; reviewer не имеет открытых blockers; lead выдал `PROJECT_ACCEPTED` с точным main SHA и acceptance manifest hash. Наличие README, моков, открытого PR или зелёного unit CI недостаточно.
