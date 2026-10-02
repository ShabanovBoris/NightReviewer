import { expect, test } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { runLiveCapture } from "../scripts/bridge-live-capture";
import {
  type EvidenceStage,
  FileStageEvidenceRecorder,
} from "../scripts/bridge-spike";

const HEAD_SHA = "c".repeat(40);
const SUCCESS_STAGES: readonly EvidenceStage[] = [
  "runner_started",
  "settings_validated",
  "internal_health_1_attempted",
  "internal_health_1_received",
  "internal_health_1_passed",
  "model_catalog_attempted",
  "model_catalog_received",
  "model_catalog_passed",
  "internal_health_2_attempted",
  "internal_health_2_received",
  "internal_health_2_passed",
  "ac1_context_created",
  "initial_responses_attempted",
  "initial_responses_received",
  "initial_responses_stream_ended",
  "tool_call_observed",
  "controlled_fixture_read_attempted",
  "controlled_fixture_result_prepared",
  "continuation_responses_attempted",
  "continuation_responses_received",
  "continuation_responses_stream_ended",
  "final_correlation_validated",
  "post_ac1_health_attempted",
  "post_ac1_health_received",
  "post_ac1_health_passed",
];

/** Initializes the recorder's ignored private root before creating an isolated host-capture cwd. */
function privateRoot(): string {
  const evidenceRoot = resolve(".nightreviewer");
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  chmodSync(evidenceRoot, 0o700);
  return mkdtempSync(resolve(evidenceRoot, "nr02-capture-test-"));
}

/** Supplies only the response metadata required by the same validator used on a real child ledger. */
function eventFields(
  stage: EvidenceStage,
): Readonly<Record<string, string | number | boolean>> {
  if (stage.endsWith("_attempted")) {
    const endpointClass = stage.includes("health")
      ? "health"
      : stage.startsWith("model_catalog")
        ? "models"
        : "responses";
    return {
      endpointClass,
      method: endpointClass === "responses" ? "POST" : "GET",
      requestAttempted: true,
    };
  }
  if (stage.endsWith("_received")) {
    const endpointClass = stage.includes("health")
      ? "health"
      : stage.startsWith("model_catalog")
        ? "models"
        : "responses";
    return { endpointClass, httpStatus: 200, responseReceived: true };
  }
  if (stage.endsWith("_stream_ended"))
    return { streamDisposition: "completed" };
  return {};
}

/** Produces the complete ordered runner record to exercise host success validation with no HTTP. */
function writeSuccessLedger(environment: NodeJS.ProcessEnv): void {
  const evidenceRunId = environment.BRIDGE_SPIKE_EVIDENCE_RUN_ID;
  const headSha = environment.BRIDGE_SPIKE_PR_HEAD_SHA;
  const evidencePath = environment.BRIDGE_SPIKE_EVIDENCE_PATH;
  if (!evidenceRunId || !headSha || !evidencePath)
    throw new Error("Missing fake-runner evidence setup.");
  const recorder = new FileStageEvidenceRecorder(
    evidencePath,
    evidenceRunId,
    headSha,
  );
  try {
    for (const stage of SUCCESS_STAGES)
      recorder.record(stage, eventFields(stage));
    recorder.record("terminal_success", {
      exitClassification: "SUCCESS",
      lastProvenStage: "post_ac1_health_passed",
      requestSent: true,
      initialResponsesRequestSent: true,
    });
  } finally {
    recorder.close();
  }
}

/** Builds a runner-owned early failure receipt without triggering any bridge boundary. */
function writeFailureLedger(environment: NodeJS.ProcessEnv): void {
  const evidenceRunId = environment.BRIDGE_SPIKE_EVIDENCE_RUN_ID;
  const headSha = environment.BRIDGE_SPIKE_PR_HEAD_SHA;
  const evidencePath = environment.BRIDGE_SPIKE_EVIDENCE_PATH;
  if (!evidenceRunId || !headSha || !evidencePath)
    throw new Error("Missing fake-runner evidence setup.");
  const recorder = new FileStageEvidenceRecorder(
    evidencePath,
    evidenceRunId,
    headSha,
  );
  try {
    recorder.record("runner_started");
    recorder.record("terminal_failure", {
      errorClass: "Error",
      errorCode: "RUNNER_ERROR",
      exitClassification: "RUNNER_FAILURE",
      lastProvenStage: "runner_started",
      requestSent: false,
      initialResponsesRequestSent: false,
    });
  } finally {
    recorder.close();
  }
}

/** Emulates a fixed Bun child with buffered stdout/stderr and an exact close event. */
function fakeChild(
  exitCode: number | null,
  populateLedger?: (environment: NodeJS.ProcessEnv) => void,
  stdoutText = "NR02_PRIVATE_STDOUT_SENTINEL\nnot-json\u0000",
  stderrText = "NR02_PRIVATE_STDERR_SENTINEL\n{ malformed",
  exitSignal: NodeJS.Signals | null = null,
): (command: string, args: string[], options: SpawnOptions) => ChildProcess {
  return (_command, _args, options) => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    child.pid = 42;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      populateLedger?.(options.env ?? {});
      child.stdout.write(Buffer.from(stdoutText, "utf8"));
      child.stderr.write(Buffer.from(stderrText, "utf8"));
      let ended = 0;
      const closeAfterDrain = (): void => {
        ended += 1;
        if (ended === 2) child.emit("close", exitCode, exitSignal);
      };
      child.stdout.once("end", closeAfterDrain);
      child.stderr.once("end", closeAfterDrain);
      child.stdout.end();
      child.stderr.end();
    });
    return child as unknown as ChildProcess;
  };
}

test("host capture durably stores both raw streams privately and returns only hashes and allowlisted metadata", async () => {
  const cwd = privateRoot();
  const evidenceRunId = randomUUID();
  const stdoutText = "NR02_PRIVATE_STDOUT_SENTINEL\nnot-json\u0000";
  const stderrText = "NR02_PRIVATE_STDERR_SENTINEL\n{ malformed";
  const commands: Array<{
    command: string;
    args: string[];
    options: SpawnOptions;
  }> = [];
  let clock = Date.parse("2026-10-01T10:00:00.000Z");
  try {
    const receipt = await runLiveCapture({
      cwd,
      bunVersion: "1.4.2",
      expectedPrHeadSha: HEAD_SHA,
      runId: () => evidenceRunId,
      now: () => {
        clock += 1;
        return new Date(clock);
      },
      repositoryState: () => ({
        headSha: HEAD_SHA,
        branch: "nr-02-chatgpt-web-spike",
        clean: true,
      }),
      spawnChild: (command, args, options) => {
        commands.push({ command, args, options });
        return fakeChild(
          0,
          writeSuccessLedger,
          stdoutText,
          stderrText,
        )(command, args, options);
      },
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.args).toEqual([
      "run",
      "scripts/bridge-spike.ts",
      "--live",
      "--ac1-only",
    ]);
    expect(commands[0]?.options.shell).toBe(false);
    expect(commands[0]?.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(receipt).toMatchObject({
      evidenceRunId,
      prHeadSha: HEAD_SHA,
      terminalExitClassification: "SUCCESS",
      exitCode: 0,
      exitSignal: null,
      childStarted: true,
      lastProvenStage: "post_ac1_health_passed",
      requestSent: true,
      initialResponsesRequestSent: true,
      stageEventCount: SUCCESS_STAGES.length + 1,
    });
    expect(new Date(receipt.startedAtUtc).toISOString()).toBe(
      receipt.startedAtUtc,
    );
    expect(new Date(receipt.finishedAtUtc).toISOString()).toBe(
      receipt.finishedAtUtc,
    );
    expect(Date.parse(receipt.finishedAtUtc)).toBeGreaterThan(
      Date.parse(receipt.startedAtUtc),
    );
    expect(JSON.stringify(receipt)).not.toContain("NR02_PRIVATE_");

    const directory = resolve(
      cwd,
      ".nightreviewer",
      "dev",
      evidenceRunId,
      "live-capture",
    );
    const stdoutPath = resolve(directory, "stdout.raw");
    const stderrPath = resolve(directory, "stderr.raw");
    const capturePath = resolve(directory, "capture.json");
    const stdoutBytes = readFileSync(stdoutPath);
    const stderrBytes = readFileSync(stderrPath);
    expect(stdoutBytes.toString("utf8")).toBe(stdoutText);
    expect(stderrBytes.toString("utf8")).toBe(stderrText);
    expect(receipt.stdout.bytes).toBe(stdoutBytes.byteLength);
    expect(receipt.stderr.bytes).toBe(stderrBytes.byteLength);
    expect(statSync(stdoutPath).mode & 0o777).toBe(0o600);
    expect(statSync(stderrPath).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual(receipt);
    expect(receipt.stages.bytes).toBe(
      readFileSync(resolve(directory, "stages.jsonl")).byteLength,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("host capture refuses to spawn when private artifact storage cannot be initialized", async () => {
  const cwd = privateRoot();
  writeFileSync(resolve(cwd, ".nightreviewer"), "not-a-directory");
  let spawnCount = 0;
  try {
    await expect(
      runLiveCapture({
        cwd,
        bunVersion: "1.4.2",
        expectedPrHeadSha: HEAD_SHA,
        repositoryState: () => ({
          headSha: HEAD_SHA,
          branch: "nr-02-chatgpt-web-spike",
          clean: true,
        }),
        spawnChild: () => {
          spawnCount += 1;
          throw new Error("This callback must not run.");
        },
      }),
    ).rejects.toThrow("Private LIVE capture could not be completed.");
    expect(spawnCount).toBe(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("host capture refuses an unapproved PR head before creating run storage or spawning", async () => {
  const cwd = privateRoot();
  let spawnCount = 0;
  try {
    await expect(
      runLiveCapture({
        cwd,
        bunVersion: "1.4.2",
        expectedPrHeadSha: "d".repeat(40),
        repositoryState: () => ({
          headSha: HEAD_SHA,
          branch: "nr-02-chatgpt-web-spike",
          clean: true,
        }),
        spawnChild: () => {
          spawnCount += 1;
          throw new Error("This callback must not run.");
        },
      }),
    ).rejects.toThrow("Private LIVE capture could not be completed.");
    expect(spawnCount).toBe(0);
    expect(() => readFileSync(resolve(cwd, ".nightreviewer"))).toThrow();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("host capture classifies a missing terminal receipt as capture failure", async () => {
  const cwd = privateRoot();
  const evidenceRunId = randomUUID();
  try {
    const receipt = await runLiveCapture({
      cwd,
      bunVersion: "1.4.2",
      expectedPrHeadSha: HEAD_SHA,
      runId: () => evidenceRunId,
      repositoryState: () => ({
        headSha: HEAD_SHA,
        branch: "nr-02-chatgpt-web-spike",
        clean: true,
      }),
      spawnChild: fakeChild(null, undefined, undefined, undefined, "SIGTERM"),
    });
    expect(receipt.terminalExitClassification).toBe("CAPTURE_FAILURE");
    expect(receipt.lastProvenStage).toBe("UNKNOWN");
    expect(receipt.requestSent).toBe("UNKNOWN");
    expect(receipt.exitCode).toBeNull();
    expect(receipt.exitSignal).toBe("SIGTERM");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("host capture preserves a runner's early failure stage and process exit code", async () => {
  const cwd = privateRoot();
  const evidenceRunId = randomUUID();
  try {
    const receipt = await runLiveCapture({
      cwd,
      bunVersion: "1.4.2",
      expectedPrHeadSha: HEAD_SHA,
      runId: () => evidenceRunId,
      repositoryState: () => ({
        headSha: HEAD_SHA,
        branch: "nr-02-chatgpt-web-spike",
        clean: true,
      }),
      spawnChild: fakeChild(1, writeFailureLedger),
    });
    expect(receipt).toMatchObject({
      terminalExitClassification: "RUNNER_FAILURE",
      exitCode: 1,
      exitSignal: null,
      lastProvenStage: "runner_started",
      requestSent: false,
      initialResponsesRequestSent: false,
      stageEventCount: 2,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
