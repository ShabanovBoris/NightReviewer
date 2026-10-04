import path from "node:path";
import { DaemonRpcClient } from "../daemon/client";
import { serveMcpStdio } from "./stdio";

export async function runMcpAdapter(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const storageRoot = parseStorageRoot(argv);
  const daemon = await DaemonRpcClient.connect(storageRoot);
  await serveMcpStdio(daemon);
}

function parseStorageRoot(argv: readonly string[]): string {
  if (
    argv.length !== 2 ||
    argv[0] !== "--storage-root" ||
    !path.isAbsolute(argv[1] ?? "")
  ) {
    throw new Error("Usage: nightreviewer-mcp --storage-root /absolute/path");
  }
  return argv[1] as string;
}

if (import.meta.main) {
  runMcpAdapter().catch(() => {
    console.error(
      "NightReviewer MCP adapter could not connect to its local daemon.",
    );
    process.exitCode = 1;
  });
}
