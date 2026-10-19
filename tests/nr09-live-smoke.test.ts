import { expect, test } from "bun:test";
import {
  buildQualificationPrompt,
  createGuardedFetcher,
  parseSmokeArguments,
  SmokeHarnessError,
  validatePhaseBDecision,
} from "../scripts/nr09-live-smoke";
import {
  CHATGPT_WEB_AUTH_MODE,
  CHATGPT_WEB_BRIDGE_ORIGIN,
  CHATGPT_WEB_BRIDGE_PIN,
} from "../src/backends/chatgpt-web";
import type { SchedulerPromptContext } from "../src/scheduler";

const BASE_SHA = "04fa7282d347f02f7c110b9707d87e41a3d40ff0";
const HEAD_SHA = "341552de161b3b19418ef8ad867ecae448c88c65";
const REQUEST_ID = "phase-b-request-1";
const SESSION_ID = "d52c4dc6-1aa6-4a14-b880-8b8f66f2bbd0";
const DECISION_ID = "NR-09-D142-PHASE-B-AUTHORIZED";
const AUTHORIZATION_ID = "NR-09-C1-D142-PHASE-B-SMOKE";
const ORIGIN = CHATGPT_WEB_BRIDGE_ORIGIN;
const MODEL = CHATGPT_WEB_BRIDGE_PIN.model;
const clientVersionProvenance = {
  kind: "active-codex-desktop-bundle",
  bundleIdentifier: "dev.codexwebgpt.launcher",
  applicationPath: "/Applications/Codex Web GPT.app",
  observedVersion: "6.1.3",
  observedAtUtc: "2026-10-16T12:00:00.000Z",
};
const launcherCompatibilityIdentity = {
  policyId: "codex-web-gpt-verified-release-components/1",
  policySha256: "a".repeat(64),
  launcherIdentitySha256: "b".repeat(64),
  infoPlistSha256: "c".repeat(64),
  executableSha256: "d".repeat(64),
  appArchiveSha256: "e".repeat(64),
};
const phaseBDecision = {
  protocol: "nr-dev/1",
  messageId: "lead-decision-1",
  inReplyTo: REQUEST_ID,
  sessionId: SESSION_ID,
  role: "lead",
  type: "DECISION",
  repository: "ShabanovBoris/NightReviewer",
  taskId: "NR-09",
  cycle: 2,
  payload: {
    decisionId: DECISION_ID,
    selectedOption: "AUTHORIZE_D141_PHASE_B_BOUNDED_LIVE_SMOKES",
    phaseBAuthorization: {
      authorizationId: AUTHORIZATION_ID,
      route: CHATGPT_WEB_AUTH_MODE,
      identity: {
        prUrl: "https://github.com/ShabanovBoris/NightReviewer/pull/10",
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
      },
      maximumQualifyingActionsAuthorized: {
        compatibilityPreflight: 1,
        completeSchedulerManagedReviewerRun: 1,
        cancellationSchedulerManagedTurn: 1,
      },
      runtime: {
        authMode: CHATGPT_WEB_AUTH_MODE,
        bridgeOrigin: ORIGIN,
        bridgeVersion: CHATGPT_WEB_BRIDGE_PIN.upstreamVersion,
        clientVersion: "6.1.3",
        clientVersionProvenance,
        launcherCompatibilityIdentity,
        model: MODEL,
        reasoningEffort: CHATGPT_WEB_BRIDGE_PIN.reasoningEffort,
      },
    },
  },
};

function decisionText(value: unknown = phaseBDecision): string {
  const fence = String.fromCharCode(96).repeat(3);
  return fence + "json\n" + JSON.stringify(value) + "\n" + fence;
}

test("smoke mode requires an explicit mode and exact head binding", () => {
  expect(
    parseSmokeArguments([
      "--mode=complete",
      "--expected-head-sha=" + HEAD_SHA,
      "--expected-cycle=2",
      "--phase-b-request-id=" + REQUEST_ID,
      "--phase-b-receipt=.nightreviewer/receipt.raw.txt",
    ]),
  ).toEqual({
    mode: "complete",
    expectedHeadSha: HEAD_SHA,
    expectedCycle: 2,
    phaseBRequestId: REQUEST_ID,
    phaseBReceiptPath: ".nightreviewer/receipt.raw.txt",
  });
  expect(() => parseSmokeArguments([])).toThrow(SmokeHarnessError);
  expect(() =>
    parseSmokeArguments([
      "--mode=complete",
      "--expected-head-sha=" + HEAD_SHA,
      "--phase-b-request-id=" + REQUEST_ID,
      "--phase-b-receipt=.nightreviewer/receipt.raw.txt",
    ]),
  ).toThrow(SmokeHarnessError);
  expect(() =>
    parseSmokeArguments([
      "--mode=unknown",
      "--expected-head-sha=" + HEAD_SHA,
      "--expected-cycle=2",
      "--phase-b-request-id=" + REQUEST_ID,
      "--phase-b-receipt=.nightreviewer/receipt.raw.txt",
    ]),
  ).toThrow(SmokeHarnessError);
});

test("Phase B requires a correlated lead decision bound to exact PR head and action limits", () => {
  expect(
    validatePhaseBDecision(decisionText(), {
      requestId: REQUEST_ID,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      cycle: 2,
    }),
  ).toMatchObject({
    decisionId: DECISION_ID,
    authorizationId: AUTHORIZATION_ID,
    runtime: {
      bridgeOrigin: ORIGIN,
      model: MODEL,
      reasoningEffort: CHATGPT_WEB_BRIDGE_PIN.reasoningEffort,
      authMode: CHATGPT_WEB_AUTH_MODE,
      clientVersionProvenance,
      launcherCompatibilityIdentity,
    },
  });
  const phaseA = {
    ...phaseBDecision,
    payload: {
      ...phaseBDecision.payload,
      selectedOption: "AUTHORIZE_BOUNDED_LOCAL_SMOKE_HARNESS_STAGED",
    },
  };
  expect(() =>
    validatePhaseBDecision(decisionText(phaseA), {
      requestId: REQUEST_ID,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      cycle: 2,
    }),
  ).toThrow(SmokeHarnessError);
  expect(() =>
    validatePhaseBDecision(decisionText(), {
      requestId: REQUEST_ID,
      baseSha: BASE_SHA,
      headSha: "1111111111111111111111111111111111111111",
      cycle: 2,
    }),
  ).toThrow(SmokeHarnessError);
});

test("Phase B requires the direct route and rejects legacy credential identity", () => {
  const missingProvenance = {
    ...phaseBDecision,
    payload: {
      ...phaseBDecision.payload,
      phaseBAuthorization: {
        ...phaseBDecision.payload.phaseBAuthorization,
        runtime: {
          ...phaseBDecision.payload.phaseBAuthorization.runtime,
          clientVersionProvenance: undefined,
          launcherCompatibilityIdentity: undefined,
        },
      },
    },
  };
  const proxyMode = {
    ...phaseBDecision,
    payload: {
      ...phaseBDecision.payload,
      phaseBAuthorization: {
        ...phaseBDecision.payload.phaseBAuthorization,
        runtime: {
          ...phaseBDecision.payload.phaseBAuthorization.runtime,
          authMode: "AUTHENTICATED_PROXY",
        },
      },
    },
  };
  const malformedLauncherIdentity = {
    ...phaseBDecision,
    payload: {
      ...phaseBDecision.payload,
      phaseBAuthorization: {
        ...phaseBDecision.payload.phaseBAuthorization,
        runtime: {
          ...phaseBDecision.payload.phaseBAuthorization.runtime,
          launcherCompatibilityIdentity: {
            ...launcherCompatibilityIdentity,
            policySha256: "invalid",
          },
        },
      },
    },
  };

  expect(() =>
    validatePhaseBDecision(decisionText(missingProvenance), {
      requestId: REQUEST_ID,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      cycle: 2,
    }),
  ).toThrow(SmokeHarnessError);
  expect(() =>
    validatePhaseBDecision(decisionText(proxyMode), {
      requestId: REQUEST_ID,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      cycle: 2,
    }),
  ).toThrow(SmokeHarnessError);
  expect(() =>
    validatePhaseBDecision(decisionText(malformedLauncherIdentity), {
      requestId: REQUEST_ID,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      cycle: 2,
    }),
  ).toThrow(SmokeHarnessError);
  const legacyCredentials = {
    ...phaseBDecision,
    payload: {
      ...phaseBDecision.payload,
      phaseBAuthorization: {
        ...phaseBDecision.payload.phaseBAuthorization,
        runtime: {
          ...phaseBDecision.payload.phaseBAuthorization.runtime,
          credentialProfileId: "legacy-profile",
        },
      },
    },
  };
  expect(() =>
    validatePhaseBDecision(decisionText(legacyCredentials), {
      requestId: REQUEST_ID,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      cycle: 2,
    }),
  ).toThrow(SmokeHarnessError);
  expect(() =>
    validatePhaseBDecision(decisionText(), {
      requestId: REQUEST_ID,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      cycle: 1,
    }),
  ).toThrow(SmokeHarnessError);
});

test("qualification prompt explicitly carries no semantic review credit", () => {
  const context: SchedulerPromptContext = {
    runId: "run-nr09",
    reviewId: "review-nr09",
    cycleId: "cycle-nr09",
    direction: "correctness",
    replicaIndex: 1,
    objectFormat: "sha1",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    schemaHash: "a".repeat(64),
    policyHash: "b".repeat(64),
  };
  const prompt = buildQualificationPrompt(context);
  expect(prompt).toContain("not a code-quality review");
  expect(prompt).toContain("verdict INCOMPLETE");
  expect(prompt).toContain("NR09_LIVE_QUALIFICATION");
  expect(prompt).toContain(HEAD_SHA);
});

test("guarded fetch records a response attempt only after invoking the loopback request", async () => {
  const order: string[] = [];
  const attempts: unknown[] = [];
  const health: unknown[] = [];
  const redirects: Array<RequestRedirect | undefined> = [];
  const fetcher = createGuardedFetcher({
    mode: "cancel",
    expectedOrigin: ORIGIN,
    expectedClientVersion: "1.2.3",
    fetcher: async (_input, init) => {
      order.push("fetch");
      redirects.push(init?.redirect);
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    onHealth: (value) => health.push(value),
    persistUnsafeHealth: async () => {
      throw new Error("unexpected unsafe health response");
    },
    onResponseAttempt: (value) => {
      order.push("observed");
      attempts.push(value);
    },
  });
  await fetcher(new URL(ORIGIN + "/v1/responses"), { method: "POST" });
  expect(order).toEqual(["fetch", "observed"]);
  expect(redirects).toEqual(["error"]);
  expect(attempts).toHaveLength(1);
  expect(health).toHaveLength(0);
});

test("guarded fetch rejects non-loopback routes and prevents turns in preflight", async () => {
  let fetchCalls = 0;
  const create = (mode: "preflight" | "complete" | "cancel") =>
    createGuardedFetcher({
      mode,
      expectedOrigin: ORIGIN,
      expectedClientVersion: "1.2.3",
      fetcher: async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      },
      onHealth: () => undefined,
      persistUnsafeHealth: async () => undefined,
      onResponseAttempt: () => undefined,
    });
  await expect(
    create("complete")(new URL("http://example.com/v1/responses"), {
      method: "POST",
    }),
  ).rejects.toThrow(SmokeHarnessError);
  await expect(
    create("complete")(new URL("http://127.0.0.1:17842/v1/responses"), {
      method: "POST",
    }),
  ).rejects.toThrow(SmokeHarnessError);
  await expect(
    create("complete")(new URL(ORIGIN + "/v1/responses"), {
      method: "POST",
      headers: { authorization: "Bearer should-not-be-sent" },
    }),
  ).rejects.toThrow(SmokeHarnessError);
  await expect(
    create("preflight")(new URL(ORIGIN + "/v1/responses"), { method: "POST" }),
  ).rejects.toThrow(SmokeHarnessError);
  expect(fetchCalls).toBe(0);
});

test("guarded fetch permits only the exact model catalog client version query", async () => {
  let fetchCalls = 0;
  const redirects: Array<RequestRedirect | undefined> = [];
  const guarded = createGuardedFetcher({
    mode: "preflight",
    expectedOrigin: ORIGIN,
    expectedClientVersion: "1.2.3",
    fetcher: async (_input, init) => {
      fetchCalls += 1;
      redirects.push(init?.redirect);
      return new Response("{}", { status: 200 });
    },
    onHealth: () => undefined,
    persistUnsafeHealth: async () => undefined,
    onResponseAttempt: () => undefined,
  });
  await guarded(new URL(ORIGIN + "/v1/models?client_version=1.2.3"), {
    method: "GET",
  });
  expect(fetchCalls).toBe(1);
  expect(redirects).toEqual(["error"]);
  await expect(
    guarded(new URL(ORIGIN + "/v1/models?client_version=other"), {
      method: "GET",
    }),
  ).rejects.toThrow(SmokeHarnessError);
  await expect(
    guarded(new URL(ORIGIN + "/healthz?unexpected=1"), { method: "GET" }),
  ).rejects.toThrow(SmokeHarnessError);
  expect(fetchCalls).toBe(1);
});

test("guarded health check stops when active-turn counts are missing or nonzero", async () => {
  const captured: Uint8Array[] = [];
  const guarded = createGuardedFetcher({
    mode: "preflight",
    expectedOrigin: ORIGIN,
    expectedClientVersion: "1.2.3",
    fetcher: async () =>
      new Response(
        JSON.stringify({
          service: "codex-chatgpt-web",
          status: "ok",
          pid: 42,
          version: "6.1.3",
          mode: "full",
          accepting_turns: true,
          active_http_turns: 1,
          active_browser_turns: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    onHealth: () => undefined,
    persistUnsafeHealth: async (bytes) => {
      captured.push(bytes);
    },
    onResponseAttempt: () => undefined,
  });
  await expect(
    guarded(new URL(ORIGIN + "/healthz"), { method: "GET" }),
  ).rejects.toThrow(SmokeHarnessError);
  expect(captured).toHaveLength(1);
});
