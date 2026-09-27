import { parseSessionConfig } from "../src/config/session";

/** Keeps filesystem diagnostics at the operator boundary and leaves validation itself reusable and side-effect free. */
async function main(): Promise<void> {
  const configPath = Bun.argv[2] ?? "config/session.local.json";
  const configFile = Bun.file(configPath);

  if (!(await configFile.exists())) {
    console.error(
      "Session config is missing. Copy config/session.example.json to config/session.local.json and configure two different chat URLs.",
    );
    process.exitCode = 1;
    return;
  }

  let rawConfig: unknown;
  try {
    rawConfig = await configFile.json();
  } catch {
    console.error("Session config is not valid JSON.");
    process.exitCode = 1;
    return;
  }

  try {
    parseSessionConfig(rawConfig);
    console.log(
      "Session config is valid; private chat URLs were not displayed.",
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown validation error.";
    console.error(`Session config is invalid: ${message}`);
    process.exitCode = 1;
  }
}

await main();
