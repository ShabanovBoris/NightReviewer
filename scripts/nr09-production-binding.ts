import { execFileSync } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  CHATGPT_WEB_BRIDGE_PIN,
  type CredentialSourceRef,
} from "../src/backends/chatgpt-web";

export const NR09_PRODUCTION_BINDING_SCHEMA = "nr09-production-binding/1";
export const NR09_PRODUCTION_BINDING_RELATIVE_PATH = path.join(
  ".nightreviewer",
  "dev",
  "d52c4dc6-1aa6-4a14-b880-8b8f66f2bbd0",
  "profiles",
  "nr09-production-binding.json",
);

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PRODUCTION_BEARER_KEYCHAIN_SERVICE =
  "NightReviewer.NR09.ProductionBearer";
const MAX_KEYCHAIN_OUTPUT_BYTES = 4096;
const KEYCHAIN_COMMAND_TIMEOUT_MS = 30_000;
const MAX_PRODUCTION_BINDING_BYTES = 16 * 1024;

export class ProductionBindingError extends Error {
  constructor(readonly code: string) {
    super("NR-09 production binding stopped safely.");
    this.name = "ProductionBindingError";
  }
}

export interface ProductionBinding {
  readonly schemaVersion: typeof NR09_PRODUCTION_BINDING_SCHEMA;
  readonly credentialProfileId: string;
  readonly credentialSourceRef: CredentialSourceRef;
  readonly credentialBindingGeneration: number;
  readonly bridge: {
    readonly origin: string;
    readonly versionPin: typeof CHATGPT_WEB_BRIDGE_PIN.upstreamVersion;
  };
  readonly clientVersion: string;
  readonly clientVersionProvenance: {
    readonly kind: "active-codex-desktop-bundle";
    readonly bundleIdentifier: string;
    readonly applicationPath: string;
    readonly observedVersion: string;
    readonly observedAtUtc: string;
  };
  readonly model: typeof CHATGPT_WEB_BRIDGE_PIN.model;
  readonly reasoningEffort: typeof CHATGPT_WEB_BRIDGE_PIN.reasoningEffort;
  readonly createdAtUtc: string;
}

export interface ExpectedProductionBindingIdentity {
  readonly bridgeOrigin: string;
  readonly bridgeVersion: string;
  readonly clientVersion: string;
  readonly credentialProfileId: string;
  readonly credentialSourceRef: CredentialSourceRef;
  readonly credentialBindingGeneration: number;
  readonly model: string;
  readonly reasoningEffort: string;
}

export interface CredentialResolver {
  resolve(sourceRef: CredentialSourceRef): Promise<string>;
}

export interface CredentialCommandRunner {
  (
    command: string,
    args: readonly string[],
    options: {
      readonly encoding: "utf8";
      readonly env: NodeJS.ProcessEnv;
      readonly maxBuffer: number;
      readonly timeout: number;
    },
  ): string;
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

export function parseCredentialSourceRef(value: unknown): CredentialSourceRef {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["account", "provider", "service"]) ||
    value.provider !== "macos-keychain" ||
    typeof value.service !== "string" ||
    value.service !== PRODUCTION_BEARER_KEYCHAIN_SERVICE ||
    typeof value.account !== "string" ||
    !SAFE_IDENTIFIER.test(value.account)
  ) {
    throw new ProductionBindingError("PRODUCTION_BINDING_INVALID");
  }
  return {
    provider: "macos-keychain",
    service: value.service,
    account: value.account,
  };
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
      "bridge",
      "clientVersion",
      "clientVersionProvenance",
      "createdAtUtc",
      "credentialBindingGeneration",
      "credentialProfileId",
      "credentialSourceRef",
      "model",
      "reasoningEffort",
      "schemaVersion",
    ]) ||
    value.schemaVersion !== NR09_PRODUCTION_BINDING_SCHEMA ||
    typeof value.credentialProfileId !== "string" ||
    !SAFE_IDENTIFIER.test(value.credentialProfileId) ||
    !Number.isSafeInteger(value.credentialBindingGeneration) ||
    (value.credentialBindingGeneration as number) < 1 ||
    typeof value.clientVersion !== "string" ||
    !RELEASE_VERSION.test(value.clientVersion) ||
    value.model !== CHATGPT_WEB_BRIDGE_PIN.model ||
    value.reasoningEffort !== CHATGPT_WEB_BRIDGE_PIN.reasoningEffort ||
    !isUtcTimestamp(value.createdAtUtc)
  ) {
    throw new ProductionBindingError("PRODUCTION_BINDING_INVALID");
  }

  const credentialSourceRef = parseCredentialSourceRef(
    value.credentialSourceRef,
  );
  const bridge = parseBridge(value.bridge);
  const clientVersionProvenance = parseClientVersionProvenance(
    value.clientVersionProvenance,
    value.clientVersion,
  );
  if (credentialSourceRef.account !== value.credentialProfileId) {
    throw new ProductionBindingError("PRODUCTION_BINDING_INVALID");
  }

  return {
    schemaVersion: NR09_PRODUCTION_BINDING_SCHEMA,
    credentialProfileId: value.credentialProfileId,
    credentialSourceRef,
    credentialBindingGeneration: value.credentialBindingGeneration as number,
    bridge,
    clientVersion: value.clientVersion,
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
    binding.bridge.origin !== expected.bridgeOrigin ||
    binding.bridge.versionPin !== expected.bridgeVersion ||
    binding.clientVersion !== expected.clientVersion ||
    binding.credentialProfileId !== expected.credentialProfileId ||
    binding.credentialBindingGeneration !==
      expected.credentialBindingGeneration ||
    !sameCredentialSourceRef(
      binding.credentialSourceRef,
      expected.credentialSourceRef,
    ) ||
    binding.model !== expected.model ||
    binding.reasoningEffort !== expected.reasoningEffort
  ) {
    throw new ProductionBindingError("PHASE_B_BINDING_MISMATCH");
  }
}

export async function resolveBoundProductionCredential(
  binding: ProductionBinding | undefined,
  expected: ExpectedProductionBindingIdentity,
  resolver: CredentialResolver,
): Promise<string> {
  if (binding === undefined) {
    throw new ProductionBindingError("PRODUCTION_BINDING_MISSING");
  }
  assertProductionBindingMatches(binding, expected);
  let secret: string;
  try {
    secret = await resolver.resolve(binding.credentialSourceRef);
  } catch {
    throw new ProductionBindingError("CREDENTIAL_SOURCE_UNAVAILABLE");
  }
  if (secret.length === 0 || secret.trim().length === 0) {
    throw new ProductionBindingError("CREDENTIAL_SOURCE_EMPTY");
  }
  if (/\s/.test(secret)) {
    throw new ProductionBindingError("CREDENTIAL_SOURCE_INVALID");
  }
  return secret;
}

export function createMacOSKeychainCredentialResolver(
  options: {
    readonly runner?: CredentialCommandRunner;
    readonly platform?: string;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
): CredentialResolver {
  const runner = options.runner ?? runCredentialCommand;
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  return {
    async resolve(sourceRef) {
      if (platform !== "darwin") {
        throw new ProductionBindingError("CREDENTIAL_SOURCE_UNAVAILABLE");
      }
      const validatedRef = parseCredentialSourceRef(sourceRef);
      let output: string;
      try {
        output = runner(
          "/usr/bin/security",
          [
            "find-generic-password",
            "-s",
            validatedRef.service,
            "-a",
            validatedRef.account,
            "-w",
          ],
          {
            encoding: "utf8",
            env: createAllowlistedChildProcessEnvironment(environment),
            maxBuffer: MAX_KEYCHAIN_OUTPUT_BYTES,
            timeout: KEYCHAIN_COMMAND_TIMEOUT_MS,
          },
        );
      } catch {
        throw new ProductionBindingError("CREDENTIAL_SOURCE_UNAVAILABLE");
      }
      const secret = output.replace(/\r?\n$/, "");
      if (secret.length === 0 || secret.trim().length === 0) {
        throw new ProductionBindingError("CREDENTIAL_SOURCE_EMPTY");
      }
      if (/\s/.test(secret)) {
        throw new ProductionBindingError("CREDENTIAL_SOURCE_INVALID");
      }
      return secret;
    },
  };
}

function runCredentialCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly encoding: "utf8";
    readonly env: NodeJS.ProcessEnv;
    readonly maxBuffer: number;
    readonly timeout: number;
  },
): string {
  return execFileSync(command, [...args], options);
}

function parseBridge(value: unknown): ProductionBinding["bridge"] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["origin", "versionPin"]) ||
    typeof value.origin !== "string" ||
    value.versionPin !== CHATGPT_WEB_BRIDGE_PIN.upstreamVersion
  ) {
    throw new ProductionBindingError("PRODUCTION_BINDING_INVALID");
  }
  let url: URL;
  try {
    url = new URL(value.origin);
  } catch {
    throw new ProductionBindingError("PRODUCTION_BINDING_INVALID");
  }
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.pathname !== "/" ||
    url.search.length !== 0 ||
    url.hash.length !== 0 ||
    url.origin !== value.origin
  ) {
    throw new ProductionBindingError("PRODUCTION_BINDING_INVALID");
  }
  return {
    origin: value.origin,
    versionPin: CHATGPT_WEB_BRIDGE_PIN.upstreamVersion,
  };
}

function parseClientVersionProvenance(
  value: unknown,
  clientVersion: string,
): ProductionBinding["clientVersionProvenance"] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "applicationPath",
      "bundleIdentifier",
      "kind",
      "observedAtUtc",
      "observedVersion",
    ]) ||
    value.kind !== "active-codex-desktop-bundle" ||
    typeof value.bundleIdentifier !== "string" ||
    !SAFE_IDENTIFIER.test(value.bundleIdentifier) ||
    typeof value.applicationPath !== "string" ||
    !path.isAbsolute(value.applicationPath) ||
    hasControlCharacters(value.applicationPath) ||
    value.observedVersion !== clientVersion ||
    !isUtcTimestamp(value.observedAtUtc)
  ) {
    throw new ProductionBindingError("PRODUCTION_BINDING_INVALID");
  }
  return {
    kind: "active-codex-desktop-bundle",
    bundleIdentifier: value.bundleIdentifier,
    applicationPath: value.applicationPath,
    observedVersion: clientVersion,
    observedAtUtc: value.observedAtUtc,
  };
}

function sameCredentialSourceRef(
  left: CredentialSourceRef,
  right: CredentialSourceRef,
): boolean {
  return (
    left.provider === right.provider &&
    left.service === right.service &&
    left.account === right.account
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

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charCodeAt(index);
    if (character <= 0x1f || character === 0x7f) return true;
  }
  return false;
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
