import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { invalidArgument } from "../storage/errors";
import { writeAtomicFile } from "../storage/files";

const MAX_UNIX_SOCKET_PATH_BYTES = 103;
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface DaemonRuntimePaths {
  readonly storageRoot: string;
  readonly directory: string;
  readonly socket: string;
  readonly token: string;
}

export async function createDaemonRuntimePaths(
  storageRoot: string,
): Promise<DaemonRuntimePaths> {
  const root = path.resolve(storageRoot);
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw invalidArgument("Daemon storage root must be a real directory.");
  }
  const directory = path.join(root, "runtime");
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  const runtimeStat = await lstat(directory);
  if (runtimeStat.isSymbolicLink() || !runtimeStat.isDirectory()) {
    throw invalidArgument(
      "Daemon runtime directory must not contain symlinks.",
    );
  }
  await chmod(directory, 0o700);
  return resolveExistingDaemonRuntimePaths(root);
}

export async function resolveExistingDaemonRuntimePaths(
  storageRoot: string,
): Promise<DaemonRuntimePaths> {
  const root = path.resolve(storageRoot);
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw invalidArgument("Daemon storage root must be a real directory.");
  }
  const directory = path.join(root, "runtime");
  const runtimeStat = await lstat(directory);
  if (
    runtimeStat.isSymbolicLink() ||
    !runtimeStat.isDirectory() ||
    (runtimeStat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" &&
      runtimeStat.uid !== process.getuid())
  ) {
    throw invalidArgument("Daemon runtime directory must be a real directory.");
  }
  const socket = path.join(directory, "s");
  if (Buffer.byteLength(socket) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw invalidArgument(
      "Storage root path is too long for a local Unix domain socket.",
    );
  }
  try {
    const socketStat = await lstat(socket);
    if (
      socketStat.isSymbolicLink() ||
      !socketStat.isSocket() ||
      (socketStat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" &&
        socketStat.uid !== process.getuid())
    ) {
      throw invalidArgument("Daemon socket must be an owner-only Unix socket.");
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  return {
    storageRoot: root,
    directory,
    socket,
    token: path.join(directory, "lifecycle.token"),
  };
}

export async function readExistingLifecycleToken(
  paths: DaemonRuntimePaths,
): Promise<string | undefined> {
  try {
    const info = await lstat(paths.token);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())
    ) {
      throw invalidArgument(
        "Lifecycle token file must be an owner-only regular file.",
      );
    }
    const bytes = await readFile(paths.token);
    const token = bytes.toString("ascii");
    if (!TOKEN_PATTERN.test(token)) {
      throw invalidArgument("Lifecycle token file has an invalid format.");
    }
    return token;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function rotateLifecycleToken(
  paths: DaemonRuntimePaths,
): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  await writeAtomicFile(paths.directory, "lifecycle.token", Buffer.from(token));
  return token;
}

export async function removeRuntimeSocket(
  paths: DaemonRuntimePaths,
): Promise<void> {
  try {
    const info = await lstat(paths.socket);
    if (info.isSymbolicLink() || !info.isSocket()) {
      throw invalidArgument("Daemon socket path is not an owned Unix socket.");
    }
    await unlink(paths.socket);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

export async function removeLifecycleToken(
  paths: DaemonRuntimePaths,
): Promise<void> {
  try {
    const info = await lstat(paths.token);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw invalidArgument("Lifecycle token path is not a regular file.");
    }
    await unlink(paths.token);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
