import { Buffer } from "node:buffer";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SnapshotError } from "./errors";
import type { SnapshotLimits } from "./types";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const utf8WithReplacement = new TextDecoder("utf-8");
const ascii = new TextDecoder("ascii");

export interface GitWorkspace {
  readonly rootDir: string;
  readonly hooksDir: string;
  readonly globalConfigPath: string;
  readonly emptyAttributesPath: string;
  readonly abortSignal?: AbortSignal;
  close(): Promise<void>;
}

export interface GitCommandOptions {
  readonly limits: SnapshotLimits;
  readonly deadlineAt: number;
  readonly maxStdoutBytes?: number;
  readonly stdinBytes?: Uint8Array;
}

export interface GitTreeEntry {
  readonly path: string;
  readonly pathBytes: Uint8Array;
  readonly pathBytesBase64: string;
  readonly pathUtf8Valid: boolean;
  readonly mode: string;
  readonly objectType: "tree" | "blob" | "commit";
  readonly oid: string;
  readonly sizeBytes?: number;
}

export interface GitDiffRecord {
  readonly code: "A" | "D" | "M" | "T" | "R";
  readonly oldPath?: Uint8Array;
  readonly newPath?: Uint8Array;
}

export interface GitObjectInventory {
  readonly objectCount: number;
  readonly rawBytes: number;
}

export async function createGitWorkspace(
  abortSignal?: AbortSignal,
): Promise<GitWorkspace> {
  let rootDir: string | undefined;
  try {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "nightreviewer-snapshot-"));
    await chmod(rootDir, 0o700);
    const hooksDir = path.join(rootDir, "hooks");
    await mkdir(hooksDir, { mode: 0o700 });
    const xdgDir = path.join(rootDir, "xdg");
    await mkdir(xdgDir, { mode: 0o700 });
    const globalConfigPath = path.join(rootDir, "gitconfig");
    const emptyAttributesPath = path.join(rootDir, "attributes");
    await writeFile(globalConfigPath, new Uint8Array(), { mode: 0o600 });
    await writeFile(emptyAttributesPath, new Uint8Array(), { mode: 0o600 });
    return {
      rootDir,
      hooksDir,
      globalConfigPath,
      emptyAttributesPath,
      ...(abortSignal === undefined ? {} : { abortSignal }),
      async close() {
        await rm(rootDir as string, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (rootDir !== undefined) {
      await rm(rootDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    throw new SnapshotError(
      "REPOSITORY_UNAVAILABLE",
      "Could not create a private Git workspace.",
      error,
    );
  }
}

export async function runGit(
  workspace: GitWorkspace,
  cwd: string,
  args: readonly string[],
  options: GitCommandOptions,
): Promise<Uint8Array> {
  if (workspace.abortSignal?.aborted) {
    throw new SnapshotError("GIT_FAILED", "Snapshot preparation was aborted.");
  }
  const remainingMs = Math.floor(options.deadlineAt - Date.now());
  if (remainingMs <= 0) {
    throw new SnapshotError(
      "LIMIT_EXCEEDED",
      "Snapshot creation exceeded its time budget.",
    );
  }
  const stdoutLimit =
    options.maxStdoutBytes ?? options.limits.maxDiffOutputBytes;
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: workspace.rootDir,
    TMPDIR: workspace.rootDir,
    XDG_CONFIG_HOME: path.join(workspace.rootDir, "xdg"),
    GIT_CONFIG_GLOBAL: workspace.globalConfigPath,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
    LANG: "C",
  };
  for (const name of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }

  const config = [
    "-c",
    `core.hooksPath=${workspace.hooksDir}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.pager=cat",
    "-c",
    `core.attributesFile=${workspace.emptyAttributesPath}`,
    "-c",
    "diff.external=",
  ];
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timedOut = false;
  let aborted = false;
  let abortListener: (() => void) | undefined;
  const timeout = Math.min(remainingMs, options.limits.maxCreationTimeMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn(["git", ...config, ...args], {
      cwd,
      env: environment,
      stdin: options.stdinBytes === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const activeChild = child;
    abortListener = () => {
      aborted = true;
      activeChild.kill("SIGKILL");
    };
    workspace.abortSignal?.addEventListener("abort", abortListener, {
      once: true,
    });
    if (workspace.abortSignal?.aborted) abortListener();
    timer = setTimeout(() => {
      timedOut = true;
      activeChild.kill("SIGKILL");
    }, timeout);
    const writeInput = async () => {
      if (options.stdinBytes === undefined) return;
      const input = activeChild.stdin;
      if (input === null || input === undefined || typeof input === "number") {
        throw new SnapshotError(
          "GIT_FAILED",
          "Git input pipe was unavailable.",
        );
      }
      await input.write(options.stdinBytes);
      await input.end();
    };
    const [stdout, _stderr, exitCode] = await Promise.all([
      readLimited(activeChild.stdout, stdoutLimit, activeChild),
      readLimited(
        activeChild.stderr,
        options.limits.maxStderrBytes,
        activeChild,
      ),
      activeChild.exited,
      writeInput(),
    ]).then(([out, stderr, code]) => [out, stderr, code] as const);
    if (timedOut) {
      throw new SnapshotError(
        "LIMIT_EXCEEDED",
        "Snapshot creation exceeded its time budget.",
      );
    }
    if (aborted || workspace.abortSignal?.aborted) {
      throw new SnapshotError(
        "GIT_FAILED",
        "Snapshot preparation was aborted.",
      );
    }
    if (exitCode !== 0) {
      throw new SnapshotError(
        "GIT_FAILED",
        "A bounded Git object operation failed.",
      );
    }
    return stdout;
  } catch (error) {
    if (child !== undefined && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited.catch(() => undefined);
    }
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError(
      timedOut ? "LIMIT_EXCEEDED" : "GIT_FAILED",
      timedOut
        ? "Snapshot creation exceeded its time budget."
        : "A bounded Git object operation failed.",
      error,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined) {
      workspace.abortSignal?.removeEventListener("abort", abortListener);
    }
  }
}

export async function resolveAllowedRepository(
  configuredPath: string,
  workspace: GitWorkspace,
  limits: SnapshotLimits,
  deadlineAt: number,
  objectFormat: "sha1" | "sha256",
): Promise<string> {
  if (!path.isAbsolute(configuredPath)) {
    throw new SnapshotError(
      "REPOSITORY_UNAVAILABLE",
      "Allowlisted repository path must be absolute.",
    );
  }
  try {
    const rootInfo = await lstat(configuredPath);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error("Repository root is not a real directory.");
    }
    const repositoryRoot = await realpath(configuredPath);
    const topLevel = decodeLine(
      await runGit(
        workspace,
        repositoryRoot,
        ["rev-parse", "--show-toplevel"],
        {
          limits,
          deadlineAt,
          maxStdoutBytes: 16_384,
        },
      ),
    );
    if ((await realpath(topLevel)) !== repositoryRoot) {
      throw new Error("Allowlisted path is not the Git worktree root.");
    }
    const gitDir = await realpath(
      decodeLine(
        await runGit(
          workspace,
          repositoryRoot,
          ["rev-parse", "--absolute-git-dir"],
          { limits, deadlineAt, maxStdoutBytes: 16_384 },
        ),
      ),
    );
    if (!isWithin(repositoryRoot, gitDir)) {
      throw new Error("Git metadata is outside the allowlisted repository.");
    }
    try {
      await lstat(path.join(gitDir, "info", "grafts"));
      throw new Error("Git grafts are not supported for snapshot ancestry.");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    const objectsOutput = decodeLine(
      await runGit(
        workspace,
        repositoryRoot,
        ["rev-parse", "--git-path", "objects"],
        { limits, deadlineAt, maxStdoutBytes: 16_384 },
      ),
    );
    const objectsDir = await realpath(
      path.resolve(repositoryRoot, objectsOutput),
    );
    if (!isWithin(gitDir, objectsDir)) {
      throw new Error("Git object directory is outside owned metadata.");
    }
    try {
      await lstat(path.join(objectsDir, "info", "alternates"));
      throw new Error("Git object alternates are not supported.");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    const observedFormat = decodeLine(
      await runGit(
        workspace,
        repositoryRoot,
        ["rev-parse", "--show-object-format"],
        { limits, deadlineAt, maxStdoutBytes: 64 },
      ),
    );
    if (observedFormat !== objectFormat) {
      throw new SnapshotError(
        "REVISION_INVALID",
        "Repository object format does not match the pinned review cycle.",
      );
    }
    return repositoryRoot;
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError(
      "REPOSITORY_UNAVAILABLE",
      "The allowlisted source repository is unavailable or unsafe.",
      error,
    );
  }
}

export async function resolveCommitTree(
  workspace: GitWorkspace,
  repositoryRoot: string,
  oid: string,
  objectFormat: "sha1" | "sha256",
  limits: SnapshotLimits,
  deadlineAt: number,
): Promise<string> {
  const length = objectFormat === "sha1" ? 40 : 64;
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(oid)) {
    throw new SnapshotError(
      "REVISION_INVALID",
      "Pinned revision is not a full object ID.",
    );
  }
  const kind = decodeLine(
    await runGit(workspace, repositoryRoot, ["cat-file", "-t", oid], {
      limits,
      deadlineAt,
      maxStdoutBytes: 128,
    }),
  );
  if (kind !== "commit") {
    throw new SnapshotError(
      "REVISION_INVALID",
      "Pinned object is not a commit.",
    );
  }
  const tree = decodeLine(
    await runGit(
      workspace,
      repositoryRoot,
      ["rev-parse", "--verify", "--end-of-options", `${oid}^{tree}`],
      { limits, deadlineAt, maxStdoutBytes: 128 },
    ),
  );
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(tree)) {
    throw new SnapshotError(
      "GIT_FAILED",
      "Git returned a malformed tree object ID.",
    );
  }
  return tree;
}

export async function readTreeEntries(
  workspace: GitWorkspace,
  repositoryRoot: string,
  commitOid: string,
  objectFormat: "sha1" | "sha256",
  limits: SnapshotLimits,
  deadlineAt: number,
): Promise<{
  readonly entries: ReadonlyMap<string, GitTreeEntry>;
  readonly allEntries: readonly GitTreeEntry[];
}> {
  const output = await runGit(
    workspace,
    repositoryRoot,
    ["ls-tree", "-l", "-r", "-t", "-z", "--full-tree", commitOid],
    { limits, deadlineAt, maxStdoutBytes: limits.maxTreeOutputBytes },
  );
  const records = splitNul(output);
  const entries = new Map<string, GitTreeEntry>();
  const allEntries: GitTreeEntry[] = [];
  const oidLength = objectFormat === "sha1" ? 40 : 64;
  for (const record of records) {
    const tab = record.indexOf(0x09);
    if (tab < 1 || tab === record.byteLength - 1) {
      throw new SnapshotError(
        "GIT_FAILED",
        "Git returned malformed tree data.",
      );
    }
    const metadata = ascii.decode(record.subarray(0, tab));
    const match =
      /^([0-7]{5,6}) (tree|blob|commit) ([0-9a-f]+)(?:[ \t]+([0-9]+|-))?$/.exec(
        metadata,
      );
    const [, mode, rawType, oid, rawSize] = match ?? [];
    if (
      match === null ||
      mode === undefined ||
      (rawType !== "tree" && rawType !== "blob" && rawType !== "commit") ||
      oid === undefined ||
      !new RegExp(`^[0-9a-f]{${oidLength}}$`).test(oid)
    ) {
      throw new SnapshotError(
        "GIT_FAILED",
        "Git returned malformed tree metadata.",
      );
    }
    const pathBytes = new Uint8Array(record.subarray(tab + 1));
    if (pathBytes.byteLength > limits.maxPathBytes) {
      throw new SnapshotError(
        "LIMIT_EXCEEDED",
        "A repository path exceeds the configured snapshot limit.",
      );
    }
    const pathBytesBase64 = Buffer.from(pathBytes).toString("base64");
    let pathValue: string;
    let pathUtf8Valid = true;
    try {
      pathValue = utf8.decode(pathBytes);
    } catch {
      pathValue = utf8WithReplacement.decode(pathBytes);
      pathUtf8Valid = false;
    }
    let sizeBytes: number | undefined;
    if (rawType === "blob") {
      if (rawSize === undefined || !/^(0|[1-9][0-9]*)$/.test(rawSize)) {
        throw new SnapshotError(
          "GIT_FAILED",
          "Git returned a malformed blob size.",
        );
      }
      sizeBytes = Number(rawSize);
      if (!Number.isSafeInteger(sizeBytes)) {
        throw new SnapshotError(
          "LIMIT_EXCEEDED",
          "A blob size exceeds the supported snapshot range.",
        );
      }
    }
    const entry: GitTreeEntry = {
      path: pathValue,
      pathBytes,
      pathBytesBase64,
      pathUtf8Valid,
      mode,
      objectType: rawType,
      oid,
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    };
    allEntries.push(entry);
    if (rawType !== "tree") {
      if (entries.has(pathBytesBase64)) {
        throw new SnapshotError(
          "GIT_FAILED",
          "Git tree contains duplicate paths.",
        );
      }
      entries.set(pathBytesBase64, entry);
    }
  }
  return { entries, allEntries };
}

export async function readDiffRecords(
  workspace: GitWorkspace,
  repositoryRoot: string,
  baseOid: string,
  headOid: string,
  limits: SnapshotLimits,
  deadlineAt: number,
): Promise<readonly GitDiffRecord[]> {
  const output = await runGit(
    workspace,
    repositoryRoot,
    [
      "diff-tree",
      "--no-commit-id",
      "-r",
      "--name-status",
      "-z",
      "-M50%",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      baseOid,
      headOid,
    ],
    { limits, deadlineAt, maxStdoutBytes: limits.maxDiffOutputBytes },
  );
  const fields = splitNul(output);
  const records: GitDiffRecord[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = ascii.decode(fields[index] as Uint8Array);
    index += 1;
    const firstPath = fields[index];
    if (firstPath === undefined) {
      throw new SnapshotError(
        "GIT_FAILED",
        "Git returned malformed diff data.",
      );
    }
    index += 1;
    if (status.startsWith("R")) {
      const newPath = fields[index];
      if (newPath === undefined || !/^R(?:[0-9]{1,3})?$/.test(status)) {
        throw new SnapshotError(
          "GIT_FAILED",
          "Git returned malformed rename data.",
        );
      }
      index += 1;
      records.push({
        code: "R",
        oldPath: new Uint8Array(firstPath),
        newPath: new Uint8Array(newPath),
      });
      continue;
    }
    if (status === "A" || status === "D" || status === "M" || status === "T") {
      records.push({
        code: status,
        ...(status === "A"
          ? { newPath: new Uint8Array(firstPath) }
          : status === "D"
            ? { oldPath: new Uint8Array(firstPath) }
            : {
                oldPath: new Uint8Array(firstPath),
                newPath: new Uint8Array(firstPath),
              }),
      });
      continue;
    }
    throw new SnapshotError(
      "GIT_FAILED",
      "Git returned an unsupported diff status.",
    );
  }
  for (const record of records) {
    for (const pathBytes of [record.oldPath, record.newPath]) {
      if (
        pathBytes !== undefined &&
        pathBytes.byteLength > limits.maxPathBytes
      ) {
        throw new SnapshotError(
          "LIMIT_EXCEEDED",
          "A changed path exceeds the configured snapshot limit.",
        );
      }
    }
  }
  return records;
}

export async function createObjectPack(
  workspace: GitWorkspace,
  repositoryRoot: string,
  objectIds: ReadonlySet<string>,
  limits: SnapshotLimits,
  deadlineAt: number,
): Promise<Uint8Array> {
  const objectList = [...objectIds].sort();
  if (objectList.length === 0) {
    throw new SnapshotError("GIT_FAILED", "Snapshot has no Git objects.");
  }
  const input = new TextEncoder().encode(`${objectList.join("\n")}\n`);
  return runGit(
    workspace,
    repositoryRoot,
    [
      "pack-objects",
      "--stdout",
      "--no-reuse-delta",
      "--no-reuse-object",
      "--window=0",
    ],
    {
      limits,
      deadlineAt,
      maxStdoutBytes: limits.maxSnapshotArtifactBytes,
      stdinBytes: input,
    },
  );
}

export async function createBareObjectStore(
  workspace: GitWorkspace,
  bareDir: string,
  objectFormat: "sha1" | "sha256",
  pack: Uint8Array,
  limits: SnapshotLimits,
  deadlineAt: number,
): Promise<void> {
  await runGit(
    workspace,
    workspace.rootDir,
    ["init", "--bare", "--quiet", `--object-format=${objectFormat}`, bareDir],
    { limits, deadlineAt, maxStdoutBytes: 1_024 },
  );
  await runGit(workspace, bareDir, ["index-pack", "--stdin"], {
    limits,
    deadlineAt,
    maxStdoutBytes: 1_024,
    stdinBytes: pack,
  });
}

export async function readObjectSize(
  workspace: GitWorkspace,
  repositoryRoot: string,
  oid: string,
  limits: SnapshotLimits,
  deadlineAt: number,
): Promise<number> {
  const output = decodeLine(
    await runGit(workspace, repositoryRoot, ["cat-file", "-s", oid], {
      limits,
      deadlineAt,
      maxStdoutBytes: 32,
    }),
  );
  if (!/^(0|[1-9][0-9]*)$/.test(output)) {
    throw new SnapshotError(
      "GIT_FAILED",
      "Git returned an invalid object size.",
    );
  }
  const size = Number(output);
  if (!Number.isSafeInteger(size)) {
    throw new SnapshotError(
      "LIMIT_EXCEEDED",
      "A Git object size exceeds the supported snapshot range.",
    );
  }
  return size;
}

export async function readObjectInventory(
  workspace: GitWorkspace,
  bareDir: string,
  objectFormat: "sha1" | "sha256",
  limits: SnapshotLimits,
  deadlineAt: number,
): Promise<GitObjectInventory> {
  const output = await runGit(
    workspace,
    bareDir,
    [
      "cat-file",
      "--batch-all-objects",
      "--batch-check=%(objectname) %(objecttype) %(objectsize)",
    ],
    { limits, deadlineAt, maxStdoutBytes: limits.maxTreeOutputBytes },
  );
  const text = decodeLine(output);
  if (text.length === 0) {
    throw new SnapshotError("GIT_FAILED", "Snapshot object pack is empty.");
  }
  let objectCount = 0;
  let rawBytes = 0;
  const oidPattern = objectFormat === "sha1" ? "[0-9a-f]{40}" : "[0-9a-f]{64}";
  for (const line of text.split("\n")) {
    const match = new RegExp(
      `^${oidPattern} (blob|tree|commit) (0|[1-9][0-9]*)$`,
    ).exec(line);
    if (match === null) {
      throw new SnapshotError(
        "GIT_FAILED",
        "Snapshot object inventory is malformed.",
      );
    }
    objectCount += 1;
    rawBytes += Number(match[2]);
    if (
      !Number.isSafeInteger(rawBytes) ||
      rawBytes > limits.maxSnapshotObjectBytes
    ) {
      throw new SnapshotError(
        "LIMIT_EXCEEDED",
        "Snapshot object contents exceed the configured byte limit.",
      );
    }
  }
  return { objectCount, rawBytes };
}

export async function readBlobBatch(
  workspace: GitWorkspace,
  bareDir: string,
  objectSizes: ReadonlyMap<string, number>,
  limits: SnapshotLimits,
  deadlineAt: number,
): Promise<ReadonlyMap<string, Uint8Array>> {
  if (objectSizes.size === 0) return new Map();
  const objectIds = [...objectSizes.keys()].sort();
  const input = new TextEncoder().encode(`${objectIds.join("\n")}\n`);
  const expectedContentBytes = [...objectSizes.values()].reduce(
    (total, size) => total + size,
    0,
  );
  const output = await runGit(workspace, bareDir, ["cat-file", "--batch"], {
    limits,
    deadlineAt,
    maxStdoutBytes: expectedContentBytes + objectIds.length * 256 + 1,
    stdinBytes: input,
  });
  const result = new Map<string, Uint8Array>();
  let offset = 0;
  for (const expectedOid of objectIds) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) {
      throw new SnapshotError(
        "GIT_FAILED",
        "Git returned malformed blob data.",
      );
    }
    const header = ascii.decode(output.subarray(offset, headerEnd)).split(" ");
    const [oid, type, rawSize] = header;
    const expectedSize = objectSizes.get(expectedOid);
    if (
      oid !== expectedOid ||
      type !== "blob" ||
      rawSize === undefined ||
      !/^(0|[1-9][0-9]*)$/.test(rawSize) ||
      Number(rawSize) !== expectedSize
    ) {
      throw new SnapshotError(
        "GIT_FAILED",
        "Git returned inconsistent blob data.",
      );
    }
    offset = headerEnd + 1;
    const end = offset + expectedSize;
    if (end >= output.byteLength || output[end] !== 0x0a) {
      throw new SnapshotError(
        "GIT_FAILED",
        "Git returned truncated blob data.",
      );
    }
    result.set(expectedOid, new Uint8Array(output.subarray(offset, end)));
    offset = end + 1;
  }
  if (offset !== output.byteLength) {
    throw new SnapshotError("GIT_FAILED", "Git returned trailing blob data.");
  }
  return result;
}

export function decodeLine(output: Uint8Array): string {
  let value: string;
  try {
    value = utf8.decode(output);
  } catch (error) {
    throw new SnapshotError(
      "GIT_FAILED",
      "Git returned invalid text metadata.",
      error,
    );
  }
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

export function pathInfo(pathBytes: Uint8Array): {
  readonly path: string;
  readonly pathBytesBase64: string;
  readonly pathUtf8Valid: boolean;
} {
  try {
    return {
      path: utf8.decode(pathBytes),
      pathBytesBase64: Buffer.from(pathBytes).toString("base64"),
      pathUtf8Valid: true,
    };
  } catch {
    return {
      path: utf8WithReplacement.decode(pathBytes),
      pathBytesBase64: Buffer.from(pathBytes).toString("base64"),
      pathUtf8Valid: false,
    };
  }
}

export function pathBytesKey(pathBytes: Uint8Array): string {
  return Buffer.from(pathBytes).toString("base64");
}

export function comparePathBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] as number) - (right[index] as number);
    if (difference !== 0) return difference;
  }
  return left.byteLength - right.byteLength;
}

export async function removeSnapshotWorkspace(
  workspace: GitWorkspace,
): Promise<void> {
  try {
    await workspace.close();
  } catch (error) {
    throw new SnapshotError(
      "GIT_FAILED",
      "Private snapshot workspace could not be removed.",
      error,
    );
  }
}

function splitNul(output: Uint8Array): Uint8Array[] {
  const fields: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < output.byteLength; index += 1) {
    if (output[index] === 0) {
      if (index > start) fields.push(output.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < output.byteLength) {
    throw new SnapshotError(
      "GIT_FAILED",
      "Git returned unterminated path data.",
    );
  }
  return fields;
}

async function readLimited(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  maximum: number,
  child: ReturnType<typeof Bun.spawn>,
): Promise<Uint8Array> {
  if (stream === null || stream === undefined || typeof stream === "number") {
    return new Uint8Array();
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        child.kill("SIGKILL");
        throw new SnapshotError(
          "LIMIT_EXCEEDED",
          "Git output exceeded a configured snapshot limit.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
