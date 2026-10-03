import { createHash } from "node:crypto";

export type ProtocolJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ProtocolJsonValue[]
  | { readonly [key: string]: ProtocolJsonValue };

export class CanonicalizationError extends TypeError {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Cannot canonicalize protocol JSON at ${path}: ${reason}.`);
    this.name = "CanonicalizationError";
    this.path = path;
  }
}

function assertUnicodeScalars(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalizationError(
          path,
          "string contains an unpaired surrogate",
        );
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new CanonicalizationError(
        path,
        "string contains an unpaired surrogate",
      );
    }
  }
}

function serialize(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertUnicodeScalars(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError(path, "number must be finite");
    }
    if (Object.is(value, -0)) {
      throw new CanonicalizationError(path, "negative zero is not supported");
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new CanonicalizationError(
        path,
        "integer is outside the safe range",
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined) {
    throw new CanonicalizationError(
      path,
      "value is outside the JSON data model",
    );
  }

  if (ancestors.has(value)) {
    throw new CanonicalizationError(
      path,
      "cyclic references are not supported",
    );
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      for (const key of ownKeys) {
        if (typeof key === "symbol") {
          throw new CanonicalizationError(
            path,
            "symbol keys are not supported",
          );
        }
        if (key === "length") continue;
        if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
          throw new CanonicalizationError(
            path,
            "arrays cannot have extra properties",
          );
        }
      }

      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new CanonicalizationError(
            `${path}/${index}`,
            "sparse arrays are not supported",
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
            "array accessors are not supported",
          );
        }
        entries.push(
          serialize(descriptor.value, `${path}/${index}`, ancestors),
        );
      }
      return `[${entries.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalizationError(path, "only plain objects are supported");
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new CanonicalizationError(path, "symbol keys are not supported");
    }
    const keys = ownKeys as string[];
    for (const key of keys) {
      assertUnicodeScalars(key, `${path}/<key>`);
      if ([...key].some((character) => character.charCodeAt(0) > 0x7e)) {
        throw new CanonicalizationError(
          path,
          "object keys must use ASCII characters",
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        throw new CanonicalizationError(
          `${path}/${escapeJsonPointer(key)}`,
          "non-enumerable properties and accessors are not supported",
        );
      }
    }

    keys.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${keys
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor)) {
          throw new CanonicalizationError(
            path,
            "object property is not a data value",
          );
        }
        return `${JSON.stringify(key)}:${serialize(
          descriptor.value,
          `${path}/${escapeJsonPointer(key)}`,
          ancestors,
        )}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function canonicalJson(value: unknown): string {
  return serialize(value, "$", new Set<object>());
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hashCanonicalJson(value: unknown): string {
  return sha256Bytes(canonicalJsonBytes(value));
}
