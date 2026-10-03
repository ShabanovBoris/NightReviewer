import { expect, test } from "bun:test";
import {
  CanonicalizationError,
  canonicalJson,
  compareIdempotencyBindings,
  createIdempotencyBinding,
  createVersionHashBinding,
  defaultStrictPolicy,
  hashCanonicalJson,
  protocolSchemas,
  sha256Bytes,
} from "../../src/protocol";

test("canonical JSON sorts object keys recursively and preserves array order", () => {
  const first = { z: [{ b: 2, a: 1 }], a: "value" };
  const second = { a: "value", z: [{ a: 1, b: 2 }] };

  expect(canonicalJson(first)).toBe('{"a":"value","z":[{"a":1,"b":2}]}');
  expect(hashCanonicalJson(first)).toBe(hashCanonicalJson(second));
  expect(hashCanonicalJson(["first", "second"])).not.toBe(
    hashCanonicalJson(["second", "first"]),
  );
  expect(hashCanonicalJson({ text: "é" })).not.toBe(
    hashCanonicalJson({ text: "e\u0301" }),
  );
});

test("canonical bytes are UTF-8 without BOM, whitespace or trailing newline", () => {
  const value = { text: "snowman ☃" };
  const bytes = new TextEncoder().encode(canonicalJson(value));
  expect(canonicalJson(value).endsWith("\n")).toBe(false);
  expect(Array.from(bytes.slice(0, 3))).not.toEqual([0xef, 0xbb, 0xbf]);
  expect(sha256Bytes(bytes)).toBe(hashCanonicalJson(value));
});

test("canonicalization rejects values outside the explicit JSON data model", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const sparse = new Array(1);
  const withAccessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get: () => 1,
  });
  const withSymbol = { [Symbol("secret")]: "value" };
  const nonAsciiKey = { clé: "value" };

  for (const value of [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -0,
    BigInt(1),
    Symbol("value"),
    new Date(0),
    cyclic,
    sparse,
    withAccessor,
    withSymbol,
    nonAsciiKey,
    Object.assign([], { extra: true }),
    Object.assign(Object.create({ inherited: true }), { own: true }),
  ]) {
    expect(() => canonicalJson(value)).toThrow(CanonicalizationError);
  }
});

test("same idempotency key replays only the same canonical payload", () => {
  const prepared = createIdempotencyBinding("request-1", { b: 2, a: 1 });
  const reordered = createIdempotencyBinding("request-1", { a: 1, b: 2 });
  const changed = createIdempotencyBinding("request-1", { a: 1, b: 3 });
  expect(prepared.ok && reordered.ok && changed.ok).toBe(true);
  if (!prepared.ok || !reordered.ok || !changed.ok) return;

  expect(
    compareIdempotencyBindings(prepared.binding, reordered.binding).kind,
  ).toBe("REPLAY");
  expect(
    compareIdempotencyBindings(prepared.binding, changed.binding).kind,
  ).toBe("CONFLICT");
  const orderSensitive = createIdempotencyBinding("request-2", [1, 2]);
  const reversed = createIdempotencyBinding("request-2", [2, 1]);
  expect(orderSensitive.ok && reversed.ok).toBe(true);
  if (orderSensitive.ok && reversed.ok) {
    expect(
      compareIdempotencyBindings(orderSensitive.binding, reversed.binding).kind,
    ).toBe("CONFLICT");
  }
});

test("schema, prompt and policy bytes are independently version and hash bound", () => {
  const input = {
    schemaDocument: protocolSchemas.reviewSubmitInput,
    promptVersion: "prompt/1",
    promptBytes: "review prompt bytes",
    policyVersion: "strict/1",
    policyDocument: defaultStrictPolicy,
  };
  const first = createVersionHashBinding(input);
  const reorderedSchema = createVersionHashBinding({
    ...input,
    schemaDocument: JSON.parse(JSON.stringify(input.schemaDocument)),
  });
  const changedSchema = createVersionHashBinding({
    ...input,
    schemaDocument: {
      ...input.schemaDocument,
      description: "changed bytes under the same schema version",
    },
  });
  const changedPrompt = createVersionHashBinding({
    ...input,
    promptBytes: "changed prompt bytes",
  });
  const changedPolicy = createVersionHashBinding({
    ...input,
    policyDocument: {
      ...defaultStrictPolicy,
      quotas: { ...defaultStrictPolicy.quotas, maxOpenReviews: 13 },
    },
  });

  expect(
    first.ok &&
      reorderedSchema.ok &&
      changedSchema.ok &&
      changedPrompt.ok &&
      changedPolicy.ok,
  ).toBe(true);
  if (
    !first.ok ||
    !reorderedSchema.ok ||
    !changedSchema.ok ||
    !changedPrompt.ok ||
    !changedPolicy.ok
  ) {
    return;
  }
  expect(first.binding.schemaHash).toBe(reorderedSchema.binding.schemaHash);
  expect(first.binding.schemaHash).not.toBe(changedSchema.binding.schemaHash);
  expect(first.binding.promptHash).not.toBe(changedPrompt.binding.promptHash);
  expect(first.binding.policyHash).not.toBe(changedPolicy.binding.policyHash);

  const unsupportedSchema = createVersionHashBinding({
    ...input,
    schemaDocument: {
      ...input.schemaDocument,
      $schema: "https://json-schema.org/draft/2019-09/schema",
    },
  });
  expect(unsupportedSchema.ok).toBe(false);

  const mismatchedPolicyVersion = createVersionHashBinding({
    ...input,
    policyVersion: "strict/2",
  });
  expect(mismatchedPolicyVersion.ok).toBe(false);

  let getterRead = false;
  const schemaWithGetter = Object.defineProperty(
    { $schema: "https://json-schema.org/draft/2020-12/schema" },
    "type",
    {
      enumerable: true,
      get: () => {
        getterRead = true;
        return "object";
      },
    },
  );
  const accessorSchema = createVersionHashBinding({
    ...input,
    schemaDocument: schemaWithGetter,
  });
  expect(accessorSchema.ok).toBe(false);
  expect(getterRead).toBe(false);

  const schemaWithUndefined = createVersionHashBinding({
    ...input,
    schemaDocument: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: undefined,
    },
  });
  expect(schemaWithUndefined.ok).toBe(false);
});
