import {
  type ChildProcess,
  execFileSync,
  spawn as nodeSpawn,
  type SpawnOptions,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { type StageLedgerSummary, validateStageLedger } from "./bridge-spike";

const EXPECTED_BUN_VERSION = "1.4.2";
const CAPTURE_SCHEMA = "nr02-host-live-capture/1" as const;
const CHILD_ARGS = ["run", "scripts/bridge-spike.ts", "--live", "--ac1-only"];
const PRIVATE_FILE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  fsConstants.O_NOFOLLOW;

export type LiveCaptureClassification =
  | "SUCCESS"
  | "RUNNER_FAILURE"
  | "EVIDENCE_PERSISTENCE_FAILURE"
  | "CAPTURE_FAILURE";

export interface PrivateStreamDigest {
  readonly bytes: number;
  readonly sha256: string;
}

export interface LiveCaptureReceipt {
  readonly schemaVersion: typeof CAPTURE_SCHEMA;
  readonly evidenceRunId: string;
  readonly prHeadSha: string;
  readonly startedAtUtc: string;
  readonly finishedAtUtc: string;
  readonly terminalExitClassification: LiveCaptureClassification;
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly childStarted: boolean;
  readonly lastProvenStage: string;
  readonly requestSent: boolean | "UNKNOWN";
  readonly initialResponsesRequestSent: boolean | "UNKNOWN";
  readonly stageEventCount: number;
  readonly stages: PrivateStreamDigest;
  readonly stdout: PrivateStreamDigest;
  readonly stderr: PrivateStreamDigest;
}

/** Restricts the host wrapper to test seams that cannot add commands or widen the bridge target. */
export interface LiveCaptureOptions {
  readonly cwd?: string;
  readonly bunVersion?: string;
  readonly expectedPrHeadSha?: string;
  readonly runId?: () => string;
  readonly now?: () => Date;
  readonly repositoryState?: (cwd: string) => {
    readonly headSha: string;
    readonly branch: string;
    readonly clean: boolean;
  };
  readonly spawnChild?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
}

/** Carries only a bounded host-side failure code, never raw paths or child output. */
class LiveCaptureError extends Error {
  constructor(
    readonly code:
      | "UNSUPPORTED_RUNTIME"
      | "WORKTREE_NOT_CLEAN"
      | "INVALID_HEAD"
      | "CAPTURE_STORAGE",
  ) {
    super("Private LIVE capture could not be completed.");
    this.name = "LiveCaptureError";
  }
}

interface OpenCaptureFiles {
  readonly directory: string;
  readonly stagePath: string;
  readonly capturePath: string;
  readonly stdoutFd: number;
  readonly stderrFd: number;
  readonly captureFd: number;
  readonly directoryFd: number;
}

interface MutableDigest {
  readonly hash: ReturnType<typeof createHash>;
  bytes: number;
}

/** Keeps wrapper timestamps injectable so tests can assert UTC ordering without a service. */
function utcNow(now: () => Date): string {
  return now().toISOString();
}

/** Binds each future request to a clean checked-in revision, not an unreviewed worktree. */
function defaultRepositoryState(cwd: string): {
  headSha: string;
  branch: string;
  clean: boolean;
} {
  try {
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return { headSha, branch, clean: status.length === 0 };
  } catch {
    throw new LiveCaptureError("INVALID_HEAD");
  }
}

/** Creates owner-only evidence directories and rejects symlinked storage roots. */
function ensurePrivateDirectory(parent: string, name: string): string {
  const path = resolve(parent, name);
  if (relative(parent, path).startsWith(".."))
    throw new LiveCaptureError("CAPTURE_STORAGE");
  let created = false;
  try {
    mkdirSync(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "EEXIST")
    ) {
      throw new LiveCaptureError("CAPTURE_STORAGE");
    }
  }
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new LiveCaptureError("CAPTURE_STORAGE");
    chmodSync(path, 0o700);
    const directoryFd = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directoryFd);
      if (created) {
        const parentFd = openSync(
          parent,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
        try {
          fsyncSync(parentFd);
        } finally {
          closeSync(parentFd);
        }
      }
    } finally {
      closeSync(directoryFd);
    }
  } catch {
    throw new LiveCaptureError("CAPTURE_STORAGE");
  }
  return path;
}

/** Creates a new mode-600 artifact without following symlinks before a child can start. */
function createPrivateFile(path: string): number {
  try {
    const fd = openSync(path, PRIVATE_FILE_FLAGS, 0o600);
    chmodSync(path, 0o600);
    fsyncSync(fd);
    return fd;
  } catch {
    throw new LiveCaptureError("CAPTURE_STORAGE");
  }
}

/** Handles partial writes so flushed evidence and raw chunks are never silently shortened. */
function writeFully(
  fd: number,
  bytes: Uint8Array,
  position: number | null = null,
): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += writeSync(
      fd,
      bytes,
      offset,
      bytes.byteLength - offset,
      position === null ? null : position + offset,
    );
  }
}

/** Flushes a host-owned manifest to its already-created private file. */
function writeJsonFile(fd: number, value: unknown): void {
  writeFully(fd, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"), 0);
  fsyncSync(fd);
}

/** Precreates and flushes every receipt and stream destination before the child can make requests. */
function openCaptureFiles(
  cwd: string,
  evidenceRunId: string,
): OpenCaptureFiles {
  const opened: number[] = [];
  try {
    const projectRoot = resolve(cwd);
    const metadataRoot = ensurePrivateDirectory(projectRoot, ".nightreviewer");
    const devRoot = ensurePrivateDirectory(metadataRoot, "dev");
    const runRoot = ensurePrivateDirectory(devRoot, evidenceRunId);
    const directory = ensurePrivateDirectory(runRoot, "live-capture");
    const stagePath = resolve(directory, "stages.jsonl");
    const capturePath = resolve(directory, "capture.json");
    const stdoutFd = createPrivateFile(resolve(directory, "stdout.raw"));
    opened.push(stdoutFd);
    const stderrFd = createPrivateFile(resolve(directory, "stderr.raw"));
    opened.push(stderrFd);
    const stageFd = createPrivateFile(stagePath);
    opened.push(stageFd);
    const captureFd = createPrivateFile(capturePath);
    opened.push(captureFd);
    fsyncSync(stageFd);
    closeSync(stageFd);
    opened.splice(opened.indexOf(stageFd), 1);
    const directoryFd = openSync(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    opened.push(directoryFd);
    fsyncSync(directoryFd);
    return {
      directory,
      stagePath,
      capturePath,
      stdoutFd,
      stderrFd,
      captureFd,
      directoryFd,
    };
  } catch (error) {
    for (const fd of opened) {
      try {
        closeSync(fd);
      } catch {
        /* close descriptors from a partially prepared store */
      }
    }
    if (error instanceof LiveCaptureError) throw error;
    throw new LiveCaptureError("CAPTURE_STORAGE");
  }
}

/** Passes only bridge settings, capture identity, and basic process environment into the runner. */
function childEnvironment(
  source: NodeJS.ProcessEnv,
  evidencePath: string,
  evidenceRunId: string,
  prHeadSha: string,
): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed)
    if (source[key] !== undefined) environment[key] = source[key];
  for (const key of [
    "BRIDGE_SPIKE_BASE_URL",
    "BRIDGE_SPIKE_API_KEY",
    "BRIDGE_SPIKE_MODEL",
    "BRIDGE_SPIKE_CLIENT_VERSION",
  ]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  environment.BRIDGE_SPIKE_EVIDENCE_PATH = evidencePath;
  environment.BRIDGE_SPIKE_EVIDENCE_RUN_ID = evidenceRunId;
  environment.BRIDGE_SPIKE_PR_HEAD_SHA = prHeadSha;
  return environment;
}

/** Starts the in-memory digest accumulator for one privately captured stream. */
function streamDigest(): MutableDigest {
  return { hash: createHash("sha256"), bytes: 0 };
}

/** Drains one child pipe into private storage while retaining only digest and byte count in memory. */
function captureStream(
  stream: NodeJS.ReadableStream,
  fd: number,
  digest: MutableDigest,
  onFailure: () => void,
): void {
  stream.on("data", (value: Buffer | string) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    try {
      writeFully(fd, bytes);
      digest.hash.update(bytes);
      digest.bytes += bytes.byteLength;
    } catch {
      onFailure();
    }
  });
  stream.on("error", onFailure);
}

/** Exposes stream metadata without returning any captured bytes. */
function digestSummary(digest: MutableDigest): PrivateStreamDigest {
  return { bytes: digest.bytes, sha256: digest.hash.digest("hex") };
}

/** Requires complete, ordered, sanitized stage evidence before reporting the runner outcome. */
function parseStageLedger(
  path: string,
  evidenceRunId: string,
  prHeadSha: string,
): {
  readonly summary: StageLedgerSummary;
  readonly digest: PrivateStreamDigest;
} {
  try {
    const bytes = readFileSync(path);
    const summary = validateStageLedger(
      bytes.toString("utf8"),
      evidenceRunId,
      prHeadSha,
    );
    return {
      summary,
      digest: {
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  } catch {
    throw new LiveCaptureError("CAPTURE_STORAGE");
  }
}

/** Projects private run state to exact times, classification, safe stage names, sizes, and hashes. */
function finalReceipt(
  evidenceRunId: string,
  prHeadSha: string,
  startedAtUtc: string,
  finishedAtUtc: string,
  exitCode: number | null,
  exitSignal: NodeJS.Signals | null,
  childStarted: boolean,
  classification: LiveCaptureClassification,
  ledger:
    | {
        readonly summary: StageLedgerSummary;
        readonly digest: PrivateStreamDigest;
      }
    | undefined,
  stdout: PrivateStreamDigest,
  stderr: PrivateStreamDigest,
): LiveCaptureReceipt {
  return {
    schemaVersion: CAPTURE_SCHEMA,
    evidenceRunId,
    prHeadSha,
    startedAtUtc,
    finishedAtUtc,
    terminalExitClassification: classification,
    exitCode,
    exitSignal,
    childStarted,
    lastProvenStage: ledger?.summary.lastProvenStage ?? "UNKNOWN",
    requestSent: ledger?.summary.requestSent ?? "UNKNOWN",
    initialResponsesRequestSent:
      ledger?.summary.initialResponsesRequestSent ?? "UNKNOWN",
    stageEventCount: ledger?.summary.eventCount ?? 0,
    stages: ledger?.digest ?? {
      bytes: 0,
      sha256: createHash("sha256").digest("hex"),
    },
    stdout,
    stderr,
  };
}

/** Atomically replaces the pre-spawn running marker after the child and streams have settled. */
function persistFinalReceipt(
  files: OpenCaptureFiles,
  receipt: LiveCaptureReceipt,
): void {
  const tempPath = resolve(files.directory, "capture.final.tmp");
  let fd: number | undefined;
  try {
    fd = createPrivateFile(tempPath);
    writeJsonFile(fd, receipt);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, files.capturePath);
    fsyncSync(files.directoryFd);
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort close after persistence failure */
      }
    }
    throw new LiveCaptureError("CAPTURE_STORAGE");
  }
}

/** Runs the only supported one-shot child after durable private storage exists and then validates its ledger. */
export async function runLiveCapture(
  options: LiveCaptureOptions = {},
): Promise<LiveCaptureReceipt> {
  const cwd = resolve(options.cwd ?? process.cwd());
  if ((options.bunVersion ?? Bun.version) !== EXPECTED_BUN_VERSION) {
    throw new LiveCaptureError("UNSUPPORTED_RUNTIME");
  }
  const repository = (options.repositoryState ?? defaultRepositoryState)(cwd);
  const expectedPrHeadSha =
    options.expectedPrHeadSha ?? process.env.BRIDGE_SPIKE_EXPECTED_PR_HEAD_SHA;
  if (!repository.clean) throw new LiveCaptureError("WORKTREE_NOT_CLEAN");
  if (
    repository.branch !== "nr-02-chatgpt-web-spike" ||
    !/^[0-9a-f]{40}$/.test(repository.headSha) ||
    expectedPrHeadSha !== repository.headSha
  ) {
    throw new LiveCaptureError("INVALID_HEAD");
  }
  const evidenceRunId = options.runId?.() ?? randomUUID();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      evidenceRunId,
    )
  ) {
    throw new LiveCaptureError("CAPTURE_STORAGE");
  }
  const now = options.now ?? (() => new Date());
  const files = openCaptureFiles(cwd, evidenceRunId);
  const startedAtUtc = utcNow(now);
  const initialReceipt = {
    schemaVersion: CAPTURE_SCHEMA,
    evidenceRunId,
    prHeadSha: repository.headSha,
    startedAtUtc,
    state: "running",
  };
  try {
    writeJsonFile(files.captureFd, initialReceipt);
    fsyncSync(files.directoryFd);
  } catch {
    closeCaptureFiles(files);
    throw new LiveCaptureError("CAPTURE_STORAGE");
  }

  const stdout = streamDigest();
  const stderr = streamDigest();
  let captureWriteFailed = false;
  let childStarted = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const spawnChild = options.spawnChild ?? nodeSpawn;
  const environment = childEnvironment(
    process.env,
    files.stagePath,
    evidenceRunId,
    repository.headSha,
  );
  let child: ChildProcess | undefined;
  try {
    child = spawnChild(process.execPath, [...CHILD_ARGS], {
      cwd,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    child = undefined;
  }
  if (!child) {
    const finishedAtUtc = utcNow(now);
    const receipt = finalReceipt(
      evidenceRunId,
      repository.headSha,
      startedAtUtc,
      finishedAtUtc,
      null,
      null,
      false,
      "CAPTURE_FAILURE",
      undefined,
      digestSummary(stdout),
      digestSummary(stderr),
    );
    try {
      persistFinalReceipt(files, receipt);
    } catch {
      /* initial receipt remains durable */
    }
    closeCaptureFiles(files);
    return receipt;
  }
  childStarted = child.pid !== undefined;
  if (!child.stdout || !child.stderr) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* child startup is already classified as failed */
    }
    captureWriteFailed = true;
  } else {
    captureStream(child.stdout, files.stdoutFd, stdout, () => {
      captureWriteFailed = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* continue draining both pipes */
      }
    });
    captureStream(child.stderr, files.stderrFd, stderr, () => {
      captureWriteFailed = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* continue draining both pipes */
      }
    });
  }
  await new Promise<void>((resolvePromise) => {
    child.once("error", () => {
      captureWriteFailed = true;
    });
    child.once("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      resolvePromise();
    });
  });
  try {
    fsyncSync(files.stdoutFd);
    fsyncSync(files.stderrFd);
  } catch {
    captureWriteFailed = true;
  }
  closeSync(files.stdoutFd);
  closeSync(files.stderrFd);
  let ledger: ReturnType<typeof parseStageLedger> | undefined;
  try {
    ledger = parseStageLedger(
      files.stagePath,
      evidenceRunId,
      repository.headSha,
    );
  } catch {
    ledger = undefined;
  }
  const matchingExit = exitSignal === null && exitCode !== null;
  let classification: LiveCaptureClassification = "CAPTURE_FAILURE";
  if (!captureWriteFailed && ledger && matchingExit) {
    if (ledger.summary.terminalStage === "terminal_success" && exitCode === 0) {
      classification = "SUCCESS";
    } else if (
      ledger.summary.terminalStage === "terminal_failure" &&
      exitCode !== 0
    ) {
      classification = ledger.summary.exitClassification;
    }
  }
  const receipt = finalReceipt(
    evidenceRunId,
    repository.headSha,
    startedAtUtc,
    utcNow(now),
    exitCode,
    exitSignal,
    childStarted,
    classification,
    ledger,
    digestSummary(stdout),
    digestSummary(stderr),
  );
  try {
    persistFinalReceipt(files, receipt);
  } finally {
    closeCaptureFiles(files);
  }
  return receipt;
}

/** Closes descriptors even after a failed capture so no later run inherits these file handles. */
function closeCaptureFiles(files: OpenCaptureFiles): void {
  for (const fd of [
    files.stdoutFd,
    files.stderrFd,
    files.captureFd,
    files.directoryFd,
  ]) {
    try {
      closeSync(fd);
    } catch {
      /* descriptor may already be closed during a failed capture */
    }
  }
}

/** Prints only the host receipt; child stdout and stderr stay in private capture files. */
function main(): void {
  runLiveCapture()
    .then((receipt) => {
      console.log(JSON.stringify(receipt));
      if (receipt.terminalExitClassification !== "SUCCESS")
        process.exitCode = 1;
    })
    .catch((error: unknown) => {
      const code =
        error instanceof LiveCaptureError ? error.code : "CAPTURE_STORAGE";
      console.error(
        JSON.stringify({
          check: "nr02-host-live-capture",
          status: "fail",
          errorCode: code,
        }),
      );
      process.exitCode = 1;
    });
}

if (import.meta.main) main();
