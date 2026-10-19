import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  ChatGptWebClientVersionProvenance,
  ChatGptWebLauncherCompatibilityIdentity,
} from "../src/backends/chatgpt-web";

export const NR09_LAUNCHER_IDENTITY_SCHEMA = "nr09-launcher-identity/1";
export const NR09_LAUNCHER_COMPATIBILITY_POLICY_SCHEMA =
  "nr09-launcher-compatibility-policy/1";
export const NR09_LAUNCHER_COMPATIBILITY_POLICY_ID =
  "codex-web-gpt-verified-release-components/1";

const BUNDLE_IDENTIFIER = "dev.codexwebgpt.launcher";
const INFO_PLIST_RELATIVE_PATH = path.join("Contents", "Info.plist");
const EXECUTABLES_RELATIVE_PATH = path.join("Contents", "MacOS");
const APP_ARCHIVE_RELATIVE_PATH = path.join(
  "Contents",
  "Resources",
  "app.asar",
);
const MAX_INFO_PLIST_BYTES = 2 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_APP_ARCHIVE_BYTES = 512 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type LauncherSigningKind = "AD_HOC";

export interface LauncherContentHashes {
  readonly infoPlistSha256: string;
  readonly executableSha256: string;
  readonly appArchiveSha256: string;
}

export interface LauncherReleaseProvenance {
  readonly repository: string;
  readonly tag: string;
  readonly commit: string;
  readonly asset: string;
  readonly assetSha256: string;
  readonly assetSizeBytes: number;
  readonly trustBasis: "GITHUB_RELEASE_ACCOUNT_PLUS_EXACT_PUBLISHED_DIGEST";
  readonly evidenceRefs: readonly string[];
}

export interface LauncherSigningProvenance {
  readonly kind: LauncherSigningKind;
  readonly teamIdentifier: null;
  readonly evidenceRef: string;
}

export interface LauncherCompatibilityPolicyEntry {
  readonly version: string;
  readonly bundleVersion: string | null;
  readonly executableName: string;
  readonly contentHashes: LauncherContentHashes;
  readonly signing: LauncherSigningProvenance;
  readonly release: LauncherReleaseProvenance;
  readonly upstreamBridgeVersion: string;
  readonly requiredCapabilities: readonly string[];
}

export interface LauncherCompatibilityPolicy {
  readonly schemaVersion: typeof NR09_LAUNCHER_COMPATIBILITY_POLICY_SCHEMA;
  readonly policyId: string;
  readonly expectedBundleIdentifier: string;
  readonly entries: readonly LauncherCompatibilityPolicyEntry[];
}

export interface VersionAwareLauncherIdentity {
  readonly schemaVersion: typeof NR09_LAUNCHER_IDENTITY_SCHEMA;
  readonly bundleIdentifier: string;
  readonly applicationPath: string;
  readonly version: string;
  readonly bundleVersion: string;
  readonly executableName: string;
  readonly contentHashes: LauncherContentHashes;
  readonly signing: LauncherSigningProvenance;
  readonly release: LauncherReleaseProvenance;
  readonly upstreamBridgeVersion: string;
  readonly compatibilityPolicyId: string;
  readonly compatibilityPolicySha256: string;
  readonly identitySha256: string;
  readonly observedAtUtc: string;
}

export type VersionAwareLauncherErrorCode =
  | "INVALID_ARGUMENTS"
  | "APPLICATION_MISSING"
  | "APPLICATION_PATH_INVALID"
  | "APPLICATION_PATH_SYMLINK"
  | "APPLICATION_METADATA_INVALID"
  | "APPLICATION_BUNDLE_MISMATCH"
  | "APPLICATION_VERSION_UNSUPPORTED"
  | "APPLICATION_PROVENANCE_UNVERIFIED"
  | "APPLICATION_CONTENT_MISMATCH"
  | "COMPATIBILITY_POLICY_INVALID"
  | "UPSTREAM_BRIDGE_UNSUPPORTED"
  | "PHASE_B_ROOT_INVALID"
  | "PHASE_B_PATH_INVALID"
  | "LAUNCHER_IDENTITY_INVALID"
  | "LAUNCHER_IDENTITY_CHANGED";

export class VersionAwareLauncherError extends Error {
  constructor(readonly code: VersionAwareLauncherErrorCode) {
    super("NR-09 launcher compatibility stopped safely.");
    this.name = "VersionAwareLauncherError";
  }
}

const VERIFIED_613_ENTRY: LauncherCompatibilityPolicyEntry = Object.freeze({
  version: "6.1.3",
  bundleVersion: null,
  executableName: "Codex Web GPT",
  contentHashes: Object.freeze({
    infoPlistSha256:
      "9ea0218fe12bb67ecd507df02ba5f64f8d1b4618a62883ed70e3aa4f914dac18",
    executableSha256:
      "0a172a453c2795cf1d5322917de68301ec93bf8a752670a5916cb0fb0f62716e",
    appArchiveSha256:
      "9f65f05eeb3abb571bde17f4b110299240c0922d9018d3338c4ae9f2a31f6b44",
  }),
  signing: Object.freeze({
    kind: "AD_HOC",
    teamIdentifier: null,
    evidenceRef: "D168-CODE-SIGNATURE-PROVENANCE",
  }),
  release: Object.freeze({
    repository: "miuuyy/codex-chatgpt-web",
    tag: "v6.1.3",
    commit: "fa2d2c6c24926078b46eedb2186f69f2e8d548d7",
    asset: "codex-web-gpt-6.1.3-mac-arm64.dmg",
    assetSha256:
      "31750cf9be97cc606ee5e7d204605e1a2ea816291177975fe480161f0f09133e",
    assetSizeBytes: 166_074_027,
    trustBasis: "GITHUB_RELEASE_ACCOUNT_PLUS_EXACT_PUBLISHED_DIGEST",
    evidenceRefs: Object.freeze([
      "D168-LAUNCHER-PROVENANCE",
      "D172-GITHUB-DIGEST-TRUST",
    ]),
  }),
  upstreamBridgeVersion: "6.1.3",
  requiredCapabilities: Object.freeze([
    "codex-web-gpt-launcher",
    "direct-loopback-responses-6.1.3",
  ]),
});

export const DEFAULT_NR09_LAUNCHER_COMPATIBILITY_POLICY: LauncherCompatibilityPolicy =
  Object.freeze({
    schemaVersion: NR09_LAUNCHER_COMPATIBILITY_POLICY_SCHEMA,
    policyId: NR09_LAUNCHER_COMPATIBILITY_POLICY_ID,
    expectedBundleIdentifier: BUNDLE_IDENTIFIER,
    entries: Object.freeze([VERIFIED_613_ENTRY]),
  });

export interface ResolveVersionAwareLauncherOptions {
  readonly applicationPath: string;
  readonly applicationRoots: readonly string[];
  readonly phaseBRoot: string;
  readonly profileRoots: readonly string[];
  readonly expectedUpstreamBridgeVersion: string;
  readonly policy?: LauncherCompatibilityPolicy;
  readonly now?: () => Date;
}

interface BundleMetadata {
  readonly bundleIdentifier: string;
  readonly version: string;
  readonly bundleVersion: string;
  readonly executableName: string;
}

export async function resolveVersionAwareLauncher(
  options: ResolveVersionAwareLauncherOptions,
): Promise<VersionAwareLauncherIdentity> {
  if (
    typeof options.applicationPath !== "string" ||
    options.applicationPath.length === 0 ||
    !Array.isArray(options.applicationRoots) ||
    options.applicationRoots.length === 0 ||
    typeof options.phaseBRoot !== "string" ||
    options.phaseBRoot.length === 0 ||
    !Array.isArray(options.profileRoots) ||
    options.profileRoots.length === 0 ||
    !isReleaseVersion(options.expectedUpstreamBridgeVersion)
  ) {
    throw new VersionAwareLauncherError("INVALID_ARGUMENTS");
  }
  const policy = options.policy ?? DEFAULT_NR09_LAUNCHER_COMPATIBILITY_POLICY;
  validateCompatibilityPolicy(policy);

  const phaseBRoot = await canonicalPrivateDirectory(
    options.phaseBRoot,
    "PHASE_B_ROOT_INVALID",
  );
  for (const profileRoot of options.profileRoots) {
    const canonicalProfileRoot = await canonicalPrivateDirectory(
      profileRoot,
      "PHASE_B_PATH_INVALID",
    );
    if (!isWithin(phaseBRoot, canonicalProfileRoot)) {
      throw new VersionAwareLauncherError("PHASE_B_PATH_INVALID");
    }
  }

  const applicationRoots = await Promise.all(
    options.applicationRoots.map(canonicalApplicationRoot),
  );
  const applicationPath = await canonicalApplicationBundle(
    options.applicationPath,
  );
  if (
    path.extname(applicationPath) !== ".app" ||
    !applicationRoots.some((root) => path.dirname(applicationPath) === root)
  ) {
    throw new VersionAwareLauncherError("APPLICATION_PATH_INVALID");
  }
  if (
    isWithin(phaseBRoot, applicationPath) ||
    isWithin(applicationPath, phaseBRoot)
  ) {
    throw new VersionAwareLauncherError("APPLICATION_PATH_INVALID");
  }

  const metadataBytes = await readBoundedRegularFile(
    path.join(applicationPath, INFO_PLIST_RELATIVE_PATH),
    MAX_INFO_PLIST_BYTES,
    "APPLICATION_METADATA_INVALID",
    applicationPath,
  );
  const metadata = parseBundleMetadata(metadataBytes);
  if (metadata.bundleIdentifier !== policy.expectedBundleIdentifier) {
    throw new VersionAwareLauncherError("APPLICATION_BUNDLE_MISMATCH");
  }

  const policyEntry = policy.entries.find(
    (entry) => entry.version === metadata.version,
  );
  if (policyEntry === undefined) {
    throw new VersionAwareLauncherError("APPLICATION_VERSION_UNSUPPORTED");
  }
  if (
    policyEntry.upstreamBridgeVersion !== options.expectedUpstreamBridgeVersion
  ) {
    throw new VersionAwareLauncherError("UPSTREAM_BRIDGE_UNSUPPORTED");
  }
  if (
    !policyEntry.requiredCapabilities.includes("codex-web-gpt-launcher") ||
    !policyEntry.requiredCapabilities.includes(
      `direct-loopback-responses-${options.expectedUpstreamBridgeVersion}`,
    )
  ) {
    throw new VersionAwareLauncherError("APPLICATION_PROVENANCE_UNVERIFIED");
  }
  if (
    policyEntry.bundleVersion !== null &&
    policyEntry.bundleVersion !== metadata.bundleVersion
  ) {
    throw new VersionAwareLauncherError("APPLICATION_METADATA_INVALID");
  }
  if (policyEntry.executableName !== metadata.executableName) {
    throw new VersionAwareLauncherError("APPLICATION_METADATA_INVALID");
  }

  const executableBytes = await readBoundedRegularFile(
    path.join(
      applicationPath,
      EXECUTABLES_RELATIVE_PATH,
      metadata.executableName,
    ),
    MAX_EXECUTABLE_BYTES,
    "APPLICATION_CONTENT_MISMATCH",
    applicationPath,
  );
  const appArchiveBytes = await readBoundedRegularFile(
    path.join(applicationPath, APP_ARCHIVE_RELATIVE_PATH),
    MAX_APP_ARCHIVE_BYTES,
    "APPLICATION_CONTENT_MISMATCH",
    applicationPath,
  );
  const contentHashes: LauncherContentHashes = {
    infoPlistSha256: sha256(metadataBytes),
    executableSha256: sha256(executableBytes),
    appArchiveSha256: sha256(appArchiveBytes),
  };
  if (!sameContentHashes(contentHashes, policyEntry.contentHashes)) {
    throw new VersionAwareLauncherError("APPLICATION_CONTENT_MISMATCH");
  }
  if (
    policyEntry.signing.kind !== "AD_HOC" ||
    policyEntry.signing.teamIdentifier !== null ||
    policyEntry.release.trustBasis !==
      "GITHUB_RELEASE_ACCOUNT_PLUS_EXACT_PUBLISHED_DIGEST"
  ) {
    throw new VersionAwareLauncherError("APPLICATION_PROVENANCE_UNVERIFIED");
  }

  const policySha256 = launcherCompatibilityPolicySha256(policy);
  const stableIdentity: Omit<
    VersionAwareLauncherIdentity,
    "identitySha256" | "observedAtUtc"
  > = {
    schemaVersion: NR09_LAUNCHER_IDENTITY_SCHEMA,
    bundleIdentifier: metadata.bundleIdentifier,
    applicationPath,
    version: metadata.version,
    bundleVersion: metadata.bundleVersion,
    executableName: metadata.executableName,
    contentHashes,
    signing: policyEntry.signing,
    release: policyEntry.release,
    upstreamBridgeVersion: policyEntry.upstreamBridgeVersion,
    compatibilityPolicyId: policy.policyId,
    compatibilityPolicySha256: policySha256,
  };
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new VersionAwareLauncherError("INVALID_ARGUMENTS");
  }
  return {
    ...stableIdentity,
    identitySha256: versionAwareLauncherIdentitySha256(stableIdentity),
    observedAtUtc: now.toISOString(),
  };
}

export function parseVersionAwareLauncherIdentity(
  value: unknown,
  policy: LauncherCompatibilityPolicy = DEFAULT_NR09_LAUNCHER_COMPATIBILITY_POLICY,
): VersionAwareLauncherIdentity {
  validateCompatibilityPolicy(policy);
  const record = asRecord(value);
  if (
    record === undefined ||
    !hasExactKeys(record, [
      "applicationPath",
      "bundleIdentifier",
      "bundleVersion",
      "compatibilityPolicyId",
      "compatibilityPolicySha256",
      "contentHashes",
      "executableName",
      "identitySha256",
      "observedAtUtc",
      "release",
      "schemaVersion",
      "signing",
      "upstreamBridgeVersion",
      "version",
    ]) ||
    record.schemaVersion !== NR09_LAUNCHER_IDENTITY_SCHEMA ||
    typeof record.bundleIdentifier !== "string" ||
    typeof record.applicationPath !== "string" ||
    !path.isAbsolute(record.applicationPath) ||
    hasControlCharacters(record.applicationPath) ||
    typeof record.version !== "string" ||
    !isReleaseVersion(record.version) ||
    typeof record.bundleVersion !== "string" ||
    record.bundleVersion.length === 0 ||
    hasControlCharacters(record.bundleVersion) ||
    typeof record.executableName !== "string" ||
    !isSafeBasename(record.executableName) ||
    typeof record.upstreamBridgeVersion !== "string" ||
    !isReleaseVersion(record.upstreamBridgeVersion) ||
    record.compatibilityPolicyId !== policy.policyId ||
    record.compatibilityPolicySha256 !==
      launcherCompatibilityPolicySha256(policy) ||
    typeof record.identitySha256 !== "string" ||
    !SHA256_PATTERN.test(record.identitySha256) ||
    typeof record.observedAtUtc !== "string" ||
    !isUtcTimestamp(record.observedAtUtc)
  ) {
    throw new VersionAwareLauncherError("LAUNCHER_IDENTITY_INVALID");
  }

  const contentHashes = parseContentHashes(record.contentHashes);
  const signing = parseSigningProvenance(record.signing);
  const release = parseReleaseProvenance(record.release);
  const entry = policy.entries.find(
    (candidate) => candidate.version === record.version,
  );
  if (
    entry === undefined ||
    record.bundleIdentifier !== policy.expectedBundleIdentifier ||
    record.executableName !== entry.executableName ||
    (entry.bundleVersion !== null &&
      record.bundleVersion !== entry.bundleVersion) ||
    !sameContentHashes(contentHashes, entry.contentHashes) ||
    !sameJson(signing, entry.signing) ||
    !sameJson(release, entry.release) ||
    record.upstreamBridgeVersion !== entry.upstreamBridgeVersion
  ) {
    throw new VersionAwareLauncherError("APPLICATION_PROVENANCE_UNVERIFIED");
  }

  const stableIdentity: Omit<
    VersionAwareLauncherIdentity,
    "identitySha256" | "observedAtUtc"
  > = {
    schemaVersion: NR09_LAUNCHER_IDENTITY_SCHEMA,
    bundleIdentifier: record.bundleIdentifier,
    applicationPath: record.applicationPath,
    version: record.version,
    bundleVersion: record.bundleVersion,
    executableName: record.executableName,
    contentHashes,
    signing,
    release,
    upstreamBridgeVersion: record.upstreamBridgeVersion,
    compatibilityPolicyId: record.compatibilityPolicyId,
    compatibilityPolicySha256: record.compatibilityPolicySha256,
  };
  if (
    versionAwareLauncherIdentitySha256(stableIdentity) !== record.identitySha256
  ) {
    throw new VersionAwareLauncherError("LAUNCHER_IDENTITY_INVALID");
  }
  return {
    ...stableIdentity,
    identitySha256: record.identitySha256,
    observedAtUtc: record.observedAtUtc,
  };
}

export function versionAwareLauncherIdentitySha256(
  identity: Omit<
    VersionAwareLauncherIdentity,
    "identitySha256" | "observedAtUtc"
  >,
): string {
  return sha256(canonicalJson(identity));
}

export function launcherCompatibilityPolicySha256(
  policy: LauncherCompatibilityPolicy,
): string {
  return sha256(canonicalJson(policy));
}

export function toChatGptWebLauncherCompatibilityIdentity(
  identity: VersionAwareLauncherIdentity,
): ChatGptWebLauncherCompatibilityIdentity {
  return {
    policyId: identity.compatibilityPolicyId,
    policySha256: identity.compatibilityPolicySha256,
    launcherIdentitySha256: identity.identitySha256,
    infoPlistSha256: identity.contentHashes.infoPlistSha256,
    executableSha256: identity.contentHashes.executableSha256,
    appArchiveSha256: identity.contentHashes.appArchiveSha256,
  };
}

export function toChatGptWebClientVersionProvenance(
  identity: VersionAwareLauncherIdentity,
): ChatGptWebClientVersionProvenance {
  return {
    kind: "active-codex-desktop-bundle",
    bundleIdentifier: identity.bundleIdentifier,
    applicationPath: identity.applicationPath,
    observedVersion: identity.version,
    observedAtUtc: identity.observedAtUtc,
  };
}

export function assertVersionAwareLauncherIdentityMatches(
  expected: VersionAwareLauncherIdentity,
  observed: VersionAwareLauncherIdentity,
): void {
  if (
    expected.identitySha256 !== observed.identitySha256 ||
    expected.compatibilityPolicyId !== observed.compatibilityPolicyId ||
    expected.compatibilityPolicySha256 !== observed.compatibilityPolicySha256
  ) {
    throw new VersionAwareLauncherError("LAUNCHER_IDENTITY_CHANGED");
  }
}

function validateCompatibilityPolicy(
  policy: LauncherCompatibilityPolicy,
): void {
  if (
    !isRecord(policy) ||
    policy.schemaVersion !== NR09_LAUNCHER_COMPATIBILITY_POLICY_SCHEMA ||
    typeof policy.policyId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(policy.policyId) ||
    policy.expectedBundleIdentifier !== BUNDLE_IDENTIFIER ||
    !Array.isArray(policy.entries) ||
    policy.entries.length === 0
  ) {
    throw new VersionAwareLauncherError("COMPATIBILITY_POLICY_INVALID");
  }
  const versions = new Set<string>();
  for (const entry of policy.entries) {
    if (
      !isRecord(entry) ||
      typeof entry.version !== "string" ||
      !isReleaseVersion(entry.version) ||
      versions.has(entry.version) ||
      (entry.bundleVersion !== null &&
        (typeof entry.bundleVersion !== "string" ||
          entry.bundleVersion.length === 0 ||
          hasControlCharacters(entry.bundleVersion))) ||
      typeof entry.executableName !== "string" ||
      !isSafeBasename(entry.executableName) ||
      typeof entry.upstreamBridgeVersion !== "string" ||
      !isReleaseVersion(entry.upstreamBridgeVersion) ||
      !Array.isArray(entry.requiredCapabilities) ||
      entry.requiredCapabilities.length === 0 ||
      entry.requiredCapabilities.some(
        (capability: unknown) =>
          typeof capability !== "string" ||
          !/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(capability),
      )
    ) {
      throw new VersionAwareLauncherError("COMPATIBILITY_POLICY_INVALID");
    }
    parseContentHashes(entry.contentHashes);
    parseSigningProvenance(entry.signing);
    const release = parseReleaseProvenance(entry.release);
    if (release.tag !== `v${entry.version}`) {
      throw new VersionAwareLauncherError("COMPATIBILITY_POLICY_INVALID");
    }
    versions.add(entry.version);
  }
}

async function canonicalPrivateDirectory(
  inputPath: string,
  failureCode: "PHASE_B_ROOT_INVALID" | "PHASE_B_PATH_INVALID",
): Promise<string> {
  if (!path.isAbsolute(inputPath) || hasControlCharacters(inputPath)) {
    throw new VersionAwareLauncherError(failureCode);
  }
  let stat: Awaited<ReturnType<typeof lstat>>;
  let canonical: string;
  try {
    stat = await lstat(inputPath);
    canonical = await realpath(inputPath);
  } catch {
    throw new VersionAwareLauncherError(failureCode);
  }
  const uid = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (uid !== undefined && stat.uid !== uid) ||
    path.resolve(inputPath) !== canonical
  ) {
    throw new VersionAwareLauncherError(failureCode);
  }
  return canonical;
}

async function canonicalApplicationBundle(inputPath: string): Promise<string> {
  if (!path.isAbsolute(inputPath) || hasControlCharacters(inputPath)) {
    throw new VersionAwareLauncherError("APPLICATION_PATH_INVALID");
  }
  let stat: Awaited<ReturnType<typeof lstat>>;
  let canonical: string;
  try {
    stat = await lstat(inputPath);
    canonical = await realpath(inputPath);
  } catch {
    throw new VersionAwareLauncherError("APPLICATION_MISSING");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new VersionAwareLauncherError("APPLICATION_PATH_SYMLINK");
  }
  if (path.resolve(inputPath) !== canonical) {
    throw new VersionAwareLauncherError("APPLICATION_PATH_INVALID");
  }
  return canonical;
}

async function canonicalApplicationRoot(inputPath: string): Promise<string> {
  if (!path.isAbsolute(inputPath) || hasControlCharacters(inputPath)) {
    throw new VersionAwareLauncherError("APPLICATION_PATH_INVALID");
  }
  let canonical: string;
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    canonical = await realpath(inputPath);
    stat = await lstat(canonical);
  } catch {
    throw new VersionAwareLauncherError("APPLICATION_PATH_INVALID");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new VersionAwareLauncherError("APPLICATION_PATH_INVALID");
  }
  return canonical;
}

async function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
  failureCode: "APPLICATION_METADATA_INVALID" | "APPLICATION_CONTENT_MISMATCH",
  bundlePath: string,
): Promise<Uint8Array> {
  const relativePath = path.relative(bundlePath, filePath);
  if (!isWithin(bundlePath, filePath) || relativePath.length === 0) {
    throw new VersionAwareLauncherError(failureCode);
  }
  const components = relativePath.split(path.sep);
  let currentPath = bundlePath;
  let fileStat: Awaited<ReturnType<typeof lstat>> | undefined;
  let canonical: string;
  try {
    for (const [index, component] of components.entries()) {
      currentPath = path.join(currentPath, component);
      const componentStat = await lstat(currentPath);
      const isFile = index === components.length - 1;
      if (
        componentStat.isSymbolicLink() ||
        (isFile ? !componentStat.isFile() : !componentStat.isDirectory())
      ) {
        throw new VersionAwareLauncherError(failureCode);
      }
      if (isFile) fileStat = componentStat;
    }
    canonical = await realpath(filePath);
  } catch {
    throw new VersionAwareLauncherError(failureCode);
  }
  if (
    fileStat === undefined ||
    fileStat.size < 1 ||
    fileStat.size > maxBytes ||
    !isWithin(bundlePath, canonical) ||
    path.resolve(filePath) !== canonical
  ) {
    throw new VersionAwareLauncherError(failureCode);
  }
  try {
    return await readFile(canonical);
  } catch {
    throw new VersionAwareLauncherError(failureCode);
  }
}

function parseBundleMetadata(bytes: Uint8Array): BundleMetadata {
  let dictionary: Map<string, string>;
  try {
    dictionary =
      bytes.byteLength >= 8 && ascii(bytes, 0, 8) === "bplist00"
        ? parseBinaryPlistStrings(bytes)
        : parseXmlPlistStrings(bytes);
  } catch {
    throw new VersionAwareLauncherError("APPLICATION_METADATA_INVALID");
  }
  const bundleIdentifier = dictionary.get("CFBundleIdentifier");
  const version = dictionary.get("CFBundleShortVersionString");
  const bundleVersion = dictionary.get("CFBundleVersion");
  const executableName = dictionary.get("CFBundleExecutable");
  if (
    bundleIdentifier === undefined ||
    version === undefined ||
    bundleVersion === undefined ||
    executableName === undefined ||
    !isReleaseVersion(version) ||
    bundleVersion.length === 0 ||
    bundleVersion.length > 128 ||
    hasControlCharacters(bundleVersion) ||
    !isSafeBasename(executableName)
  ) {
    throw new VersionAwareLauncherError("APPLICATION_METADATA_INVALID");
  }
  return { bundleIdentifier, version, bundleVersion, executableName };
}

function parseXmlPlistStrings(bytes: Uint8Array): Map<string, string> {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const doctypes = [...source.matchAll(/<!DOCTYPE[^>]*>/gi)].map(
    ([doctype]) => doctype,
  );
  if (
    source.length > MAX_INFO_PLIST_BYTES ||
    /<!ENTITY|<!DOCTYPE[^>]*\[/i.test(source) ||
    doctypes.length > 1 ||
    (doctypes.length === 1 &&
      !/^<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "https?:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">$/i.test(
        doctypes[0] ?? "",
      )) ||
    !/<plist(?:\s|>)/.test(source) ||
    !/<\/plist>/.test(source)
  ) {
    throw new Error("invalid plist");
  }
  const values = new Map<string, string>();
  const keyValue = /<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g;
  for (const match of source.matchAll(keyValue)) {
    const key = decodeXmlText(match[1] ?? "");
    const value = decodeXmlText(match[2] ?? "");
    if (values.has(key)) throw new Error("duplicate plist key");
    values.set(key, value);
  }
  return values;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&(amp|quot|apos|lt|gt);/g, (_match, entity: string) => {
      switch (entity) {
        case "amp":
          return "&";
        case "quot":
          return '"';
        case "apos":
          return "'";
        case "lt":
          return "<";
        case "gt":
          return ">";
        default:
          throw new Error("invalid xml entity");
      }
    })
    .replace(/&[^;\s]+;/g, () => {
      throw new Error("unsupported xml entity");
    });
}

function parseBinaryPlistStrings(bytes: Uint8Array): Map<string, string> {
  const trailer = bytes.byteLength - 32;
  if (trailer < 8) throw new Error("invalid plist trailer");
  const offsetSize = bytes[trailer + 6] ?? 0;
  const referenceSize = bytes[trailer + 7] ?? 0;
  const objectCount = readSafeUnsigned(bytes, trailer + 8, 8);
  const topObject = readSafeUnsigned(bytes, trailer + 16, 8);
  const offsetTableOffset = readSafeUnsigned(bytes, trailer + 24, 8);
  if (
    offsetSize < 1 ||
    offsetSize > 8 ||
    referenceSize < 1 ||
    referenceSize > 8 ||
    objectCount < 1 ||
    objectCount > 100_000 ||
    topObject >= objectCount ||
    offsetTableOffset < 8 ||
    offsetTableOffset + objectCount * offsetSize > trailer
  ) {
    throw new Error("invalid plist trailer");
  }
  const offsets = Array.from({ length: objectCount }, (_, index) =>
    readSafeUnsigned(bytes, offsetTableOffset + index * offsetSize, offsetSize),
  );
  const objectOffset = (objectId: number): number => {
    const offset = offsets[objectId];
    if (offset === undefined || offset < 8 || offset >= offsetTableOffset) {
      throw new Error("invalid plist object offset");
    }
    return offset;
  };
  const topOffset = objectOffset(topObject);
  const topMarker = bytes[topOffset];
  if (topMarker === undefined || topMarker >> 4 !== 0xd) {
    throw new Error("plist top object is not a dictionary");
  }
  const { length: entryCount, dataOffset } = readObjectLength(
    bytes,
    topOffset,
    topMarker & 0x0f,
    offsetTableOffset,
  );
  if (entryCount > 20_000) throw new Error("plist dictionary is too large");
  const referenceBytes = entryCount * referenceSize * 2;
  if (dataOffset + referenceBytes > offsetTableOffset) {
    throw new Error("truncated plist dictionary");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < entryCount; index += 1) {
    const keyId = readSafeUnsigned(
      bytes,
      dataOffset + index * referenceSize,
      referenceSize,
    );
    const valueId = readSafeUnsigned(
      bytes,
      dataOffset + (entryCount + index) * referenceSize,
      referenceSize,
    );
    if (keyId >= objectCount || valueId >= objectCount) {
      throw new Error("invalid plist reference");
    }
    const key = readPlistString(bytes, objectOffset(keyId), offsetTableOffset);
    if (values.has(key)) throw new Error("duplicate plist key");
    if (
      key === "CFBundleIdentifier" ||
      key === "CFBundleShortVersionString" ||
      key === "CFBundleVersion" ||
      key === "CFBundleExecutable"
    ) {
      values.set(
        key,
        readPlistString(bytes, objectOffset(valueId), offsetTableOffset),
      );
    }
  }
  return values;
}

function readPlistString(
  bytes: Uint8Array,
  offset: number,
  objectTableOffset: number,
): string {
  const marker = bytes[offset];
  if (marker === undefined) throw new Error("missing plist string");
  const kind = marker >> 4;
  if (kind !== 5 && kind !== 6) throw new Error("plist value is not a string");
  const { length, dataOffset } = readObjectLength(
    bytes,
    offset,
    marker & 0x0f,
    objectTableOffset,
  );
  const byteLength = kind === 6 ? length * 2 : length;
  if (length > 4096 || dataOffset + byteLength > objectTableOffset) {
    throw new Error("invalid plist string length");
  }
  if (kind === 5) {
    const value = bytes.slice(dataOffset, dataOffset + byteLength);
    if (value.some((byte) => byte > 0x7f)) {
      throw new Error("invalid ascii plist string");
    }
    return String.fromCharCode(...value);
  }
  let value = "";
  for (let index = dataOffset; index < dataOffset + byteLength; index += 2) {
    const codeUnit = ((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0);
    value += String.fromCharCode(codeUnit);
  }
  if (hasUnpairedSurrogate(value))
    throw new Error("invalid plist utf16 string");
  return value;
}

function readObjectLength(
  bytes: Uint8Array,
  objectOffset: number,
  info: number,
  objectTableOffset: number,
): { readonly length: number; readonly dataOffset: number } {
  if (info < 0x0f) return { length: info, dataOffset: objectOffset + 1 };
  const marker = bytes[objectOffset + 1];
  if (marker === undefined || marker >> 4 !== 1) {
    throw new Error("invalid extended plist length");
  }
  const integerBytes = 1 << (marker & 0x0f);
  if (
    integerBytes < 1 ||
    integerBytes > 8 ||
    objectOffset + 2 + integerBytes > objectTableOffset
  ) {
    throw new Error("invalid extended plist length");
  }
  return {
    length: readSafeUnsigned(bytes, objectOffset + 2, integerBytes),
    dataOffset: objectOffset + 2 + integerBytes,
  };
}

function readSafeUnsigned(
  bytes: Uint8Array,
  offset: number,
  byteLength: number,
): number {
  if (
    byteLength < 1 ||
    byteLength > 8 ||
    offset < 0 ||
    offset + byteLength > bytes.byteLength
  ) {
    throw new Error("invalid plist integer");
  }
  let value = 0n;
  for (let index = offset; index < offset + byteLength; index += 1) {
    value = (value << 8n) | BigInt(bytes[index] ?? 0);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("plist integer is too large");
  }
  return Number(value);
}

function parseContentHashes(value: unknown): LauncherContentHashes {
  const record = asRecord(value);
  if (
    record === undefined ||
    !hasExactKeys(record, [
      "appArchiveSha256",
      "executableSha256",
      "infoPlistSha256",
    ]) ||
    typeof record.infoPlistSha256 !== "string" ||
    !SHA256_PATTERN.test(record.infoPlistSha256) ||
    typeof record.executableSha256 !== "string" ||
    !SHA256_PATTERN.test(record.executableSha256) ||
    typeof record.appArchiveSha256 !== "string" ||
    !SHA256_PATTERN.test(record.appArchiveSha256)
  ) {
    throw new VersionAwareLauncherError("COMPATIBILITY_POLICY_INVALID");
  }
  return {
    infoPlistSha256: record.infoPlistSha256,
    executableSha256: record.executableSha256,
    appArchiveSha256: record.appArchiveSha256,
  };
}

function parseSigningProvenance(value: unknown): LauncherSigningProvenance {
  const record = asRecord(value);
  if (
    record === undefined ||
    !hasExactKeys(record, ["evidenceRef", "kind", "teamIdentifier"]) ||
    record.kind !== "AD_HOC" ||
    record.teamIdentifier !== null ||
    typeof record.evidenceRef !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.evidenceRef)
  ) {
    throw new VersionAwareLauncherError("COMPATIBILITY_POLICY_INVALID");
  }
  return {
    kind: "AD_HOC",
    teamIdentifier: null,
    evidenceRef: record.evidenceRef,
  };
}

function parseReleaseProvenance(value: unknown): LauncherReleaseProvenance {
  const record = asRecord(value);
  if (
    record === undefined ||
    !hasExactKeys(record, [
      "asset",
      "assetSha256",
      "assetSizeBytes",
      "commit",
      "evidenceRefs",
      "repository",
      "tag",
      "trustBasis",
    ]) ||
    typeof record.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(record.repository) ||
    typeof record.tag !== "string" ||
    !/^v\d+\.\d+\.\d+$/.test(record.tag) ||
    typeof record.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(record.commit) ||
    typeof record.asset !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(record.asset) ||
    typeof record.assetSha256 !== "string" ||
    !SHA256_PATTERN.test(record.assetSha256) ||
    !Number.isSafeInteger(record.assetSizeBytes) ||
    (record.assetSizeBytes as number) < 1 ||
    record.trustBasis !==
      "GITHUB_RELEASE_ACCOUNT_PLUS_EXACT_PUBLISHED_DIGEST" ||
    !Array.isArray(record.evidenceRefs) ||
    record.evidenceRefs.length === 0 ||
    record.evidenceRefs.some(
      (reference) =>
        typeof reference !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(reference),
    )
  ) {
    throw new VersionAwareLauncherError("COMPATIBILITY_POLICY_INVALID");
  }
  return {
    repository: record.repository,
    tag: record.tag,
    commit: record.commit,
    asset: record.asset,
    assetSha256: record.assetSha256,
    assetSizeBytes: record.assetSizeBytes as number,
    trustBasis: "GITHUB_RELEASE_ACCOUNT_PLUS_EXACT_PUBLISHED_DIGEST",
    evidenceRefs: record.evidenceRefs as string[],
  };
}

function sameContentHashes(
  left: LauncherContentHashes,
  right: LauncherContentHashes,
): boolean {
  return (
    left.infoPlistSha256 === right.infoPlistSha256 &&
    left.executableSha256 === right.executableSha256 &&
    left.appArchiveSha256 === right.appArchiveSha256
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isReleaseVersion(value: string): boolean {
  return RELEASE_VERSION_PATTERN.test(value);
}

function isSafeBasename(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    path.basename(value) === value &&
    value !== "." &&
    value !== ".." &&
    !hasControlCharacters(value)
  );
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charCodeAt(index);
    if (character <= 0x1f || character === 0x7f) return true;
  }
  return false;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isUtcTimestamp(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
