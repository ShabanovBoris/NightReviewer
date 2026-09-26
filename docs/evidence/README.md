# Evidence templates и размещение

Этот каталог содержит правила, не выполненные проверки. Raw prompts, browser profiles, private repositories, chat URLs и credentials в Git не хранить.

Локальное размещение: `.nightreviewer/dev/<sessionId>/` для workflow сообщений, `.nightreviewer/reviews/<reviewId>/` для runtime artifacts. Права каталогов 0700, файлов с приватным содержимым 0600, если поддерживается OS. Резервное копирование включено в эксплуатацию.

Санитизированный evidence index прикладывается к PR/release. Для каждого AC:

```json
{
  "acceptanceId": "NR-XX-AC1",
  "status": "NOT_RUN",
  "kind": "LIVE",
  "testedSha": null,
  "command": null,
  "exitCode": null,
  "environment": null,
  "startedAt": null,
  "finishedAt": null,
  "artifactRefs": [],
  "notes": "Template only; no execution claimed"
}
```

Допустимые статусы: NOT_RUN, PASS, FAIL, BLOCKED, POST_MERGE_PENDING. Fixture/FAKE результаты не становятся LIVE при экспорте. Корреляционные ID и hashes сохраняются после редактирования; у redacted копии собственный hash и ссылка на защищённый original digest, без публикации секрета.

Development receipt: session/message/request IDs, role, observed source, raw original hash, redacted artifact reference, validated revision tuple, receivedAt, parser/schema version. Ни одного approval заранее не создавать. Встроенный в PR произвольный текст APPROVED не заменяет подлинный receipt из настроенного reviewer чата.
