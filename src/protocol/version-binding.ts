import {
  CanonicalizationError,
  hashCanonicalJson,
  sha256Bytes,
} from "./canonical";
import type { ProtocolError, VersionHashBinding } from "./schemas";
import { JSON_SCHEMA_DRAFT_2020_12, RUNTIME_PROTOCOL_VERSION } from "./schemas";
import { validateProtocolValue } from "./validation";

const typeBoxSchemaKinds = new Set([
  "Array",
  "Boolean",
  "Integer",
  "Literal",
  "Null",
  "Number",
  "Object",
  "Record",
  "String",
  "Union",
]);

export interface VersionHashBindingInput {
  readonly schemaDocument: unknown;
  readonly promptVersion: string;
  readonly promptBytes: string | Uint8Array;
  readonly policyVersion: string;
  readonly policyDocument: unknown;
}

export type VersionHashBindingResult =
  | { readonly ok: true; readonly binding: VersionHashBinding }
  | { readonly ok: false; readonly error: ProtocolError };

export function createVersionHashBinding(
  input: VersionHashBindingInput,
  correlationId = "version-binding",
): VersionHashBindingResult {
  try {
    const jsonSchema = toJsonValue(
      input.schemaDocument,
      new Set<object>(),
      "$",
    );
    if (
      typeof jsonSchema !== "object" ||
      jsonSchema === null ||
      Array.isArray(jsonSchema) ||
      (jsonSchema as Record<string, unknown>).$schema !==
        JSON_SCHEMA_DRAFT_2020_12
    ) {
      return {
        ok: false,
        error: protocolError(
          "INVALID_ARGUMENT",
          "Schema binding requires a JSON Schema Draft 2020-12 document.",
          correlationId,
        ),
      };
    }

    const policyValidation = validateProtocolValue(
      "strictPolicy",
      input.policyDocument,
    );
    if (
      !policyValidation.ok ||
      policyValidation.value.policyVersion !== input.policyVersion
    ) {
      return {
        ok: false,
        error: protocolError(
          "INVALID_ARGUMENT",
          "Policy document does not match its declared strict policy version.",
          correlationId,
        ),
      };
    }

    const promptBytes =
      typeof input.promptBytes === "string"
        ? new TextEncoder().encode(input.promptBytes)
        : input.promptBytes;
    const candidate = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      schemaVersion: RUNTIME_PROTOCOL_VERSION,
      schemaHash: hashCanonicalJson(jsonSchema),
      promptVersion: input.promptVersion,
      promptHash: sha256Bytes(promptBytes),
      policyVersion: input.policyVersion,
      policyHash: hashCanonicalJson(policyValidation.value),
    };
    const validation = validateProtocolValue("versionHashBinding", candidate);
    return validation.ok
      ? { ok: true, binding: validation.value }
      : {
          ok: false,
          error: protocolError(
            "INVALID_ARGUMENT",
            "Version binding metadata is invalid.",
            correlationId,
          ),
        };
  } catch (error) {
    const message =
      error instanceof CanonicalizationError
        ? "Schema, prompt, or policy data is outside the supported canonical JSON data model."
        : "Version binding could not be computed.";
    return {
      ok: false,
      error: protocolError("INVALID_ARGUMENT", message, correlationId),
    };
  }
}

function toJsonValue(
  value: unknown,
  ancestors: Set<object>,
  path: string,
): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new CanonicalizationError(
        path,
        "number is outside the supported JSON domain",
      );
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new CanonicalizationError(path, "schema contains a non-JSON value");
  }
  if (ancestors.has(value)) {
    throw new CanonicalizationError(path, "schema contains a cyclic reference");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new CanonicalizationError(
          path,
          "schema arrays must be plain arrays",
        );
      }
      const output: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new CanonicalizationError(
            `${path}/${index}`,
            "schema arrays must be dense",
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          throw new CanonicalizationError(
            `${path}/${index}`,
            "schema accessors are not supported",
          );
        }
        output.push(
          toJsonValue(descriptor.value, ancestors, `${path}/${index}`),
        );
      }
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === "symbol") {
          throw new CanonicalizationError(
            path,
            "schema symbol keys are not supported",
          );
        }
        if (
          key !== "length" &&
          (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)
        ) {
          throw new CanonicalizationError(
            path,
            "schema arrays cannot have extra properties",
          );
        }
      }
      return output;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalizationError(
        path,
        "schema objects must be plain objects",
      );
    }
    const output: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") {
        throw new CanonicalizationError(
          path,
          "schema symbol keys are not supported",
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new CanonicalizationError(
          `${path}/${key}`,
          "schema accessors are not supported",
        );
      }
      if (!descriptor.enumerable) {
        if (
          key === "~kind" &&
          typeof descriptor.value === "string" &&
          typeBoxSchemaKinds.has(descriptor.value)
        ) {
          continue;
        }
        throw new CanonicalizationError(
          `${path}/${key}`,
          "schema non-enumerable properties are not supported",
        );
      }
      output[key] = toJsonValue(
        descriptor.value,
        ancestors,
        `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      );
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function protocolError(
  code: ProtocolError["code"],
  message: string,
  correlationId: string,
): ProtocolError {
  return { code, message, retryable: false, correlationId };
}
