import path from "node:path";
import { openStorage } from "../storage";
import { DaemonRuntime } from "./runtime";

interface DaemonArguments {
  readonly storageRoot: string;
  readonly repositories: ReadonlyMap<string, string>;
}

export async function runDaemon(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const args = parseArguments(argv);
  const store = await openStorage({ rootDir: args.storageRoot });
  let runtime: DaemonRuntime | undefined;
  try {
    runtime = await DaemonRuntime.start({
      store,
      repositoryPaths: args.repositories,
    });
    console.error("NightReviewer local daemon is ready.");
    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        void runtime
          ?.close()
          .then(resolve)
          .catch(() => resolve());
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    if (runtime === undefined) store.close();
  }
}

function parseArguments(argv: readonly string[]): DaemonArguments {
  let storageRoot: string | undefined;
  const repositories = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--storage-root") {
      storageRoot = argv[index + 1];
      index += 1;
    } else if (argument === "--repository") {
      const value = argv[index + 1];
      index += 1;
      if (typeof value !== "string")
        throw new Error("--repository requires repoId=/absolute/path.");
      const separator = value.indexOf("=");
      const repoId = value.slice(0, separator);
      const repoPath = value.slice(separator + 1);
      if (
        separator < 1 ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(repoId) ||
        !path.isAbsolute(repoPath) ||
        repositories.has(repoId)
      ) {
        throw new Error("--repository value is invalid or duplicated.");
      }
      repositories.set(repoId, repoPath);
    } else {
      throw new Error("Unknown daemon argument.");
    }
  }
  if (typeof storageRoot !== "string" || !path.isAbsolute(storageRoot)) {
    throw new Error("--storage-root must be an absolute path.");
  }
  if (repositories.size === 0)
    throw new Error("At least one trusted --repository is required.");
  return { storageRoot, repositories };
}

if (import.meta.main) {
  runDaemon().catch(() => {
    console.error("NightReviewer daemon could not start or shut down cleanly.");
    process.exitCode = 1;
  });
}
