import type { Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  CHATGPT_WEB_AUTH_MODE,
  CHATGPT_WEB_BRIDGE_ORIGIN,
  CHATGPT_WEB_BRIDGE_PIN,
  type ChatGptWebClientVersionProvenance,
  type ChatGptWebLauncherCompatibilityIdentity,
} from "../src/backends/chatgpt-web";
import {
  parseVersionAwareLauncherIdentity,
  toChatGptWebClientVersionProvenance,
  toChatGptWebLauncherCompatibilityIdentity,
  type VersionAwareLauncherIdentity,
} from "./nr09-version-aware-launcher";

export const NR09_PRODUCTION_BINDING_SCHEMA = "nr09-production-binding/3";
export const NR09_PRODUCTION_BINDING_RELATIVE_PATH = path.join(
  ".nightreviewer",
  "dev",
  "d52c4dc6-1aa6-4a14-b880-8b8f66f2bbd0",
  "profiles",
  "nr09-production-binding.json",
);

const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_PRODUCTION_BINDING_BYTES = 16 * 1024;

export class ProductionBindingError extends Error {
  constructor(readonly code: string) {
    super("NR-09 production binding stopped safely.");
    this.name = "ProductionBindingError";
  }
}

export interface ProductionBinding {
  readonly schemaVersion: typeof NR09_PRODUCTION_BINDING_SCHEMA;
  readonly authMode: typeof CHATGPT_WEB_AUTH_MODE;
  readonly bridge: {
    readonly origin: string;
    readonly versionPin: typeof CHATGPT_WEB_BRIDGE_PIN.upstreamVersion;
  };
  readonly clientVersion: string;
  readonly launcherIdentity: VersionAwareLauncherIdentity;
  readonly clientVersionProvenance: ChatGptWebClientVersionProvenance;
  readonly model: typeof CHATGPT_WEB_BRIDGE_PIN.model;
  readonly reasoningEffort: typeof CHATGPT_WEB_BRIDGE_PIN.reasoningEffort;
  readonly createdAtUtc: string;
}

export interface ExpectedProductionBindingIdentity {
  readonly authMode: typeof CHATGPT_WEB_AUTH_MODE;
  readonly bridgeOrigin: string;
  readonly bridgeVersion: string;
  readonly clientVersion: string;
  readonly clientVersionProvenance: ChatGptWebClientVersionProvenance;
  readonly launcherCompatibilityIdentity: ChatGptWebLauncherCompatibilityIdentity;
  readonly model: string;
  readonly reasoningEffort: string;
}

export function createAllowlistedChildProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
  };
  if (typeof source.HOME === "string" && source.HOME.length > 0) {
    environment.HOME = source.HOME;
  }
  return environment;
}

export function parseProductionBinding(rawText: string): ProductionBinding {
  let value: unknown;
  try {
    value = JSON.parse(rawText) as unknown;
  } catch {
    throw new ProductionBindingError("PRODUCTION_BINDING_INVALID");
  }
  if (!isRecord(value) || canonicalJson(value) + "\n" !== rawText) {
    throw new ProductionBindingError("PRODUCTION_BINDING_INVALID");
  }
  if (
    !hasExactKeys(value, [
      "authMode",
      "bridge",
      "clientVersion",
      "createdAtUtc",
      "launcherIdentity",
      "model",
      "reasoningEffort",
      "schemaVersion",
    ]) ||
    value.schemaVersion !== NR09_PRODUCTION_BINDING_SCHEMA ||
    value.authMode !== CHATGPT_WEB_AUTH_MODE ||
    typeof value.clientVersion !== "string" ||
    !RELEASE_VERSION.test(value.clientVersion) ||
    value.model !== CHATGPT_WEB_BRIDGE_PIN.model ||
    value.reasoningEffort !== CHATGPT_WEB_BRIDGE_PIN.reasoningEffort ||
    !isUtcTimestamp(value.createdAtUtc)
  ) {
    throw new ProductionBindingError("PRODUCTION_BINDING_INVALID");
  }

  const bridge = parseBridge(value.bridge);
  let launcherIdentity: VersionAwareLauncherIdentity;
  let clientVersionProvenance: ChatGptWebClientVersionProvenance;
  try {
    launcherIdentity = parseVersionAwareLauncherIdentity(
      value.launcherIdentity,
    );
    clientVersionProvenance =
      toChatGptWebClientVersionProvenance(launcherIdentity);
  } catch {
    throw new ProductionBindingError("PRODUCTION_BINDING_INVALID");
  }
  if (
    launcherIdentity.version !== value.clientVersion ||
    launcherIdentity.upstreamBridgeVersion !== bridge.versionPin
  ) {
    throw new ProductionBindingError("PRODUCTION_BINDING_INVALID");
  }

  return {
    schemaVersion: NR09_PRODUCTION_BINDING_SCHEMA,
    authMode: CHATGPT_WEB_AUTH_MODE,
    bridge,
    clientVersion: value.clientVersion,
    launcherIdentity,
    clientVersionProvenance,
    model: CHATGPT_WEB_BRIDGE_PIN.model,
    reasoningEffort: CHATGPT_WEB_BRIDGE_PIN.reasoningEffort,
    createdAtUtc: value.createdAtUtc,
  };
}

export async function readPrivateProductionBinding(
  bindingPath: string,
): Promise<ProductionBinding> {
  let directory: Stats;
  let file: Stats;
  try {
    directory = await lstat(path.dirname(bindingPath));
    file = await lstat(bindingPath);
  } catch {
    throw new ProductionBindingError("PRODUCTION_BINDING_MISSING");
  }
  const currentUid = process.getuid?.();
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o077) !== 0 ||
    (currentUid !== undefined && directory.uid !== currentUid) ||
    !file.isFile() ||
    file.isSymbolicLink() ||
    (file.mode & 0o077) !== 0 ||
    (currentUid !== undefined && file.uid !== currentUid)
  ) {
    throw new ProductionBindingError("PRODUCTION_BINDING_NOT_PRIVATE");
  }
  if (file.size > MAX_PRODUCTION_BINDING_BYTES) {
    throw new ProductionBindingError("PRODUCTION_BINDING_INVALID");
  }
  let rawText: string;
  try {
    rawText = await readFile(bindingPath, "utf8");
  } catch {
    throw new ProductionBindingError("PRODUCTION_BINDING_MISSING");
  }
  return parseProductionBinding(rawText);
}

export function assertProductionBindingMatches(
  binding: ProductionBinding,
  expected: ExpectedProductionBindingIdentity,
): void {
  if (
    binding.authMode !== expected.authMode ||
    binding.bridge.origin !== expected.bridgeOrigin ||
    binding.bridge.versionPin !== expected.bridgeVersion ||
    binding.clientVersion !== expected.clientVersion ||
    !sameClientVersionProvenance(
      binding.clientVersionProvenance,
      expected.clientVersionProvenance,
    ) ||
    !sameLauncherCompatibilityIdentity(
      toChatGptWebLauncherCompatibilityIdentity(binding.launcherIdentity),
      expected.launcherCompatibilityIdentity,
    ) ||
    binding.model !== expected.model ||
    binding.reasoningEffort !== expected.reasoningEffort
  ) {
    throw new ProductionBindingError("PHASE_B_BINDING_MISMATCH");
  }
}

function parseBridge(value: unknown): ProductionBinding["bridge"] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["origin", "versionPin"]) ||
    value.origin !== CHATGPT_WEB_BRIDGE_ORIGIN ||
    value.versionPin !== CHATGPT_WEB_BRIDGE_PIN.upstreamVersion
  ) {
    throw new ProductionBindingError("PRODUCTION_BINDING_INVALID");
  }
  return {
    origin: CHATGPT_WEB_BRIDGE_ORIGIN,
    versionPin: CHATGPT_WEB_BRIDGE_PIN.upstreamVersion,
  };
}

function sameClientVersionProvenance(
  left: ChatGptWebClientVersionProvenance,
  right: ChatGptWebClientVersionProvenance,
): boolean {
  return (
    left.kind === right.kind &&
    left.bundleIdentifier === right.bundleIdentifier &&
    left.applicationPath === right.applicationPath &&
    left.observedVersion === right.observedVersion
  );
}

function sameLauncherCompatibilityIdentity(
  left: ChatGptWebLauncherCompatibilityIdentity,
  right: ChatGptWebLauncherCompatibilityIdentity,
): boolean {
  return (
    left.policyId === right.policyId &&
    left.policySha256 === right.policySha256 &&
    left.launcherIdentitySha256 === right.launcherIdentitySha256 &&
    left.infoPlistSha256 === right.infoPlistSha256 &&
    left.executableSha256 === right.executableSha256 &&
    left.appArchiveSha256 === right.appArchiveSha256
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return (
    Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value
  );
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
