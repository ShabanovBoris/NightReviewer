import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createReviewContextService,
  REVIEW_CONTEXT_TOOLS,
  type ReviewContextBinding,
  type ReviewContextService,
} from "../../src/context";
import {
  protocolExampleSha256,
  validProtocolExamples,
  versionHashBindingExample,
} from "../../src/protocol";
import {
  createSnapshotService,
  type SnapshotManifest,
} from "../../src/snapshot";
import {
  type CreatedReview,
  openStorage,
  type SqliteStorage,
} from "../../src/storage";

const lfsPointer =
  "version https://git-lfs.github.com/spec/v1\n" +
  "oid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n" +
  "size 2048\n";

interface TestRun {
  readonly review: CreatedReview;
  readonly manifest: SnapshotManifest;
  readonly runId: string;
  readonly attemptId: string;
}

interface Fixture {
  readonly root: string;
  readonly store: SqliteStorage;
  readonly service: ReviewContextService;
  readonly runs: Readonly<
    Record<"a" | "b" | "testsA2" | "adjudicatorA" | "fixVerifierA", TestRun>
  >;
  binding(
    run: TestRun,
    expiresAtUtc?: string,
    role?: "reviewer" | "adjudicator" | "fix_verifier",
    direction?: "correctness" | "tests" | "design",
  ): ReviewContextBinding;
  close(): Promise<void>;
}

test("NR-06 AC1 serves only run-bound pinned snapshots and test artifacts", async () => {
  const fixture = await createFixture();
  try {
    const first = fixture.runs.a;
    const capability = fixture.service.issueCapability(
      fixture.binding(first),
    ).capability;

    const files = await fixture.service.listFiles({
      capability,
      side: "head",
      pageSize: 50,
    });
    expect(files.items.map((item) => item.path)).toContain("steady.txt");
    expect(files.metadata).toMatchObject({
      snapshotId: first.manifest.snapshotId,
      baseSha: first.manifest.baseSha,
      headSha: first.manifest.headSha,
      pair: "current",
    });
    await expect(
      fixture.service.manifest({ capability, pair: "previous" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const baseDeleted = await fixture.service.readFile({
      capability,
      side: "base",
      path: "deleted.txt",
    });
    expect(baseDeleted.text).toBe("deleted on head\n");
    await expect(
      fixture.service.readFile({
        capability,
        side: "head",
        path: "deleted.txt",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      fixture.service.readFile({ capability, side: "head", path: "../secret" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const adjudicator = fixture.runs.adjudicatorA;
    const adjudicatorCapability = fixture.service.issueCapability(
      fixture.binding(adjudicator, undefined, "adjudicator", "correctness"),
    ).capability;
    await fixture.service.manifest({ capability: adjudicatorCapability });
    await expect(
      fixture.service.search({
        capability: adjudicatorCapability,
        side: "head",
        query: "needle",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      fixture.service.listFiles({
        capability: adjudicatorCapability,
        side: "head",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const fixVerifier = fixture.runs.fixVerifierA;
    const fixCapability = fixture.service.issueCapability(
      fixture.binding(fixVerifier, undefined, "fix_verifier", "correctness"),
    ).capability;
    const previousPage = await fixture.service.manifest({
      capability: fixCapability,
      pair: "previous",
    });
    expect(previousPage.metadata).toMatchObject({
      pair: "previous",
      snapshotId: fixVerifier.manifest.snapshotId,
    });

    const foreign = fixture.runs.b;
    expectSyncErrorCode(
      () =>
        fixture.service.issueCapability({
          ...fixture.binding(first),
          snapshotId: foreign.manifest.snapshotId,
        }),
      "FORBIDDEN",
    );
    const foreignReport = testReport("e".repeat(40));
    const foreignBytes = new TextEncoder().encode(
      JSON.stringify(foreignReport),
    );
    const foreignCapability = fixture.service.issueCapability(
      fixture.binding(foreign),
    ).capability;
    const foreignArtifact = await fixture.service.ingestTestResult({
      capability: foreignCapability,
      artifactBytes: foreignBytes,
      expectedSha256: sha256(foreignBytes),
      expectedSizeBytes: foreignBytes.byteLength,
    });
    expect(foreignArtifact.sha256).toBe(sha256(foreignBytes));

    const foreignProvenance = {
      reviewId: foreign.review.reviewId,
      cycleId: foreign.review.cycleId,
      runId: foreign.runId,
      attemptId: foreign.attemptId,
      direction: "tests" as const,
      role: "reviewer" as const,
    };
    expectSyncErrorCode(
      () =>
        fixture.service.issueCapability({
          ...fixture.binding(
            adjudicator,
            undefined,
            "adjudicator",
            "correctness",
          ),
          boundTestArtifacts: [
            { source: foreignProvenance, reference: foreignArtifact },
          ],
        }),
      "FORBIDDEN",
    );

    const ownReport = testReport("f".repeat(40));
    const ownBytes = new TextEncoder().encode(JSON.stringify(ownReport));
    await fixture.service.ingestTestResult({
      capability,
      artifactBytes: ownBytes,
      expectedSha256: sha256(ownBytes),
      expectedSizeBytes: ownBytes.byteLength,
    });
    const visibleResults = await fixture.service.testResults({ capability });
    expect(visibleResults.items).toHaveLength(1);
    const ownResult = visibleResults.items[0];
    if (ownResult === undefined)
      throw new Error("Expected the current test result.");
    expect(ownResult).toMatchObject({
      runId: first.runId,
      attemptId: first.attemptId,
      commitSha: "f".repeat(40),
      executionTrust: "UNVERIFIED",
      artifactIntegrity: "VERIFIED_SHA256_SIZE",
      applicability: "NOT_APPLICABLE_STALE",
    });
    expect(visibleResults.items[0]?.runId).not.toBe(foreign.runId);

    const secondTestRun = fixture.runs.testsA2;
    const secondTestCapability = fixture.service.issueCapability(
      fixture.binding(secondTestRun),
    ).capability;
    const secondReport = {
      ...testReport(first.manifest.headSha),
      producer: "second-test-worker",
    };
    const secondBytes = new TextEncoder().encode(JSON.stringify(secondReport));
    const secondArtifact = await fixture.service.ingestTestResult({
      capability: secondTestCapability,
      artifactBytes: secondBytes,
      expectedSha256: sha256(secondBytes),
      expectedSizeBytes: secondBytes.byteLength,
    });
    const adjudicatorBinding = fixture.binding(
      adjudicator,
      undefined,
      "adjudicator",
      "correctness",
    );
    const source = (run: TestRun) => ({
      reviewId: run.review.reviewId,
      cycleId: run.review.cycleId,
      runId: run.runId,
      attemptId: run.attemptId,
      direction: "tests" as const,
      role: "reviewer" as const,
    });
    const aggregateCapability = fixture.service.issueCapability({
      ...adjudicatorBinding,
      boundTestArtifacts: [
        { source: source(first), reference: ownResult.artifact },
        { source: source(secondTestRun), reference: secondArtifact },
      ],
    }).capability;
    const aggregateRunIds: string[] = [];
    let aggregateCursor: string | null = null;
    do {
      const page = await fixture.service.testResults({
        capability: aggregateCapability,
        pageSize: 1,
        ...(aggregateCursor === null ? {} : { cursor: aggregateCursor }),
      });
      expect(page.metadata.total).toBe(2);
      aggregateRunIds.push(...page.items.map((item) => item.runId));
      aggregateCursor = page.metadata.cursor;
    } while (aggregateCursor !== null);
    expect(new Set(aggregateRunIds).size).toBe(2);
    expect(aggregateRunIds).toContain(first.runId);
    expect(aggregateRunIds).toContain(secondTestRun.runId);
    expect(aggregateRunIds).not.toContain(foreign.runId);
  } finally {
    await fixture.close();
  }
});

test("NR-06 AC3 pages files, diffs, and literal search without omissions", async () => {
  const fixture = await createFixture();
  try {
    const run = fixture.runs.a;
    const capability = fixture.service.issueCapability(
      fixture.binding(run),
    ).capability;

    const listed: string[] = [];
    let fileCursor: string | null = null;
    do {
      const page = await fixture.service.listFiles({
        capability,
        side: "head",
        pageSize: 1,
        ...(fileCursor === null ? {} : { cursor: fileCursor }),
      });
      listed.push(...page.items.map((item) => item.pathBytesBase64));
      fileCursor = page.metadata.cursor;
    } while (fileCursor !== null);
    expect(listed.length).toBeGreaterThan(4);
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).toEqual(
      [...listed].sort((left, right) =>
        Buffer.from(left, "base64").compare(Buffer.from(right, "base64")),
      ),
    );

    const manifestPaths: string[] = [];
    let manifestCursor: string | null = null;
    do {
      const page = await fixture.service.manifest({
        capability,
        pageSize: 1,
        ...(manifestCursor === null ? {} : { cursor: manifestCursor }),
      });
      manifestPaths.push(...page.items.map((item) => item.pathBytesBase64));
      manifestCursor = page.metadata.cursor;
    } while (manifestCursor !== null);
    expect(manifestPaths.length).toBeGreaterThan(1);
    expect(new Set(manifestPaths).size).toBe(manifestPaths.length);

    const changes: string[] = [];
    let diffCursor: string | null = null;
    do {
      const page = await fixture.service.diff({
        capability,
        pageSize: 1,
        ...(diffCursor === null ? {} : { cursor: diffCursor }),
      });
      changes.push(...page.items.map((item) => item.pathBytesBase64));
      diffCursor = page.metadata.cursor;
    } while (diffCursor !== null);
    expect(changes.length).toBeGreaterThan(1);
    expect(new Set(changes).size).toBe(changes.length);

    const matches: string[] = [];
    let searchCursor: string | null = null;
    let finalSearch:
      | Awaited<ReturnType<ReviewContextService["search"]>>
      | undefined;
    do {
      const page = await fixture.service.search({
        capability,
        side: "head",
        query: "needle",
        pageSize: 1,
        ...(searchCursor === null ? {} : { cursor: searchCursor }),
      });
      matches.push(
        ...page.items.map((item) => `${item.path}:${item.line}:${item.column}`),
      );
      searchCursor = page.metadata.cursor;
      finalSearch = page;
    } while (searchCursor !== null);
    expect(matches).toEqual([
      "modify.txt:1:1",
      "modify.txt:2:3",
      "modify.txt:3:1",
      "query.txt:1:1",
    ]);
    expect(finalSearch?.metadata.truncated).toBe(false);
    expect(finalSearch?.totalExact).toBe(false);
    expect(finalSearch?.skippedByState.BINARY).toBe(1);
    expect(finalSearch?.skippedByState.INVALID_UTF8).toBe(1);

    const changedPage = await fixture.service.diff({
      capability,
      pageSize: 1,
    });
    expect(changedPage.metadata.cursor).not.toBeNull();
    const changedCursor = changedPage.metadata.cursor;
    if (changedCursor === null) throw new Error("Expected a diff cursor.");
    await expect(
      fixture.service.diff({
        capability,
        pageSize: 2,
        cursor: changedCursor,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const cursorTail = changedCursor.at(-1);
    const replacementTail = cursorTail === "A" ? "B" : "A";
    const tamperedCursor = `${changedCursor.slice(0, -1)}${replacementTail}`;
    await expect(
      fixture.service.diff({ capability, pageSize: 1, cursor: tamperedCursor }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  } finally {
    await fixture.close();
  }
});

test("NR-06 AC4 handles empty, UTF-8, binary, bounded, and invalid content explicitly", async () => {
  const fixture = await createFixture({ maxSearchScannedBytes: 16 });
  try {
    const capability = fixture.service.issueCapability(
      fixture.binding(fixture.runs.a),
    ).capability;
    const empty = await fixture.service.readFile({
      capability,
      side: "head",
      path: "empty.txt",
    });
    expect(empty.text).toBe("");
    expect(empty.metadata.truncated).toBe(false);

    const first = await fixture.service.readFile({
      capability,
      side: "head",
      path: "unicode.txt",
      maxBytes: 4,
    });
    expect(first.text).toBe("🙂");
    expect(first.metadata.cursor).not.toBeNull();
    const fileCursor = first.metadata.cursor;
    if (fileCursor === null) throw new Error("Expected a file cursor.");
    const second = await fixture.service.readFile({
      capability,
      side: "head",
      path: "unicode.txt",
      maxBytes: 4,
      cursor: fileCursor,
    });
    expect(second.text).toBe("B");
    expect(second.metadata.truncated).toBe(false);
    await expect(
      fixture.service.readFile({
        capability,
        side: "head",
        path: "unicode.txt",
        maxBytes: 1,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_TOO_LARGE" });

    const invalidUtf8 = await fixture.service.readFile({
      capability,
      side: "head",
      path: "invalid-utf8.bin",
    });
    expect(invalidUtf8).toMatchObject({
      encoding: "base64",
      contentState: "INVALID_UTF8",
    });

    const binary = await fixture.service.readFile({
      capability,
      side: "head",
      path: "binary.dat",
    });
    expect(binary).toMatchObject({
      encoding: "base64",
      contentState: "BINARY",
    });
    expect(binary.bytesBase64).toBe(Buffer.from([0, 1, 2]).toString("base64"));

    const tinyLimit = await fixture.service.search({
      capability,
      side: "head",
      query: "needle",
      pageSize: 50,
    });
    expect(tinyLimit.scannedBytes).toBeLessThanOrEqual(16);
    expect(tinyLimit.skippedByState.INSPECTION_LIMIT).toBeGreaterThan(0);
    expect(tinyLimit.totalExact).toBe(false);

    await expect(
      fixture.service.search({
        capability,
        side: "head",
        query: "needle",
        mode: "regex",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  } finally {
    await fixture.close();
  }
});

test("NR-06 AC4 reports unchanged LFS pointers and incomplete search coverage", async () => {
  const fixture = await createFixture(undefined, true);
  try {
    const capability = fixture.service.issueCapability(
      fixture.binding(fixture.runs.a),
    ).capability;
    const files = await fixture.service.listFiles({
      capability,
      side: "head",
      pageSize: 50,
    });
    expect(
      files.items.find((item) => item.path === "steady-lfs.dat"),
    ).toMatchObject({
      contentState: "LFS_POINTER",
      lfs: {
        oid: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        sizeBytes: 2048,
      },
    });

    const file = await fixture.service.readFile({
      capability,
      side: "head",
      path: "steady-lfs.dat",
    });
    expect(file).toMatchObject({
      encoding: "utf-8",
      contentState: "LFS_POINTER",
      text: lfsPointer,
    });

    const search = await fixture.service.search({
      capability,
      side: "head",
      query: "oid sha256:",
      pageSize: 50,
    });
    expect(search.totalExact).toBe(false);
    expect(search.skippedByState.LFS_POINTER).toBe(1);
    expect(search.items).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("NR-06 AC2 rejects forged, expired, revoked, run-revoked, and closed capabilities for every tool", async () => {
  const fixture = await createFixture();
  try {
    const binding = fixture.binding(fixture.runs.a);
    const expired = fixture.service.issueCapability({
      ...binding,
      expiresAtUtc: new Date(Date.now() + 1_000).toISOString(),
    }).capability;
    await new Promise((resolve) => setTimeout(resolve, 1_010));

    const revoked = fixture.service.issueCapability(binding).capability;
    fixture.service.revokeCapability(revoked);
    const runRevoked = fixture.service.issueCapability(binding).capability;
    expect(fixture.service.revokeRun(binding.runId)).toBeGreaterThan(0);

    const calls = (capability: string) => [
      () => fixture.service.manifest({ capability }),
      () => fixture.service.diff({ capability }),
      () =>
        fixture.service.readFile({
          capability,
          side: "head",
          path: "steady.txt",
        }),
      () =>
        fixture.service.search({ capability, side: "head", query: "needle" }),
      () => fixture.service.listFiles({ capability, side: "head" }),
      () => fixture.service.testResults({ capability }),
      () =>
        fixture.service.ingestTestResult({
          capability,
          artifactBytes: new Uint8Array([1]),
          expectedSha256: "0".repeat(64),
          expectedSizeBytes: 1,
        }),
    ];
    expect(calls(expired)).toHaveLength(REVIEW_CONTEXT_TOOLS.length + 1);
    for (const capability of [expired, revoked, runRevoked, "A".repeat(43)]) {
      for (const call of calls(capability)) {
        await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
    }

    fixture.service.close();
    await expect(
      fixture.service.manifest({ capability: expired }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expectSyncErrorCode(
      () => fixture.service.issueCapability(binding),
      "FORBIDDEN",
    );
  } finally {
    await fixture.close();
  }
});

test("test-result ingestion verifies bytes, preserves provenance, and is idempotent", async () => {
  const fixture = await createFixture();
  try {
    const run = fixture.runs.a;
    const capability = fixture.service.issueCapability(
      fixture.binding(run),
    ).capability;
    const document = testReport(run.manifest.headSha);
    const bytes = new TextEncoder().encode(JSON.stringify(document));
    const validRequest = {
      capability,
      artifactBytes: bytes,
      expectedSha256: sha256(bytes),
      expectedSizeBytes: bytes.byteLength,
    };
    await expect(
      fixture.service.ingestTestResult({
        ...validRequest,
        expectedSha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const first = await fixture.service.ingestTestResult(validRequest);
    const second = await fixture.service.ingestTestResult(validRequest);
    expect(second).toEqual(first);
    const results = await fixture.service.testResults({ capability });
    expect(results.items[0]).toMatchObject({
      reviewId: run.review.reviewId,
      cycleId: run.review.cycleId,
      direction: "tests",
      role: "reviewer",
      commitSha: run.manifest.headSha,
      executionTrust: "UNVERIFIED",
      applicability: "APPLICABLE",
      artifact: first,
    });

    const different = new TextEncoder().encode(
      JSON.stringify({ ...document, producer: "another-claimed-producer" }),
    );
    await expect(
      fixture.service.ingestTestResult({
        capability,
        artifactBytes: different,
        expectedSha256: sha256(different),
        expectedSizeBytes: different.byteLength,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  } finally {
    await fixture.close();
  }
});

async function createFixture(
  limits?: Parameters<typeof createReviewContextService>[0]["limits"],
  withUnchangedLfsPointer = false,
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nightreviewer-nr06-"));
  await chmod(root, 0o700);
  const hooksDir = path.join(root, "hooks");
  const repo = path.join(root, "source");
  await mkdir(hooksDir, { mode: 0o700 });
  await git(
    path.dirname(repo),
    ["init", "--quiet", "--object-format=sha1", repo],
    hooksDir,
  );
  await git(repo, ["config", "user.name", "NR-06 Fixture"], hooksDir);
  await git(repo, ["config", "user.email", "nr06@example.invalid"], hooksDir);
  await writeFile(path.join(repo, "deleted.txt"), "deleted on head\n");
  await writeFile(path.join(repo, "modify.txt"), "before\n");
  await writeFile(path.join(repo, "steady.txt"), "unchanged snapshot file\n");
  if (withUnchangedLfsPointer) {
    await writeFile(path.join(repo, "steady-lfs.dat"), lfsPointer);
  }
  await git(repo, ["add", "--all", "--", "."], hooksDir);
  await git(repo, ["commit", "--quiet", "-m", "base"], hooksDir);
  const baseSha = await gitText(repo, ["rev-parse", "HEAD"], hooksDir);

  await rm(path.join(repo, "deleted.txt"));
  await writeFile(
    path.join(repo, "modify.txt"),
    "needle first\né needle two\nneedle third\n",
  );
  await writeFile(path.join(repo, "query.txt"), "needle in added file\n");
  await writeFile(path.join(repo, "unicode.txt"), "🙂B");
  await writeFile(path.join(repo, "empty.txt"), new Uint8Array());
  await writeFile(path.join(repo, "binary.dat"), new Uint8Array([0, 1, 2]));
  await writeFile(
    path.join(repo, "invalid-utf8.bin"),
    new Uint8Array([0xc3, 0x28]),
  );
  await git(repo, ["add", "--all", "--", "."], hooksDir);
  await git(repo, ["commit", "--quiet", "-m", "head"], hooksDir);
  const headSha = await gitText(repo, ["rev-parse", "HEAD"], hooksDir);

  const store = await openStorage({ rootDir: path.join(root, "store") });
  const fixtureRepoId = "fixture/nightreviewer-nr06";
  const createReview = async (id: string): Promise<CreatedReview> =>
    store.createReview({
      callerId: "nr06-test",
      submission: {
        ...validProtocolExamples.reviewSubmitInput,
        repoId: fixtureRepoId,
        baseSha,
        headSha,
        idempotencyKey: `nr06-${id}-${headSha.slice(0, 8)}`,
      },
      reviewContextHash: protocolExampleSha256,
      versionBinding: versionHashBindingExample,
      createdAtUtc: new Date().toISOString(),
    });
  const reviewA = await createReview("a");
  const reviewB = await createReview("b");
  for (const review of [reviewA, reviewB]) {
    store.applyCycleCommand("nr06-test", review.cycleId, {
      type: "ADVANCE",
      target: "SNAPSHOTTING",
      expectedVersion: 0,
      idempotencyKey: `nr06-snapshot-${review.cycleId}`,
    });
  }
  const snapshotService = await createSnapshotService({
    store,
    repositoryPaths: new Map([[fixtureRepoId, repo]]),
  });
  const manifestA = await snapshotService.createSnapshot({
    cycleId: reviewA.cycleId,
  });
  const manifestB = await snapshotService.createSnapshot({
    cycleId: reviewB.cycleId,
  });
  const runs: Record<
    "a" | "b" | "testsA2" | "adjudicatorA" | "fixVerifierA",
    TestRun
  > = {
    a: makeRun(store, reviewA, manifestA, "a"),
    b: makeRun(store, reviewB, manifestB, "b"),
    testsA2: makeRun(store, reviewA, manifestA, "a2"),
    adjudicatorA: makeRun(
      store,
      reviewA,
      manifestA,
      "adj-a",
      "adjudicator",
      "correctness",
    ),
    fixVerifierA: makeRun(
      store,
      reviewA,
      manifestA,
      "fix-a",
      "fix_verifier",
      "correctness",
    ),
  };
  const service = createReviewContextService({
    store,
    snapshotService,
    ...(limits === undefined ? {} : { limits }),
  });

  return {
    root,
    store,
    service,
    runs,
    binding(
      run,
      expiresAtUtc = new Date(Date.now() + 3_600_000).toISOString(),
      role: "reviewer" | "adjudicator" | "fix_verifier" = "reviewer",
      direction: "correctness" | "tests" | "design" = "tests",
    ) {
      const allowedTools =
        role === "adjudicator"
          ? ([
              "review_context_manifest",
              "review_context_diff",
              "review_context_read_file",
              "review_context_test_results",
            ] as const)
          : REVIEW_CONTEXT_TOOLS;
      return {
        reviewId: run.review.reviewId,
        cycleId: run.review.cycleId,
        runId: run.runId,
        attemptId: run.attemptId,
        direction,
        role,
        snapshotId: run.manifest.snapshotId,
        baseSha: run.manifest.baseSha,
        headSha: run.manifest.headSha,
        ...(role === "fix_verifier"
          ? {
              previousSnapshot: {
                cycleId: run.review.cycleId,
                snapshotId: run.manifest.snapshotId,
                baseSha: run.manifest.baseSha,
                headSha: run.manifest.headSha,
              },
            }
          : {}),
        expiresAtUtc,
        allowedTools,
      };
    },
    async close() {
      service.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function makeRun(
  store: SqliteStorage,
  review: CreatedReview,
  manifest: SnapshotManifest,
  suffix: string,
  role: "reviewer" | "adjudicator" | "fix_verifier" = "reviewer",
  direction: "correctness" | "tests" | "design" = "tests",
): TestRun {
  const runId = `nr06-run-${suffix}`;
  const attemptId = `nr06-attempt-${suffix}`;
  store.recordDirectionRun({
    runId,
    cycleId: review.cycleId,
    direction,
    role,
    promptHash: protocolExampleSha256,
    schemaHash: protocolExampleSha256,
    policyHash: protocolExampleSha256,
    createdAtUtc: new Date().toISOString(),
  });
  store.appendWorkerAttempt({
    attemptId,
    directionRunId: runId,
    attemptNumber: 1,
    model: "test-model",
    effort: "low",
    startedAtUtc: new Date().toISOString(),
  });
  return { review, manifest, runId, attemptId };
}

function testReport(commitSha: string) {
  return {
    schemaVersion: "nr-test-result/1",
    commitSha,
    command: "bun run verify",
    exitCode: 0,
    startedAtUtc: "2026-10-04T10:00:00.000Z",
    finishedAtUtc: "2026-10-04T10:00:01.000Z",
    environment: {
      os: "darwin",
      arch: "arm64",
      runtime: "bun",
      runtimeVersion: "1.4.2",
      ci: false,
    },
    producer: "fixture-claim",
  } as const;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectSyncErrorCode(action: () => unknown, code: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code });
}

async function git(
  cwd: string,
  args: readonly string[],
  hooksDir: string,
): Promise<Uint8Array> {
  const child = Bun.spawn(
    ["git", "-c", `core.hooksPath=${hooksDir}`, ...args],
    {
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: os.tmpdir(),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ALLOW_PROTOCOL: "",
        GIT_LFS_SKIP_SMUDGE: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Fixture Git command failed (${exitCode}): ${stderr}`);
  }
  return new Uint8Array(stdout);
}

async function gitText(
  cwd: string,
  args: readonly string[],
  hooksDir: string,
): Promise<string> {
  return new TextDecoder().decode(await git(cwd, args, hooksDir)).trim();
}
