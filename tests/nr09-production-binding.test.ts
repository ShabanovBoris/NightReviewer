import { expect, test } from "bun:test";
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
  assertProductionBindingMatches,
  createAllowlistedChildProcessEnvironment,
  type ExpectedProductionBindingIdentity,
  type ProductionBinding,
  ProductionBindingError,
  parseProductionBinding,
  readPrivateProductionBinding,
} from "../scripts/nr09-production-binding";
import {
  CHATGPT_WEB_AUTH_MODE,
  CHATGPT_WEB_BRIDGE_ORIGIN,
  CHATGPT_WEB_BRIDGE_PIN,
} from "../src/backends/chatgpt-web";

const clientVersionProvenance = {
  kind: "active-codex-desktop-bundle" as const,
  bundleIdentifier: "com.example.codex",
  applicationPath: "/Applications/Codex.app",
  observedVersion: "1.2.3",
  observedAtUtc: "2026-10-16T12:00:00.000Z",
};

const binding: ProductionBinding = {
  schemaVersion: "nr09-production-binding/2",
  authMode: CHATGPT_WEB_AUTH_MODE,
  bridge: {
    origin: CHATGPT_WEB_BRIDGE_ORIGIN,
    versionPin: CHATGPT_WEB_BRIDGE_PIN.upstreamVersion,
  },
  clientVersion: "1.2.3",
  clientVersionProvenance,
  model: CHATGPT_WEB_BRIDGE_PIN.model,
  reasoningEffort: CHATGPT_WEB_BRIDGE_PIN.reasoningEffort,
  createdAtUtc: "2026-10-16T12:00:00.000Z",
};

function expectedIdentity(
  value: ProductionBinding = binding,
): ExpectedProductionBindingIdentity {
  return {
    authMode: value.authMode,
    bridgeOrigin: value.bridge.origin,
    bridgeVersion: value.bridge.versionPin,
    clientVersion: value.clientVersion,
    clientVersionProvenance: value.clientVersionProvenance,
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

test("schema-v2 binding accepts the direct route and rejects legacy or unsupported auth", () => {
  expect(parseProductionBinding(bindingText())).toMatchObject({
    schemaVersion: "nr09-production-binding/2",
    authMode: "LOOPBACK_LOCAL",
    bridge: {
      origin: CHATGPT_WEB_BRIDGE_ORIGIN,
      versionPin: CHATGPT_WEB_BRIDGE_PIN.upstreamVersion,
    },
  });

  expect(() =>
    parseProductionBinding(bindingText({ ...binding, unexpected: "field" })),
  ).toThrow(ProductionBindingError);
  expect(() =>
    parseProductionBinding(
      '{"schemaVersion":"nr09-production-binding/2","schemaVersion":"nr09-production-binding/2"}\n',
    ),
  ).toThrow(ProductionBindingError);

  const legacyV1 = {
    ...binding,
    schemaVersion: "nr09-production-binding/1",
    credentialProfileId: "legacy-profile",
    credentialSourceRef: {
      provider: "macos-keychain",
      service: "NightReviewer.NR09.ProductionBearer",
      account: "legacy-profile",
    },
    credentialBindingGeneration: 1,
  };
  expect(() => parseProductionBinding(bindingText(legacyV1))).toThrow(
    ProductionBindingError,
  );

  for (const authMode of ["HTTP_BEARER", "AUTHENTICATED_PROXY"]) {
    expect(() =>
      parseProductionBinding(bindingText({ ...binding, authMode })),
    ).toThrow(ProductionBindingError);
  }
});

test("binding accepts only the exact direct origin", () => {
  const invalidOrigins = [
    "http://localhost:17841",
    "http://[::1]:17841",
    "http://127.0.0.1:17842",
    "http://10.0.0.2:17841",
    "http://user@127.0.0.1:17841",
    "http://user:pass@127.0.0.1:17841",
    "http://127.0.0.1:17841?proxy=1",
    "http://127.0.0.1:17841#fragment",
  ];
  for (const origin of invalidOrigins) {
    expect(() =>
      parseProductionBinding(
        bindingText({ ...binding, bridge: { ...binding.bridge, origin } }),
      ),
    ).toThrow(ProductionBindingError);
  }
});

test("phase-B binding comparison checks auth, route, provenance, model, and effort", () => {
  const parsed = parseProductionBinding(bindingText());
  expect(() =>
    assertProductionBindingMatches(parsed, expectedIdentity(parsed)),
  ).not.toThrow();

  const mismatches: ExpectedProductionBindingIdentity[] = [
    { ...expectedIdentity(), bridgeOrigin: "http://localhost:17841" },
    { ...expectedIdentity(), bridgeVersion: "6.1.2" },
    { ...expectedIdentity(), clientVersion: "1.2.2" },
    {
      ...expectedIdentity(),
      clientVersionProvenance: {
        ...clientVersionProvenance,
        applicationPath: "/Applications/Other.app",
      },
    },
    { ...expectedIdentity(), model: "chatgpt-web/other-model" },
    { ...expectedIdentity(), reasoningEffort: "low" },
  ];
  for (const expected of mismatches) {
    expect(() => assertProductionBindingMatches(parsed, expected)).toThrow(
      ProductionBindingError,
    );
  }
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
      authMode: CHATGPT_WEB_AUTH_MODE,
      bridge: { origin: CHATGPT_WEB_BRIDGE_ORIGIN },
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

test("child process environment remains allowlisted and excludes inherited secrets", () => {
  const secret = "must-not-inherit";
  const environment = createAllowlistedChildProcessEnvironment({
    HOME: "/Users/tester",
    PATH: "/tmp/untrusted-bin",
    BRIDGE_SPIKE_API_KEY: secret,
    OTHER_SECRET: secret,
  });
  expect(environment).toEqual({
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    HOME: "/Users/tester",
  });
  expect(JSON.stringify(environment)).not.toContain(secret);
});
