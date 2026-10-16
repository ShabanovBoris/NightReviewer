import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type CredentialCommandRunner,
  type CredentialResolver,
  createAllowlistedChildProcessEnvironment,
  createMacOSKeychainCredentialResolver,
  type ExpectedProductionBindingIdentity,
  type ProductionBinding,
  ProductionBindingError,
  parseProductionBinding,
  readPrivateProductionBinding,
  resolveBoundProductionCredential,
} from "../scripts/nr09-production-binding";
import type { CredentialSourceRef } from "../src/backends/chatgpt-web";
import {
  CHATGPT_WEB_BRIDGE_PIN,
  ChatGptWebReviewerBackend,
} from "../src/backends/chatgpt-web";
import type { BackendInvocationInput } from "../src/scheduler/types";
import type { ArtifactReference, RawArtifactCapture } from "../src/storage";

const sentinelBearer = "sentinel-production-bearer-must-stay-private";
const prompt = "Review only the run-bound context supplied to this worker.";
const promptHash = createHash("sha256").update(prompt).digest("hex");
const baseSha = "b".repeat(40);
const headSha = "c".repeat(40);
const sourceRef = {
  provider: "macos-keychain" as const,
  service: "NightReviewer.NR09.ProductionBearer",
  account: "nr09-prod-00000000-0000-4000-8000-000000000001",
};

const binding: ProductionBinding = {
  schemaVersion: "nr09-production-binding/1",
  credentialProfileId: sourceRef.account,
  credentialSourceRef: sourceRef,
  credentialBindingGeneration: 1,
  bridge: { origin: "http://127.0.0.1:17841", versionPin: "6.1.3" },
  clientVersion: "1.2.3",
  clientVersionProvenance: {
    kind: "active-codex-desktop-bundle",
    bundleIdentifier: "com.example.codex",
    applicationPath: "/Applications/Codex.app",
    observedVersion: "1.2.3",
    observedAtUtc: "2026-10-16T12:00:00.000Z",
  },
  model: CHATGPT_WEB_BRIDGE_PIN.model,
  reasoningEffort: CHATGPT_WEB_BRIDGE_PIN.reasoningEffort,
  createdAtUtc: "2026-10-16T12:00:00.000Z",
};

function expectedIdentity(
  value: ProductionBinding = binding,
): ExpectedProductionBindingIdentity {
  return {
    bridgeOrigin: value.bridge.origin,
    bridgeVersion: value.bridge.versionPin,
    clientVersion: value.clientVersion,
    credentialProfileId: value.credentialProfileId,
    credentialSourceRef: value.credentialSourceRef,
    credentialBindingGeneration: value.credentialBindingGeneration,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function bindingText(value: unknown = binding): string {
  return canonicalJson(value) + "\n";
}

function artifactReference(
  bytes: Uint8Array,
  index: number,
): ArtifactReference {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
    relativePath: `artifacts/test-${index}`,
  };
}

function fakeFetch(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  return implementation as typeof fetch;
}

function backendForSecret(
  secret: string,
  fetcher: typeof fetch,
  captured: Uint8Array[],
): ChatGptWebReviewerBackend {
  const persistRawArtifact = async (bytes: Uint8Array) => {
    const copy = Uint8Array.from(bytes);
    captured.push(copy);
    return artifactReference(copy, captured.length);
  };
  const createRawArtifactCapture = async (): Promise<RawArtifactCapture> => {
    const chunks: Uint8Array[] = [];
    return {
      async write(bytes) {
        chunks.push(Uint8Array.from(bytes));
      },
      async commit() {
        const size = chunks.reduce(
          (total, chunk) => total + chunk.byteLength,
          0,
        );
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return persistRawArtifact(bytes);
      },
      async abort() {
        chunks.length = 0;
      },
    };
  };
  return new ChatGptWebReviewerBackend({
    baseUrl: binding.bridge.origin,
    apiKey: secret,
    clientVersion: binding.clientVersion,
    credentialProfileId: binding.credentialProfileId,
    credentialSourceRef: binding.credentialSourceRef,
    credentialBindingGeneration: binding.credentialBindingGeneration,
    buildPrompt: () => prompt,
    persistRawArtifact,
    createRawArtifactCapture,
    fetcher,
    createId: () => "00000000-0000-4000-8000-000000000002",
    now: () => new Date("2026-10-16T12:00:00.000Z"),
  });
}

function responseSse(): Response {
  const output = {
    schemaVersion: "nr-review/1",
    reviewId: "review-1",
    cycleId: "cycle-1",
    runId: "run-1",
    attemptId: "attempt-1",
    promptHash,
    direction: "correctness",
    objectFormat: "sha1",
    reviewedBaseSha: baseSha,
    reviewedHeadSha: headSha,
    verdict: "NO_FINDINGS",
    coverage: { complete: true, paths: ["README.md"], limitations: [] },
    findings: [],
  };
  const response = {
    id: "response-1",
    status: "completed",
    model: CHATGPT_WEB_BRIDGE_PIN.model,
    reasoning: { effort: CHATGPT_WEB_BRIDGE_PIN.reasoningEffort },
  };
  const body = [
    "event: response.created",
    `data: ${JSON.stringify({ type: "response.created", response })}`,
    "",
    "event: response.output_text.delta",
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: JSON.stringify(output) })}`,
    "",
    "event: response.completed",
    `data: ${JSON.stringify({ type: "response.completed", response })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function backendInput(): BackendInvocationInput {
  return {
    claim: {
      reviewId: "review-1",
      cycleId: "cycle-1",
      runId: "run-1",
      direction: "correctness",
      replicaIndex: 1,
      attemptId: "attempt-1",
      attemptNumber: 1,
      workKind: "TURN",
      deadlineAtUtc: "2026-10-16T13:00:00.000Z",
      attemptDeadlineAtUtc: "2026-10-16T12:30:00.000Z",
      lease: { resourceId: "job-run-1", ownerId: "daemon-1", token: 1 },
      leaseExpiresAtUtc: "2026-10-16T12:31:00.000Z",
    },
    context: {
      reviewId: "review-1",
      cycleId: "cycle-1",
      runId: "run-1",
      direction: "correctness",
      replicaIndex: 1,
      objectFormat: "sha1",
      baseSha,
      headSha,
      promptHash,
      schemaHash: "d".repeat(64),
      policyHash: "e".repeat(64),
    },
    signal: new AbortController().signal,
  };
}

test("versioned binding parser rejects unknown and duplicate fields", () => {
  expect(parseProductionBinding(bindingText())).toMatchObject({
    schemaVersion: "nr09-production-binding/1",
    credentialProfileId: sourceRef.account,
    credentialBindingGeneration: 1,
  });

  expect(() =>
    parseProductionBinding(bindingText({ ...binding, unexpected: "field" })),
  ).toThrow(ProductionBindingError);
  expect(() =>
    parseProductionBinding(
      '{"schemaVersion":"nr09-production-binding/1","schemaVersion":"nr09-production-binding/1"}\n',
    ),
  ).toThrow(ProductionBindingError);
});

test("private binding files require a private directory and regular non-symlink file", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "nr09-binding-test-"));
  const directory = path.join(temporary, "profiles");
  const file = path.join(directory, "binding.json");
  try {
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(file, bindingText(), { mode: 0o600 });
    await chmod(file, 0o600);
    expect(await readPrivateProductionBinding(file)).toMatchObject({
      credentialProfileId: sourceRef.account,
    });

    await chmod(file, 0o644);
    await expect(readPrivateProductionBinding(file)).rejects.toMatchObject({
      code: "PRODUCTION_BINDING_NOT_PRIVATE",
    });
    await chmod(file, 0o600);
    await writeFile(file, "x".repeat(16 * 1024 + 1));
    await expect(readPrivateProductionBinding(file)).rejects.toMatchObject({
      code: "PRODUCTION_BINDING_INVALID",
    });
    await writeFile(file, bindingText());
    const link = path.join(directory, "binding-link.json");
    await symlink(file, link);
    await expect(readPrivateProductionBinding(link)).rejects.toMatchObject({
      code: "PRODUCTION_BINDING_NOT_PRIVATE",
    });
    await expect(
      readPrivateProductionBinding(path.join(directory, "missing.json")),
    ).rejects.toMatchObject({ code: "PRODUCTION_BINDING_MISSING" });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a fake Keychain resolver returns the sentinel without inheriting secret env", async () => {
  const environment = createAllowlistedChildProcessEnvironment({
    HOME: "/Users/tester",
    PATH: "/tmp/untrusted-bin",
    BRIDGE_SPIKE_API_KEY: sentinelBearer,
    OTHER_SECRET: sentinelBearer,
  });
  expect(environment).toEqual({
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    HOME: "/Users/tester",
  });

  let runnerCalls = 0;
  const runner: CredentialCommandRunner = (command, args, options) => {
    runnerCalls += 1;
    expect(command).toBe("/usr/bin/security");
    expect(args).toEqual([
      "find-generic-password",
      "-s",
      sourceRef.service,
      "-a",
      sourceRef.account,
      "-w",
    ]);
    expect(Object.keys(options.env).sort()).toEqual(["LANG", "PATH"]);
    expect(options.timeout).toBe(30_000);
    expect(JSON.stringify(options.env)).not.toContain(sentinelBearer);
    expect(JSON.stringify(args)).not.toContain(sentinelBearer);
    return `${sentinelBearer}\n`;
  };
  const resolver = createMacOSKeychainCredentialResolver({
    runner,
    platform: "darwin",
    environment: { BRIDGE_SPIKE_API_KEY: sentinelBearer },
  });
  const resolved = await resolver.resolve(sourceRef);

  expect(runnerCalls).toBe(1);
  expect(resolved).toBe(sentinelBearer);
});

test("bound fake resolver secret reaches the backend but never profile, receipt, or artifacts", async () => {
  const parsedBinding = parseProductionBinding(bindingText());
  const resolverCalls: CredentialSourceRef[] = [];
  const resolved = await resolveBoundProductionCredential(
    parsedBinding,
    expectedIdentity(parsedBinding),
    {
      async resolve(source) {
        resolverCalls.push(source);
        return sentinelBearer;
      },
    },
  );
  const authorizations: string[] = [];
  let responseCount = 0;
  const captured: Uint8Array[] = [];
  const backend = backendForSecret(
    resolved,
    fakeFetch(async (input, init) => {
      authorizations.push(
        new Headers(init?.headers).get("authorization") ?? "",
      );
      const url = new URL(String(input));
      if (url.pathname === "/healthz") {
        return Response.json({
          service: "codex-chatgpt-web",
          status: "ok",
          pid: 42,
          version: CHATGPT_WEB_BRIDGE_PIN.upstreamVersion,
          mode: "full",
          accepting_turns: true,
          active_http_turns: 0,
          active_browser_turns: 0,
        });
      }
      if (url.pathname === "/v1/models") {
        return Response.json({
          models: [
            {
              slug: CHATGPT_WEB_BRIDGE_PIN.model,
              supported_reasoning_levels: [{ effort: "high" }],
            },
          ],
        });
      }
      if (url.pathname === "/v1/responses") {
        responseCount += 1;
        return responseSse();
      }
      throw new Error("Unexpected fake endpoint.");
    }),
    captured,
  );

  const result = await backend.invoke(backendInput());

  expect(resolverCalls).toEqual([sourceRef]);
  expect(responseCount).toBe(1);
  expect(authorizations).toEqual([
    "",
    `Bearer ${sentinelBearer}`,
    `Bearer ${sentinelBearer}`,
  ]);
  expect(JSON.stringify(backend.profile)).not.toContain(sentinelBearer);
  expect(JSON.stringify(result)).not.toContain(sentinelBearer);
  expect(
    captured.some((bytes) => Buffer.from(bytes).includes(sentinelBearer)),
  ).toBe(false);
});

test("missing and mismatched bindings fail before resolver or fetch", async () => {
  let resolverCalls = 0;
  let fetchCalls = 0;
  const resolver = {
    async resolve() {
      resolverCalls += 1;
      return sentinelBearer;
    },
  };
  const executeIfReady = async (value: ProductionBinding | undefined) => {
    const secret = await resolveBoundProductionCredential(
      value,
      expectedIdentity(),
      resolver,
    );
    const backend = backendForSecret(
      secret,
      fakeFetch(async () => {
        fetchCalls += 1;
        return Response.json({});
      }),
      [],
    );
    await backend.checkCompatibility();
  };

  await expect(executeIfReady(undefined)).rejects.toMatchObject({
    code: "PRODUCTION_BINDING_MISSING",
  });
  const mismatched = {
    ...binding,
    credentialBindingGeneration: binding.credentialBindingGeneration + 1,
  };
  await expect(executeIfReady(mismatched)).rejects.toMatchObject({
    code: "PHASE_B_BINDING_MISMATCH",
  });
  expect(resolverCalls).toBe(0);
  expect(fetchCalls).toBe(0);
});

test("resolver failures and empty values are sanitized before fetch", async () => {
  let fetchCalls = 0;
  const executeIfReady = async (resolver: CredentialResolver) => {
    const secret = await resolveBoundProductionCredential(
      binding,
      expectedIdentity(),
      resolver,
    );
    const backend = backendForSecret(
      secret,
      fakeFetch(async () => {
        fetchCalls += 1;
        return Response.json({});
      }),
      [],
    );
    await backend.checkCompatibility();
  };

  await expect(
    executeIfReady({
      async resolve() {
        throw new Error(sentinelBearer);
      },
    }),
  ).rejects.toMatchObject({ code: "CREDENTIAL_SOURCE_UNAVAILABLE" });
  await expect(
    executeIfReady({
      async resolve() {
        return "";
      },
    }),
  ).rejects.toMatchObject({ code: "CREDENTIAL_SOURCE_EMPTY" });
  const failedKeychainResolver = createMacOSKeychainCredentialResolver({
    platform: "darwin",
    runner() {
      throw new Error(sentinelBearer);
    },
  });
  let keychainFailure: unknown;
  try {
    await executeIfReady(failedKeychainResolver);
  } catch (error) {
    keychainFailure = error;
  }
  expect(keychainFailure).toBeInstanceOf(ProductionBindingError);
  expect(keychainFailure).toMatchObject({
    code: "CREDENTIAL_SOURCE_UNAVAILABLE",
  });
  if (!(keychainFailure instanceof Error)) {
    throw new Error("Keychain failure was not typed.");
  }
  expect(keychainFailure.message).not.toContain(sentinelBearer);
  expect(fetchCalls).toBe(0);
});

test("malformed profile identity fails before resolver or fetch", async () => {
  let resolverCalls = 0;
  let fetchCalls = 0;
  const resolver: CredentialResolver = {
    async resolve() {
      resolverCalls += 1;
      return sentinelBearer;
    },
  };
  const malformed: unknown[] = [
    { ...binding, credentialProfileId: "profile with spaces" },
    {
      ...binding,
      credentialSourceRef: { ...sourceRef, service: "invalid service" },
    },
    {
      ...binding,
      credentialSourceRef: { ...sourceRef, service: "Other.Valid.Service" },
    },
    { ...binding, credentialBindingGeneration: 0 },
    { ...binding, clientVersion: "0.159.0&account=other" },
  ];
  for (const value of malformed) {
    await expect(
      (async () => {
        const parsed = parseProductionBinding(bindingText(value));
        const secret = await resolveBoundProductionCredential(
          parsed,
          expectedIdentity(parsed),
          resolver,
        );
        const backend = backendForSecret(
          secret,
          fakeFetch(async () => {
            fetchCalls += 1;
            return Response.json({});
          }),
          [],
        );
        await backend.checkCompatibility();
      })(),
    ).rejects.toMatchObject({ code: "PRODUCTION_BINDING_INVALID" });
  }
  expect(resolverCalls).toBe(0);
  expect(fetchCalls).toBe(0);
});
