# Матрица финальной приёмки

Все gates обязательны. Evidence содержит **наблюдённые**, не ожидаемые результаты. Эта таблица — план; начальный статус каждого gate NOT_RUN.

| Gate | Проверяемый результат | Основные задачи | Доказательство |
|---|---|---|---|
| BUILD | Clean locked install, typecheck/lint/tests/build в CI | NR-01,18 | Commands, CI URL, lockfile/runtime versions |
| BRIDGE | Реальный fresh ChatGPT turn, observed identity, tool roundtrip, cancel | NR-02,09,10 | Live receipts, pinned bridge ADR |
| CONTRACT | Версии/валидация, errors, idempotency, state transition guards | NR-03,07 | Negative and positive contract suite |
| SNAPSHOT | Immutable base/head после working tree mutation, GC/source deletion | NR-05,06 | Fixture outputs, manifest hashes |
| PERSISTENCE | Raw/provenance/state сохранены; backup/restore проверен | NR-04,14 | Crash traces, restored DB/artifact checks |
| ISOLATION | ACL/capability/path bounds, no cross-run context, no secret leak | NR-06,10,16 | Negative matrix, live canaries |
| STRICT | correctness/tests/design × 3 + 3 adjudicators, global concurrency ≤3 | NR-11,12 | Scheduler traces + live strict run |
| FINDINGS | Disposition каждого candidate, singleton сохранён, rejected evidence | NR-12,17 | Corpus mapping и source refs |
| FIX | NEEDS_FIX→fix→APPROVED на новом SHA, incorrect/regressed fix blocked | NR-13 | Full live cycle и adversarial fixtures |
| RECOVERY | 50 offline fault cases; cancellation/late results/disk/tunnel/crash безопасны | NR-14 | Fault manifest, no false approval |
| UX | MCP client и CLI; status/nextAction/doctor понятны; errors machine-readable | NR-07,15 | Clean operator walkthrough |
| QUALITY | 12 live fixtures: ≥7/8 seeded defects, все designated critical/high; ≤1 blocking FP на 4 clean | NR-17 | Frozen corpus, all raw/triage, benchmark report |
| INSTALL | macOS arm64/x64 install/start/doctor; primary clean-machine live demo | NR-18 | Hardware/OS details, artifact checksum |
| STABILITY | 30 normal live cycles, ≥24h/3 sessions, 10 fix cycles, 5 strict; 30 корректных outcomes | NR-19 | Append-only soak manifest, all attempts |
| LATENCY | p95 ≤20 min на ≤500 changed-line fixtures без external limit; полная wall time раскрыта | NR-19 | Per-cycle times и explicit exclusions |
| INTEGRITY | Ноль ложных approval из-за incomplete/stale/failed work, mixups, потерянных accepted raw | NR-14,16,19 | Adversarial, fault и soak reports |
| DELIVERY | Все задачи merged; final main/artifact проверены, docs/runbook/release notes доступны | NR-20 | PR index, final main checks, tree equivalence |
| LEAD | Подлинный PROJECT_ACCEPTED для final main SHA + manifest hash; blockers пусты | NR-20 | Lead source receipt и raw response hash |

## Как считать стабильность

Normal cycle — полный стартованный live сценарий со всеми обязательными replica/adjudication, ожидаемый verdict сверяется с fixture. NEEDS_FIX для настоящего seeded defect — корректный исход, а не ошибка. Fake/simulated runs не входят в 30. При rate limit цикл остаётся в журнале и приостанавливается; resumed outcome относится к тому же логическому циклу, каждый physical attempt учтён. Из soak не удаляются неудачные прогоны.

UI login/initial connector setup до серии допустимы. Ручное исправление DB/state, ручной rebind или скрытый повтор для получения успеха во время normal cycle нарушает STABILITY. При настоящей внешней недоступности серия может продолжиться после восстановления; downtime показан отдельно. Если менялись код, prompts, schema, policy или bridge version, qualification проводится для нового candidate; новый 30-cycle stability run обязателен. Для docs-only merge допускается доказанное равенство всех executable inputs с уже проверенным candidate.

QUALITY — минимальная регрессионная планка на небольшом известном корпусе, не оценка универсальной точности модели. Нельзя подбирать ответы, чтобы ровно попасть в oracle. Oracle не доступен reviewer через snapshot/tools. Каждое спорное FP/FN решение имеет воспроизводимое evidence и review.

## Acceptance manifest

Формат: `schemaVersion`, `mainSha`, `candidateSha`, `artifactSha256`, `bridgeSha`, `runtimeVersion`, `configPolicyHash`, `promptHashes`, `taskPullRequests[]`, `gates[]`, `knownLimitations[]`, `reviewerReceipt`, `generatedAt`. Gate: id/status/command/environment/testedSha/artifactRefs/notes. Только PASS разрешён для обязательных gates перед lead acceptance; сам LEAD фиксируется внешним ответом поверх manifest, чтобы hash не ссылался на себя.

Lead получает предварительный manifest с LEAD=PENDING_EXTERNAL, проверяет все остальные gates и выдаёт PROJECT_ACCEPTED на **этот hash**. Финальная запись acceptance хранится отдельным envelope рядом с immutable manifest, с LEAD=PASS в производном human-readable отчёте. Изменение исходного manifest после ответа делает acceptance устаревшим.
