import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  hashCanonicalJson,
  protocolExampleSha256,
  validProtocolExamples,
  versionHashBindingExample,
} from "../../src/protocol";
import {
  createSnapshotService,
  defaultSnapshotLimits,
  type SnapshotService,
} from "../../src/snapshot";
import { createGitWorkspace, resolveCommitTree } from "../../src/snapshot/git";
import {
  openStorage,
  restoreStorageBackup,
  type SqliteStorage,
} from "../../src/storage";

const timestamp = "2026-10-03T12:00:00.000Z";
const fixtureRepoId = "fixture/nightreviewer";
const lfsPointer =
  "version https://git-lfs.github.com/spec/v1\n" +
  "oid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n" +
  "size 2048\n";

interface Fixture {
  readonly root: string;
  readonly repo: string;
  readonly cycleId: string;
  readonly snapshotService: SnapshotService;
  readonly store: SqliteStorage;
  readonly headSha: string;
  close(stores?: readonly (SqliteStorage | undefined)[]): Promise<void>;
}

test("NR-05 AC1 records an immutable base-to-head diff and safely reads Git objects", async () => {
  const fixture = await createFixture();
  try {
    const manifest = await fixture.snapshotService.createSnapshot({
      cycleId: fixture.cycleId,
      specSha256: hashCanonicalJson("nr-05-spec"),
    });
    expect(manifest.mergeBaseSha).toBe(manifest.baseSha);
    expect(manifest.diffPolicy).toMatchObject({
      direction: "BASE_TREE_TO_HEAD_TREE",
      renameDetection: "git-diff-tree-M50%",
      copyDetection: false,
    });
    expect(manifest.changes.map((change) => change.status)).toEqual(
      expect.arrayContaining([
        "ADDED",
        "MODIFIED",
        "DELETED",
        "RENAMED",
        "TYPE_CHANGED",
      ]),
    );

    const reader = await fixture.snapshotService.openSnapshot(
      fixture.cycleId,
      manifest.snapshotId,
    );
    try {
      const committedBytes = new TextEncoder().encode("head version\n");
      await writeFile(
        path.join(fixture.repo, "spaces ü.txt"),
        "worktree-only\n",
      );
      await git(fixture.repo, ["add", "--", "spaces ü.txt"]);
      expect(await readGitBlob(reader, "spaces ü.txt", "head")).toEqual(
        committedBytes,
      );
      expect(
        new TextDecoder().decode(
          await readGitBlob(reader, "rename new.txt", "head"),
        ),
      ).toBe("rename payload\n");
      expect(
        new TextDecoder().decode(
          await readGitBlob(reader, "rename-old.txt", "base"),
        ),
      ).toBe("rename payload\n");
      expect(
        (await reader.listFiles("head")).map((entry) => entry.path),
      ).toContain("steady.txt");
      expect(
        new TextDecoder().decode(
          (await reader.readFile("steady.txt", "head")).bytes,
        ),
      ).toBe("unchanged snapshot file\n");
    } finally {
      await reader.close();
    }
  } finally {
    await fixture.close();
  }
});

test("NR-05 AC2 retains commits, trees, blobs, diff, and manifest after GC and source removal", async () => {
  const fixture = await createFixture();
  let restored: SqliteStorage | undefined;
  try {
    const manifest = await fixture.snapshotService.createSnapshot({
      cycleId: fixture.cycleId,
    });
    const backupPath = path.join(fixture.root, "backup");
    await fixture.store.createBackup(backupPath);
    await git(fixture.repo, ["gc", "--prune=now"]);
    await rm(fixture.repo, { recursive: true, force: true });

    restored = await restoreStorageBackup(
      backupPath,
      path.join(fixture.root, "restored-store"),
    );
    const recoveredService = await createSnapshotService({
      store: restored,
      repositoryPaths: new Map(),
    });
    const reader = await recoveredService.openSnapshot(
      fixture.cycleId,
      manifest.snapshotId,
    );
    try {
      expect(reader.manifest).toEqual(manifest);
      expect(reader.diff).toEqual(manifest.changes);
      expect(
        new TextDecoder().decode(
          await readGitBlob(reader, "spaces ü.txt", "head"),
        ),
      ).toBe("head version\n");
      expect(reader.manifest.baseTreeSha).toMatch(/^[0-9a-f]{40}$/);
      expect(reader.manifest.headTreeSha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await reader.close();
    }
  } finally {
    await fixture.close([restored]);
  }
});

test("NR-05 AC3/AC4 rejects traversal and option revisions and records explicit coverage gaps", async () => {
  const fixture = await createFixture();
  try {
    const manifest = await fixture.snapshotService.createSnapshot({
      cycleId: fixture.cycleId,
    });
    expect(manifest.coverage.complete).toBe(false);
    expect(manifest.coverage.limitations).toEqual(
      expect.arrayContaining([
        "BINARY_CONTENT",
        "BLOB_READ_LIMIT",
        "LFS_PAYLOAD_NOT_EMBEDDED",
        "SUBMODULE_NOT_TRAVERSED",
      ]),
    );
    expect(
      manifest.changes.find((change) => change.path === "large.dat")?.head
        ?.contentState,
    ).toBe("TOO_LARGE");
    expect(
      manifest.changes.find((change) => change.path === "lfs.dat")?.head
        ?.contentState,
    ).toBe("LFS_POINTER");

    const reader = await fixture.snapshotService.openSnapshot(
      fixture.cycleId,
      manifest.snapshotId,
    );
    try {
      expect(
        new TextDecoder().decode(
          await readGitBlob(reader, "-dash.txt", "head"),
        ),
      ).toBe("option-like path\n");
      expect(
        new TextDecoder().decode(
          await readGitBlob(reader, "type-change", "head"),
        ),
      ).toBe("../outside-secret.txt");
      await expect(reader.readFile("../outside", "head")).rejects.toMatchObject(
        { code: "INVALID_ARGUMENT" },
      );
      await expect(reader.readFile("submodule", "head")).rejects.toMatchObject({
        code: "CONTENT_UNAVAILABLE",
      });
      await expect(reader.readFile("large.dat", "head")).rejects.toMatchObject({
        code: "CONTENT_UNAVAILABLE",
      });
    } finally {
      await reader.close();
    }

    const workspace = await createGitWorkspace();
    try {
      await expect(
        resolveCommitTree(
          workspace,
          fixture.repo,
          "--help",
          "sha1",
          defaultSnapshotLimits,
          Date.now() + 5_000,
        ),
      ).rejects.toMatchObject({ code: "REVISION_INVALID" });
    } finally {
      await workspace.close();
    }
  } finally {
    await fixture.close();
  }
});

test("snapshot failure marks the pinned cycle FAILED before it can be scheduled", async () => {
  const fixture = await createFixture();
  try {
    const withoutRepository = await createSnapshotService({
      store: fixture.store,
      repositoryPaths: new Map(),
    });
    await expect(
      withoutRepository.createSnapshot({ cycleId: fixture.cycleId }),
    ).rejects.toMatchObject({ code: "REPOSITORY_UNAVAILABLE" });
    expect(fixture.store.readCycle(fixture.cycleId).state).toBe("FAILED");
  } finally {
    await fixture.close();
  }
});

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nightreviewer-nr05-"));
  await chmod(root, 0o700);
  const repo = path.join(root, "source");
  const submoduleRepo = path.join(root, "submodule-source");
  const outside = path.join(root, "outside-secret.txt");
  const hooksDir = path.join(root, "empty-hooks");
  await mkdir(hooksDir, { mode: 0o700 });
  await writeFile(outside, "must not be followed\n");
  await initRepo(repo, hooksDir);
  await initRepo(submoduleRepo, hooksDir);
  await writeFile(path.join(submoduleRepo, "sub.txt"), "submodule object\n");
  await git(submoduleRepo, ["add", "--all", "--", "."], hooksDir);
  await git(
    submoduleRepo,
    ["commit", "--quiet", "-m", "submodule one"],
    hooksDir,
  );
  const firstSubmoduleSha = await gitText(
    submoduleRepo,
    ["rev-parse", "HEAD"],
    hooksDir,
  );
  await writeFile(
    path.join(submoduleRepo, "sub.txt"),
    "submodule object two\n",
  );
  await git(submoduleRepo, ["add", "--all", "--", "."], hooksDir);
  await git(
    submoduleRepo,
    ["commit", "--quiet", "-m", "submodule two"],
    hooksDir,
  );
  const secondSubmoduleSha = await gitText(
    submoduleRepo,
    ["rev-parse", "HEAD"],
    hooksDir,
  );

  await writeFile(path.join(repo, "rename-old.txt"), "rename payload\n");
  await writeFile(path.join(repo, "delete.txt"), "delete me\n");
  await writeFile(path.join(repo, "modify.txt"), "before\n");
  await writeFile(path.join(repo, "type-change"), "was a regular file\n");
  await writeFile(path.join(repo, "steady.txt"), "unchanged snapshot file\n");
  await git(repo, ["add", "--all", "--", "."], hooksDir);
  await git(
    repo,
    [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${firstSubmoduleSha},submodule`,
    ],
    hooksDir,
  );
  await git(repo, ["commit", "--quiet", "-m", "base"], hooksDir);
  const baseSha = await gitText(repo, ["rev-parse", "HEAD"], hooksDir);

  await rm(path.join(repo, "rename-old.txt"));
  await rm(path.join(repo, "delete.txt"));
  await writeFile(path.join(repo, "rename new.txt"), "rename payload\n");
  await writeFile(path.join(repo, "modify.txt"), "after\n");
  await rm(path.join(repo, "type-change"));
  await symlink("../outside-secret.txt", path.join(repo, "type-change"));
  await writeFile(path.join(repo, "-dash.txt"), "option-like path\n");
  await writeFile(path.join(repo, "spaces ü.txt"), "head version\n");
  await writeFile(path.join(repo, "binary.dat"), new Uint8Array([0, 1, 2, 3]));
  await writeFile(
    path.join(repo, "large.dat"),
    new Uint8Array(defaultSnapshotLimits.maxBlobReadBytes + 1).fill(65),
  );
  await writeFile(path.join(repo, "lfs.dat"), lfsPointer);
  await git(
    repo,
    [
      "add",
      "--all",
      "--",
      "rename-old.txt",
      "delete.txt",
      "modify.txt",
      "type-change",
      "-dash.txt",
      "spaces ü.txt",
      "binary.dat",
      "large.dat",
      "lfs.dat",
      "rename new.txt",
    ],
    hooksDir,
  );
  await git(
    repo,
    ["update-index", "--cacheinfo", `160000,${secondSubmoduleSha},submodule`],
    hooksDir,
  );
  await git(repo, ["commit", "--quiet", "-m", "head"], hooksDir);
  const headSha = await gitText(repo, ["rev-parse", "HEAD"], hooksDir);

  const store = await openStorage({ rootDir: path.join(root, "store") });
  const review = await store.createReview({
    callerId: "snapshot-test",
    submission: {
      ...validProtocolExamples.reviewSubmitInput,
      repoId: fixtureRepoId,
      baseSha,
      headSha,
      idempotencyKey: `submit-${headSha.slice(0, 12)}`,
    },
    reviewContextHash: protocolExampleSha256,
    versionBinding: versionHashBindingExample,
    createdAtUtc: timestamp,
  });
  store.applyCycleCommand("snapshot-test", review.cycleId, {
    type: "ADVANCE",
    target: "SNAPSHOTTING",
    expectedVersion: 0,
    idempotencyKey: `snapshot-${headSha.slice(0, 12)}`,
  });
  const snapshotService = await createSnapshotService({
    store,
    repositoryPaths: new Map([[fixtureRepoId, repo]]),
  });
  return {
    root,
    repo,
    cycleId: review.cycleId,
    snapshotService,
    store,
    headSha,
    async close(stores = []) {
      for (const item of [store, ...stores]) {
        try {
          item?.close();
        } catch {
          // Continue fixture cleanup if the test already closed this store.
        }
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function initRepo(repo: string, hooksDir: string): Promise<void> {
  await git(
    path.dirname(repo),
    ["init", "--quiet", "--object-format=sha1", repo],
    hooksDir,
  );
  await git(repo, ["config", "user.name", "Snapshot Fixture"], hooksDir);
  await git(
    repo,
    ["config", "user.email", "snapshot-fixture@example.invalid"],
    hooksDir,
  );
}

async function git(
  cwd: string,
  args: readonly string[],
  hooksDir?: string,
): Promise<Uint8Array> {
  const config =
    hooksDir === undefined ? [] : ["-c", `core.hooksPath=${hooksDir}`];
  const child = Bun.spawn(["git", ...config, ...args], {
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
  });
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
  hooksDir?: string,
): Promise<string> {
  return new TextDecoder().decode(await git(cwd, args, hooksDir)).trim();
}

async function readGitBlob(
  reader: Awaited<ReturnType<SnapshotService["openSnapshot"]>>,
  filePath: string,
  side: "base" | "head",
): Promise<Uint8Array> {
  return (await reader.readFile(filePath, side)).bytes;
}
