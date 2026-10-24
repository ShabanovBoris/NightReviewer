import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertVersionAwareLauncherIdentityMatches,
  createVersionAwareLauncherIdentityValidator,
  DEFAULT_NR09_LAUNCHER_COMPATIBILITY_POLICY,
  type LauncherCompatibilityPolicy,
  type LauncherCompatibilityPolicyEntry,
  launcherCompatibilityPolicySha256,
  NR09_LAUNCHER_COMPATIBILITY_POLICY_SCHEMA,
  parseVersionAwareLauncherIdentity,
  resolveVersionAwareLauncher,
  toChatGptWebClientVersionProvenance,
  toChatGptWebLauncherCompatibilityIdentity,
  VersionAwareLauncherError,
  versionAwareLauncherIdentitySha256,
} from "../scripts/nr09-version-aware-launcher";
import {
  CHATGPT_WEB_AUTH_MODE,
  CHATGPT_WEB_BRIDGE_ORIGIN,
  ChatGptWebReviewerBackend,
} from "../src/backends/chatgpt-web";
import type { BackendInvocationInput } from "../src/scheduler/types";

const BUNDLE_IDENTIFIER = "dev.codexwebgpt.launcher";
const BRIDGE_VERSION = "6.1.3";
const EXECUTABLE_NAME = "Codex Web GPT";

interface Fixture {
  readonly root: string;
  readonly applicationPath: string;
  readonly phaseBRoot: string;
  readonly profileRoot: string;
  readonly profileRoots: readonly string[];
  dispose(): Promise<void>;
}

interface BundleFiles {
  readonly infoPlist: Uint8Array;
  readonly executable: Uint8Array;
  readonly appArchive: Uint8Array;
}

async function makeFixture(): Promise<Fixture> {
  const temporaryRoot =
    process.platform === "darwin" ? "/private/tmp" : os.tmpdir();
  const root = await mkdtemp(path.join(temporaryRoot, "nr09-version-test-"));
  const phaseBRoot = path.join(root, "phase-b");
  const profileRoot = path.join(phaseBRoot, "profile");
  const profileRoots = [
    profileRoot,
    path.join(profileRoot, "codex-home"),
    path.join(profileRoot, "launcher"),
  ];
  for (const directory of [phaseBRoot, ...profileRoots]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  return {
    root,
    applicationPath: path.join(root, "Applications", "Codex Web GPT.app"),
    phaseBRoot,
    profileRoot,
    profileRoots,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

function bundleFiles(version: string, marker = "verified"): BundleFiles {
  const infoPlist = Buffer.from(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      "<key>CFBundleIdentifier</key><string>dev.codexwebgpt.launcher</string>",
      `<key>CFBundleShortVersionString</key><string>${version}</string>`,
      `<key>CFBundleVersion</key><string>${version.replaceAll(".", "")}</string>`,
      `<key>CFBundleExecutable</key><string>${EXECUTABLE_NAME}</string>`,
      "</dict></plist>",
    ].join("\n"),
    "utf8",
  );
  return {
    infoPlist,
    executable: Buffer.from(`fixture executable ${version} ${marker}`, "utf8"),
    appArchive: Buffer.from(`fixture app.asar ${version} ${marker}`, "utf8"),
  };
}

function binaryPlistStringDictionary(
  values: Readonly<Record<string, string>>,
): Buffer {
  const entries = Object.entries(values);
  const encodeString = (text: string): Buffer => {
    const bytes = Buffer.from(text, "ascii");
    return bytes.length < 15
      ? Buffer.concat([Buffer.from([0x50 | bytes.length]), bytes])
      : Buffer.concat([Buffer.from([0x5f, 0x10, bytes.length]), bytes]);
  };
  const objects = [
    Buffer.from([
      0xd0 | entries.length,
      ...entries.map((_, index) => index + 1),
      ...entries.map((_, index) => index + entries.length + 1),
    ]),
    ...entries.map(([key]) => encodeString(key)),
    ...entries.map(([, value]) => encodeString(value)),
  ];
  const offsets: number[] = [];
  let currentOffset = 8;
  for (const object of objects) {
    offsets.push(currentOffset);
    currentOffset += object.byteLength;
  }
  const offsetTableOffset = currentOffset;
  const offsetTable = Buffer.from(offsets);
  const trailer = Buffer.alloc(32);
  trailer[6] = 1;
  trailer[7] = 1;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(offsetTableOffset), 24);
  return Buffer.concat([
    Buffer.from("bplist00", "ascii"),
    ...objects,
    offsetTable,
    trailer,
  ]);
}

async function writeBundle(
  applicationPath: string,
  files: BundleFiles,
): Promise<void> {
  const executableDirectory = path.join(applicationPath, "Contents", "MacOS");
  const resourcesDirectory = path.join(
    applicationPath,
    "Contents",
    "Resources",
  );
  await mkdir(executableDirectory, { recursive: true });
  await mkdir(resourcesDirectory, { recursive: true });
  await writeFile(
    path.join(applicationPath, "Contents", "Info.plist"),
    files.infoPlist,
  );
  const executablePath = path.join(executableDirectory, EXECUTABLE_NAME);
  await writeFile(executablePath, files.executable);
  await chmod(executablePath, 0o755);
  await writeFile(path.join(resourcesDirectory, "app.asar"), files.appArchive);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function entryFor(
  version: string,
  files: BundleFiles,
): LauncherCompatibilityPolicyEntry {
  const releaseAsset = Buffer.from(`verified release ${version}`, "utf8");
  return {
    version,
    bundleVersion: null,
    executableName: EXECUTABLE_NAME,
    contentHashes: {
      infoPlistSha256: sha256(files.infoPlist),
      executableSha256: sha256(files.executable),
      appArchiveSha256: sha256(files.appArchive),
    },
    signing: {
      kind: "AD_HOC",
      teamIdentifier: null,
      evidenceRef: `SIGNING-${version.replaceAll(".", "-")}`,
    },
    release: {
      repository: "fixture/codex-web-gpt",
      tag: `v${version}`,
      commit: "a".repeat(40),
      asset: `codex-web-gpt-${version}-mac-arm64.dmg`,
      assetSha256: sha256(releaseAsset),
      assetSizeBytes: releaseAsset.byteLength,
      trustBasis: "GITHUB_RELEASE_ACCOUNT_PLUS_EXACT_PUBLISHED_DIGEST",
      evidenceRefs: [`RELEASE-${version.replaceAll(".", "-")}`],
    },
    upstreamBridgeVersion: BRIDGE_VERSION,
    requiredCapabilities: [
      "codex-web-gpt-launcher",
      "direct-loopback-responses-6.1.3",
    ],
  };
}

function policyFor(
  entries: readonly LauncherCompatibilityPolicyEntry[],
): LauncherCompatibilityPolicy {
  return {
    schemaVersion: NR09_LAUNCHER_COMPATIBILITY_POLICY_SCHEMA,
    policyId: "fixture-codex-web-gpt-policy/1",
    expectedBundleIdentifier: BUNDLE_IDENTIFIER,
    entries,
  };
}

function optionsFor(fixture: Fixture, policy: LauncherCompatibilityPolicy) {
  return {
    applicationPath: fixture.applicationPath,
    applicationRoots: [path.join(fixture.root, "Applications")],
    phaseBRoot: fixture.phaseBRoot,
    profileRoots: fixture.profileRoots,
    expectedUpstreamBridgeVersion: BRIDGE_VERSION,
    policy,
    now: () => new Date("2026-10-19T10:00:00.000Z"),
  };
}

async function expectLauncherError(
  promise: Promise<unknown>,
  code: VersionAwareLauncherError["code"],
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(VersionAwareLauncherError);
  expect((caught as VersionAwareLauncherError).code).toBe(code);
}

test("accepts the currently verified bundle by exact policy and hashes", async () => {
  const fixture = await makeFixture();
  try {
    const files = bundleFiles("6.1.3");
    await writeBundle(fixture.applicationPath, files);
    const policy = policyFor([entryFor("6.1.3", files)]);
    const identity = await resolveVersionAwareLauncher(
      optionsFor(fixture, policy),
    );

    expect(identity).toMatchObject({
      bundleIdentifier: BUNDLE_IDENTIFIER,
      applicationPath: fixture.applicationPath,
      version: "6.1.3",
      upstreamBridgeVersion: BRIDGE_VERSION,
      compatibilityPolicyId: policy.policyId,
      compatibilityPolicySha256: launcherCompatibilityPolicySha256(policy),
    });
    expect(identity.identitySha256).toBe(
      versionAwareLauncherIdentitySha256({
        schemaVersion: identity.schemaVersion,
        bundleIdentifier: identity.bundleIdentifier,
        applicationPath: identity.applicationPath,
        version: identity.version,
        bundleVersion: identity.bundleVersion,
        executableName: identity.executableName,
        contentHashes: identity.contentHashes,
        signing: identity.signing,
        release: identity.release,
        upstreamBridgeVersion: identity.upstreamBridgeVersion,
        compatibilityPolicyId: identity.compatibilityPolicyId,
        compatibilityPolicySha256: identity.compatibilityPolicySha256,
      }),
    );
    expect(parseVersionAwareLauncherIdentity(identity, policy)).toEqual(
      identity,
    );
    expect(toChatGptWebLauncherCompatibilityIdentity(identity)).toMatchObject({
      policyId: policy.policyId,
      launcherIdentitySha256: identity.identitySha256,
      infoPlistSha256: sha256(files.infoPlist),
    });
  } finally {
    await fixture.dispose();
  }
});

test("default compatibility policy cannot be mutated at runtime", () => {
  const policy = DEFAULT_NR09_LAUNCHER_COMPATIBILITY_POLICY;
  const entry = policy.entries[0];
  expect(Object.isFrozen(policy)).toBe(true);
  expect(Object.isFrozen(policy.entries)).toBe(true);
  expect(entry).toBeDefined();
  expect(Object.isFrozen(entry)).toBe(true);
  expect(Object.isFrozen(entry?.contentHashes)).toBe(true);
  expect(Object.isFrozen(entry?.signing)).toBe(true);
  expect(Object.isFrozen(entry?.release)).toBe(true);
  expect(Object.isFrozen(entry?.release.evidenceRefs)).toBe(true);
  expect(Object.isFrozen(entry?.requiredCapabilities)).toBe(true);
});

test("reads binary Info.plist metadata without invoking platform tools", async () => {
  const fixture = await makeFixture();
  try {
    const files = bundleFiles("6.1.3");
    const binaryInfoPlist = binaryPlistStringDictionary({
      CFBundleIdentifier: BUNDLE_IDENTIFIER,
      CFBundleShortVersionString: "6.1.3",
      CFBundleVersion: "6130",
      CFBundleExecutable: EXECUTABLE_NAME,
    });
    const binaryBundle = { ...files, infoPlist: binaryInfoPlist };
    await writeBundle(fixture.applicationPath, binaryBundle);
    const identity = await resolveVersionAwareLauncher(
      optionsFor(fixture, policyFor([entryFor("6.1.3", binaryBundle)])),
    );
    expect(identity.version).toBe("6.1.3");
    expect(identity.bundleVersion).toBe("6130");
  } finally {
    await fixture.dispose();
  }
});

test("rediscovers a verified update at the normal app path and rejects stale identity", async () => {
  const fixture = await makeFixture();
  try {
    const oldFiles = bundleFiles("6.1.3");
    const newFiles = bundleFiles("6.1.4");
    await writeBundle(fixture.applicationPath, oldFiles);
    const policy = policyFor([
      entryFor("6.1.3", oldFiles),
      entryFor("6.1.4", newFiles),
    ]);
    const oldIdentity = await resolveVersionAwareLauncher(
      optionsFor(fixture, policy),
    );

    await writeBundle(fixture.applicationPath, newFiles);
    const updatedIdentity = await resolveVersionAwareLauncher(
      optionsFor(fixture, policy),
    );

    expect(updatedIdentity.applicationPath).toBe(oldIdentity.applicationPath);
    expect(updatedIdentity.version).toBe("6.1.4");
    expect(updatedIdentity.identitySha256).not.toBe(oldIdentity.identitySha256);
    let driftError: unknown;
    try {
      assertVersionAwareLauncherIdentityMatches(oldIdentity, updatedIdentity);
    } catch (error) {
      driftError = error;
    }
    expect(driftError).toBeInstanceOf(VersionAwareLauncherError);
    expect((driftError as VersionAwareLauncherError).code).toBe(
      "LAUNCHER_IDENTITY_CHANGED",
    );
    expect(() =>
      assertVersionAwareLauncherIdentityMatches(
        updatedIdentity,
        updatedIdentity,
      ),
    ).not.toThrow();
    const revisedPolicy: LauncherCompatibilityPolicy = {
      ...policy,
      policyId: "fixture-codex-web-gpt-policy/2",
    };
    const revisedPolicyIdentity = await resolveVersionAwareLauncher(
      optionsFor(fixture, revisedPolicy),
    );
    expect(revisedPolicyIdentity.identitySha256).not.toBe(
      updatedIdentity.identitySha256,
    );
    let policyDriftError: unknown;
    try {
      assertVersionAwareLauncherIdentityMatches(
        updatedIdentity,
        revisedPolicyIdentity,
      );
    } catch (error) {
      policyDriftError = error;
    }
    expect(policyDriftError).toBeInstanceOf(VersionAwareLauncherError);
    expect((policyDriftError as VersionAwareLauncherError).code).toBe(
      "LAUNCHER_IDENTITY_CHANGED",
    );
  } finally {
    await fixture.dispose();
  }
});

test("blocks the next backend invocation when the installed bundle updates after construction", async () => {
  const fixture = await makeFixture();
  try {
    const initialFiles = bundleFiles("6.1.3");
    const updatedFiles = bundleFiles("6.1.4");
    await writeBundle(fixture.applicationPath, initialFiles);
    const policy = policyFor([
      entryFor("6.1.3", initialFiles),
      entryFor("6.1.4", updatedFiles),
    ]);
    const initialIdentity = await resolveVersionAwareLauncher(
      optionsFor(fixture, policy),
    );
    let fetchCalls = 0;
    let validatorCalls = 0;
    const validator = createVersionAwareLauncherIdentityValidator(
      initialIdentity,
      optionsFor(fixture, policy),
    );
    const prompt = "Review the bound snapshot without changing files.";
    const promptHash = sha256(Buffer.from(prompt, "utf8"));
    const persistRawArtifact = async (bytes: Uint8Array) => ({
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      relativePath: "artifacts/launcher-update-test",
    });
    const backend = new ChatGptWebReviewerBackend({
      authMode: CHATGPT_WEB_AUTH_MODE,
      baseUrl: `${CHATGPT_WEB_BRIDGE_ORIGIN}/`,
      clientVersion: initialIdentity.version,
      clientVersionProvenance:
        toChatGptWebClientVersionProvenance(initialIdentity),
      launcherCompatibilityIdentity:
        toChatGptWebLauncherCompatibilityIdentity(initialIdentity),
      verifyCurrentClientIdentity: async () => {
        validatorCalls += 1;
        return validator();
      },
      buildPrompt: () => prompt,
      persistRawArtifact,
      createRawArtifactCapture: async () => ({
        async write() {},
        async commit() {
          return persistRawArtifact(new Uint8Array());
        },
        async abort() {},
      }),
      fetcher: (async () => {
        fetchCalls += 1;
        throw new Error("The installed launcher changed before this request.");
      }) as unknown as typeof fetch,
      createId: () => "launcher-update-test-id",
      now: () => new Date("2026-10-19T10:00:00.000Z"),
    });
    const input: BackendInvocationInput = {
      claim: {
        reviewId: "review-update",
        cycleId: "cycle-update",
        runId: "run-update",
        direction: "correctness",
        replicaIndex: 1,
        attemptId: "attempt-update",
        attemptNumber: 1,
        workKind: "TURN",
        deadlineAtUtc: "2026-10-19T11:00:00.000Z",
        attemptDeadlineAtUtc: "2026-10-19T10:30:00.000Z",
        lease: { resourceId: "job-update", ownerId: "daemon-update", token: 1 },
        leaseExpiresAtUtc: "2026-10-19T10:31:00.000Z",
      },
      context: {
        reviewId: "review-update",
        cycleId: "cycle-update",
        runId: "run-update",
        direction: "correctness",
        replicaIndex: 1,
        objectFormat: "sha1",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        promptHash,
        schemaHash: "c".repeat(64),
        policyHash: "d".repeat(64),
      },
      signal: new AbortController().signal,
    };

    await writeBundle(fixture.applicationPath, updatedFiles);
    const result = await backend.invoke(input);

    expect(result.kind).toBe("PERMANENT_FAILURE");
    expect(result.sendState).toBe("UNSENT");
    expect(validatorCalls).toBe(1);
    expect(fetchCalls).toBe(0);
  } finally {
    await fixture.dispose();
  }
});

test("fails closed for an unknown update and for same-version content drift", async () => {
  const fixture = await makeFixture();
  try {
    const verifiedFiles = bundleFiles("6.1.3");
    const policy = policyFor([entryFor("6.1.3", verifiedFiles)]);

    await writeBundle(fixture.applicationPath, bundleFiles("6.1.4"));
    await expectLauncherError(
      resolveVersionAwareLauncher(optionsFor(fixture, policy)),
      "APPLICATION_VERSION_UNSUPPORTED",
    );

    await writeBundle(fixture.applicationPath, verifiedFiles);
    await resolveVersionAwareLauncher(optionsFor(fixture, policy));
    await writeBundle(
      fixture.applicationPath,
      bundleFiles("6.1.3", "tampered"),
    );
    await expectLauncherError(
      resolveVersionAwareLauncher(optionsFor(fixture, policy)),
      "APPLICATION_CONTENT_MISMATCH",
    );
  } finally {
    await fixture.dispose();
  }
});

test("rejects malformed bundle metadata, symlinks, and upstream bridge drift", async () => {
  const fixture = await makeFixture();
  try {
    const files = bundleFiles("6.1.3");
    await writeBundle(fixture.applicationPath, files);
    const policy = policyFor([entryFor("6.1.3", files)]);
    const invalidMetadata = Buffer.from("<plist><dict></dict></plist>");
    await writeFile(
      path.join(fixture.applicationPath, "Contents", "Info.plist"),
      invalidMetadata,
    );
    await expectLauncherError(
      resolveVersionAwareLauncher(optionsFor(fixture, policy)),
      "APPLICATION_METADATA_INVALID",
    );
    await writeBundle(fixture.applicationPath, files);

    const copiedAppPath = path.join(fixture.root, "Copied Codex Web GPT.app");
    await writeBundle(copiedAppPath, files);
    await expectLauncherError(
      resolveVersionAwareLauncher({
        ...optionsFor(fixture, policy),
        applicationPath: copiedAppPath,
      }),
      "APPLICATION_PATH_INVALID",
    );

    const symlinkPath = path.join(fixture.root, "Linked.app");
    await symlink(fixture.applicationPath, symlinkPath);
    await expectLauncherError(
      resolveVersionAwareLauncher({
        ...optionsFor(fixture, policy),
        applicationPath: symlinkPath,
      }),
      "APPLICATION_PATH_SYMLINK",
    );
    const executablePath = path.join(
      fixture.applicationPath,
      "Contents",
      "MacOS",
      EXECUTABLE_NAME,
    );
    const externalExecutable = path.join(fixture.root, "external-executable");
    await writeFile(externalExecutable, files.executable);
    await rm(executablePath);
    await symlink(externalExecutable, executablePath);
    await expectLauncherError(
      resolveVersionAwareLauncher(optionsFor(fixture, policy)),
      "APPLICATION_CONTENT_MISMATCH",
    );
    await expectLauncherError(
      resolveVersionAwareLauncher({
        ...optionsFor(fixture, policy),
        expectedUpstreamBridgeVersion: "6.1.4",
      }),
      "UPSTREAM_BRIDGE_UNSUPPORTED",
    );
    const missingCapabilityPolicy = policyFor([
      {
        ...entryFor("6.1.3", files),
        requiredCapabilities: ["codex-web-gpt-launcher"],
      },
    ]);
    await expectLauncherError(
      resolveVersionAwareLauncher(optionsFor(fixture, missingCapabilityPolicy)),
      "APPLICATION_PROVENANCE_UNVERIFIED",
    );
  } finally {
    await fixture.dispose();
  }
});

test("keeps Phase B data owner-only, separate from the installed app, without reading profile files", async () => {
  const fixture = await makeFixture();
  try {
    const files = bundleFiles("6.1.3");
    await writeBundle(fixture.applicationPath, files);
    const policy = policyFor([entryFor("6.1.3", files)]);
    const marker = path.join(fixture.profileRoot, "unreadable-profile-marker");
    await writeFile(marker, "profile contents are never read", { mode: 0o000 });
    await chmod(marker, 0o000);

    const identity = await resolveVersionAwareLauncher(
      optionsFor(fixture, policy),
    );
    expect(identity.applicationPath).not.toContain(fixture.phaseBRoot);

    await chmod(fixture.profileRoot, 0o755);
    await expectLauncherError(
      resolveVersionAwareLauncher(optionsFor(fixture, policy)),
      "PHASE_B_PATH_INVALID",
    );
    await chmod(fixture.profileRoot, 0o700);
    const linkedProfileRoot = path.join(fixture.phaseBRoot, "linked-profile");
    await symlink(fixture.profileRoot, linkedProfileRoot);
    await expectLauncherError(
      resolveVersionAwareLauncher({
        ...optionsFor(fixture, policy),
        profileRoots: [linkedProfileRoot],
      }),
      "PHASE_B_PATH_INVALID",
    );
  } finally {
    await fixture.dispose();
  }
});

test("launcher resolver has no process, network, browser, or credential integration", async () => {
  const source = await readFile(
    new URL("../scripts/nr09-version-aware-launcher.ts", import.meta.url),
    "utf8",
  );
  expect(source).not.toMatch(
    /node:(child_process|net|http|https)|\b(fetch|spawn|execFile)\s*\(/,
  );
});
