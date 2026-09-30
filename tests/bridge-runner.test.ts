import { expect, test } from "bun:test";
import {
  requireIdleBridge,
  resolveLiveMode,
  runAc1Only,
} from "../scripts/bridge-spike";

test("LIVE runner requires one explicit mode and rejects the former combined cancel flag", () => {
  expect(() => resolveLiveMode(["--live", "--live", "--ac1-only"])).toThrow(
    "Pass --live exactly once",
  );
  expect(() => resolveLiveMode(["--live"])).toThrow(
    "Choose exactly one explicit live mode",
  );
  expect(() =>
    resolveLiveMode(["--live", "--ac1-only", "--cancel-only"]),
  ).toThrow("Choose exactly one explicit live mode");
  expect(() => resolveLiveMode(["--live", "--cancel"])).toThrow(
    "Unknown live mode argument",
  );
  expect(resolveLiveMode(["--live", "--preflight-only"])).toBe(
    "--preflight-only",
  );
  expect(resolveLiveMode(["--live", "--ac1-only"])).toBe("--ac1-only");
  expect(resolveLiveMode(["--live", "--cancel-only"])).toBe("--cancel-only");
});

test("pre-LIVE bridge guard requires both active-turn counts to be zero", () => {
  expect(() =>
    requireIdleBridge(
      { active_http_turns: 0, active_browser_turns: 0 },
      "before model discovery",
    ),
  ).not.toThrow();
  expect(() =>
    requireIdleBridge(
      { active_http_turns: 1, active_browser_turns: 0 },
      "before model discovery",
    ),
  ).toThrow("zero active HTTP and browser turns");
  expect(() =>
    requireIdleBridge({ active_http_turns: 0 }, "after model discovery"),
  ).toThrow("zero active HTTP and browser turns");
});

test("AC1 generates one canary, calls one fresh context, and returns only sanitized receipt fields", async () => {
  const settings = {
    baseUrl: new URL("http://127.0.0.1:17841/"),
    apiKey: "test-api-key-that-must-not-be-emitted",
    model: "test-model",
  };
  const canaries: string[] = [];
  const receipt = await runAc1Only(settings, async (_settings, canaryId) => {
    canaries.push(canaryId);
    const fixtureSha256 = "a".repeat(64);
    const liveTrace = {
      schemaVersion: "nr02-live-trace/1",
      requestIdentity: { threadId: "thread-1", turnId: "turn-1" },
      model: settings.model,
      startedAt: "2026-09-30T00:00:00.000Z",
      finishedAt: "2026-09-30T00:00:01.000Z",
      elapsedMs: 1_000,
      responseLegs: [],
      fixtureRead: {
        startedAt: "2026-09-30T00:00:00.500Z",
        finishedAt: "2026-09-30T00:00:00.501Z",
        elapsedMs: 1,
        fixture: "probe",
        byteLength: 97,
        fixtureSha256,
        toolCall: {
          name: "read_fixture",
          itemId: "item-1",
          callId: "call-1",
          arguments: { fixture: "probe" },
          argumentsSha256: "b".repeat(64),
        },
        toolOutput: { byteLength: 150, sha256: "c".repeat(64) },
      },
      structuredResult: {
        responseId: "response-final",
        canaryId,
        fixtureSha256,
      },
    };
    return {
      threadId: "thread-1",
      turnId: "turn-1",
      canaryId,
      firstResponseId: "response-call",
      finalResponseId: "response-final",
      callId: "call-1",
      fixtureSha256,
      observedOutput: "fixture contents and model output are private",
      initialEvents: ["response.completed"],
      continuationEvents: ["response.completed"],
      liveTrace,
      liveTraceSha256: "d".repeat(64),
      liveTraceBytes: 1_000,
    } as never;
  });

  expect(canaries).toHaveLength(1);
  const generatedCanary = canaries[0];
  if (generatedCanary === undefined) {
    throw new Error("The AC1 runner did not pass its generated canary.");
  }
  expect(generatedCanary).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(receipt.canaryId).toBe(generatedCanary);
  expect(receipt.liveTrace.structuredResult.canaryId).toBe(generatedCanary);
  expect(receipt.liveTraceSha256).toBe("d".repeat(64));
  const serialized = JSON.stringify(receipt);
  expect(serialized).not.toContain(settings.apiKey);
  expect(serialized).not.toContain("fixture contents");
  expect(serialized).not.toContain("observedOutput");
});
