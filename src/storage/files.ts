import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { invalidArgument, needsReconciliation, StorageError } from "./errors";
import type { ArtifactReference } from "./types";

export const DATABASE_FILE_NAME = "database.sqlite";
export const MANIFEST_FILE_NAME = "manifest.json";
export const ARTIFACTS_DIRECTORY = "artifacts/sha256";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function artifactRelativePath(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw invalidArgument(
      "Artifact SHA-256 must be 64 lowercase hexadecimal characters.",
    );
  }
  return path.posix.join(ARTIFACTS_DIRECTORY, sha256.slice(0, 2), sha256);
}

export async function ensurePrivateDirectory(
  directoryPath: string,
): Promise<void> {
  const absolutePath = path.resolve(directoryPath);
  await mkdir(absolutePath, { recursive: true, mode: 0o700 });
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw invalidArgument(
      "Storage root must be a real directory, not a symlink or file.",
    );
  }
  await chmod(absolutePath, 0o700);
}

export async function ensurePrivateChildDirectory(
  rootDir: string,
  relativePath: string,
): Promise<string> {
  if (
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).some((part) => part === ".." || part === "")
  ) {
    throw invalidArgument(
      "Storage child path must stay beneath the owned root.",
    );
  }
  const root = path.resolve(rootDir);
  const target = path.resolve(root, relativePath);
  if (path.relative(root, target).startsWith("..")) {
    throw invalidArgument("Storage child path escapes the owned root.");
  }

  let current = root;
  for (const part of relativePath.split(/[\\/]/)) {
    current = path.join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw toIoError(error);
    }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw invalidArgument(
        "Storage path contains a symlink or non-directory component.",
      );
    }
    await chmod(current, 0o700);
  }
  return target;
}

export async function ensureEmptyOwnedDirectory(
  directoryPath: string,
): Promise<string> {
  const absolutePath = path.resolve(directoryPath);
  try {
    await mkdir(absolutePath, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw toIoError(error);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw invalidArgument(
        "Destination must be a new or empty real directory.",
      );
    }
    if ((await readdir(absolutePath)).length > 0) {
      throw invalidArgument("Destination directory must be empty.");
    }
    await chmod(absolutePath, 0o700);
  }
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw invalidArgument("Destination must be a real directory.");
  }
  await chmod(absolutePath, 0o700);
  return absolutePath;
}

export async function writeAtomicFile(
  directoryPath: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<void> {
  if (
    path.basename(fileName) !== fileName ||
    fileName === "." ||
    fileName === ".."
  ) {
    throw invalidArgument("Atomic file name must be a single path component.");
  }
  const stableBytes = new Uint8Array(bytes);
  const directory = path.resolve(directoryPath);
  const finalPath = path.join(directory, fileName);
  const temporaryPath = path.join(directory, `.tmp-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(stableBytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, finalPath);
    await syncDirectory(directory);
    await chmod(finalPath, 0o600);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw toIoError(error);
  }
}

export async function persistArtifactFile(
  rootDir: string,
  bytes: Uint8Array,
): Promise<ArtifactReference> {
  const stableBytes = new Uint8Array(bytes);
  const sha256 = sha256Hex(stableBytes);
  const relativePath = artifactRelativePath(sha256);
  const parent = path.posix.dirname(relativePath);
  const directory = await ensurePrivateChildDirectory(rootDir, parent);
  const finalPath = path.join(directory, sha256);

  try {
    const existing = await lstat(finalPath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw needsReconciliation(
        "Content-addressed artifact destination is not a regular file.",
      );
    }
    const existingBytes = new Uint8Array(
      await Bun.file(finalPath).arrayBuffer(),
    );
    if (
      existing.size !== stableBytes.byteLength ||
      sha256Hex(existingBytes) !== sha256
    ) {
      throw needsReconciliation(
        "Existing content-addressed artifact does not match its name.",
      );
    }
    await chmod(finalPath, 0o600);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    const temporaryName = `.tmp-${randomUUID()}`;
    const temporaryPath = path.join(directory, temporaryName);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      await handle.writeFile(stableBytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, finalPath);
      await syncDirectory(directory);
      await chmod(finalPath, 0o600);
    } catch (writeError) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      if (isNodeError(writeError, "EEXIST")) {
        const existingBytes = new Uint8Array(
          await Bun.file(finalPath).arrayBuffer(),
        );
        if (
          sha256Hex(existingBytes) === sha256 &&
          existingBytes.byteLength === stableBytes.byteLength
        ) {
          return {
            sha256,
            sizeBytes: stableBytes.byteLength,
            relativePath,
          };
        }
      }
      throw toIoError(writeError);
    }
  }

  return { sha256, sizeBytes: stableBytes.byteLength, relativePath };
}

export async function readVerifiedArtifact(
  rootDir: string,
  reference: ArtifactReference,
): Promise<Uint8Array> {
  const expectedPath = artifactRelativePath(reference.sha256);
  if (reference.relativePath !== expectedPath) {
    throw needsReconciliation(
      "Artifact database path is not its content-addressed owned path.",
    );
  }
  const absolutePath = path.resolve(
    rootDir,
    ...reference.relativePath.split("/"),
  );
  if (path.relative(path.resolve(rootDir), absolutePath).startsWith("..")) {
    throw needsReconciliation("Artifact path escapes the owned storage root.");
  }
  try {
    const root = path.resolve(rootDir);
    for (const directoryPath of [
      path.join(root, "artifacts"),
      path.join(root, "artifacts", "sha256"),
      path.join(root, "artifacts", "sha256", reference.sha256.slice(0, 2)),
    ]) {
      const directoryInfo = await lstat(directoryPath);
      if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
        throw needsReconciliation(
          "Artifact directory path contains a symlink or non-directory component.",
        );
      }
    }
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw needsReconciliation(
        "Committed artifact is missing or is not a regular file.",
      );
    }
    const bytes = new Uint8Array(await Bun.file(absolutePath).arrayBuffer());
    if (
      info.size !== reference.sizeBytes ||
      bytes.byteLength !== reference.sizeBytes
    ) {
      throw needsReconciliation(
        "Committed artifact size does not match its record.",
      );
    }
    if (sha256Hex(bytes) !== reference.sha256) {
      throw needsReconciliation(
        "Committed artifact SHA-256 does not match its record.",
      );
    }
    return bytes;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    if (isNodeError(error, "ENOENT")) {
      throw needsReconciliation("Committed artifact file is missing.");
    }
    throw toIoError(error);
  }
}

export async function listArtifactFiles(rootDir: string): Promise<
  Array<{
    relativePath: string;
    absolutePath: string;
    sizeBytes: number;
    temporary: boolean;
  }>
> {
  const root = path.resolve(rootDir);
  const artifactsRoot = path.join(root, "artifacts");
  const base = path.join(root, ARTIFACTS_DIRECTORY);
  let entries: Array<{ name: string }>;
  try {
    const artifactsInfo = await lstat(artifactsRoot);
    if (artifactsInfo.isSymbolicLink() || !artifactsInfo.isDirectory()) {
      throw needsReconciliation(
        "Artifact root contains a symlink or non-directory component.",
      );
    }
    const baseInfo = await lstat(base);
    if (baseInfo.isSymbolicLink() || !baseInfo.isDirectory()) {
      throw needsReconciliation(
        "Artifact hash directory contains a symlink or non-directory component.",
      );
    }
    entries = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (error instanceof StorageError) throw error;
    if (isNodeError(error, "ENOENT")) return [];
    throw toIoError(error);
  }

  const files: Array<{
    relativePath: string;
    absolutePath: string;
    sizeBytes: number;
    temporary: boolean;
  }> = [];
  for (const prefix of entries) {
    const prefixPath = path.join(base, prefix.name);
    const prefixInfo = await lstat(prefixPath);
    if (prefixInfo.isSymbolicLink() || !prefixInfo.isDirectory()) {
      files.push({
        relativePath: path.posix.join(ARTIFACTS_DIRECTORY, prefix.name),
        absolutePath: prefixPath,
        sizeBytes: prefixInfo.size,
        temporary: false,
      });
      continue;
    }
    const children: Array<{ name: string }> = await readdir(prefixPath, {
      withFileTypes: true,
    });
    for (const child of children) {
      const absolutePath = path.join(prefixPath, child.name);
      const info = await lstat(absolutePath);
      files.push({
        relativePath: path.posix.join(
          ARTIFACTS_DIRECTORY,
          prefix.name,
          child.name,
        ),
        absolutePath,
        sizeBytes: info.size,
        temporary: child.name.startsWith(".tmp-"),
      });
    }
  }
  return files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, "en"),
  );
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function makeUtcTimestamp(value?: string): string {
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw invalidArgument("Timestamp must be a valid UTC date-time.");
  }
  if (value !== undefined && !/(Z|[+]00:00)$/.test(value)) {
    throw invalidArgument("Timestamp must use UTC (Z or +00:00). ");
  }
  return date.toISOString();
}

export function toIoError(cause: unknown): StorageError {
  const message =
    cause instanceof Error ? cause.message : "Unknown filesystem error.";
  return new StorageError(
    "IO_ERROR",
    `Storage filesystem operation failed: ${message}`,
    { cause },
  );
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
