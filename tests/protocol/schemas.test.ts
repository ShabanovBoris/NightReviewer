import { expect, test } from "bun:test";
import type { TSchema } from "typebox";
import Schema from "typebox/schema";
import {
  invalidProtocolExamples,
  type ProtocolSchemaName,
  protocolExampleSha1,
  protocolExampleSha256,
  protocolSchemas,
  validateProtocolValue,
  validProtocolExamples,
} from "../../src/protocol";

const schemaNames = Object.keys(protocolSchemas) as ProtocolSchemaName[];
const exportedValidators = Object.fromEntries(
  schemaNames.map((name) => {
    const jsonDocument = JSON.parse(
      JSON.stringify(protocolSchemas[name]),
    ) as TSchema;
    return [name, Schema.Compile(jsonDocument)];
  }),
) as Record<ProtocolSchemaName, ReturnType<typeof Schema.Compile>>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("valid protocol examples pass both production and serialized schema validators", () => {
  expect(Object.keys(validProtocolExamples).sort()).toEqual(
    [...schemaNames].sort(),
  );
  for (const name of schemaNames) {
    expect(validateProtocolValue(name, validProtocolExamples[name]).ok).toBe(
      true,
    );
    expect(exportedValidators[name].Check(validProtocolExamples[name])).toBe(
      true,
    );
    expect(
      (protocolSchemas[name] as unknown as Record<string, unknown>).$schema,
    ).toBe("https://json-schema.org/draft/2020-12/schema");
  }
});

test("invalid examples are rejected with a stable path and classification", () => {
  expect(Object.keys(invalidProtocolExamples).sort()).toEqual(
    [...schemaNames].sort(),
  );
  for (const name of schemaNames) {
    const result = validateProtocolValue(name, invalidProtocolExamples[name]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]?.path.length).toBeGreaterThan(0);
      expect(result.issues[0]?.classification.length).toBeGreaterThan(0);
    }
    expect(exportedValidators[name].Check(invalidProtocolExamples[name])).toBe(
      false,
    );
  }
});

test("finding evidence must be nonempty and enum values remain closed", () => {
  const noEvidence = clone(validProtocolExamples.canonicalFinding) as Record<
    string,
    unknown
  >;
  noEvidence.evidence = [];
  const noEvidenceResult = validateProtocolValue(
    "canonicalFinding",
    noEvidence,
  );
  expect(noEvidenceResult.ok).toBe(false);
  if (!noEvidenceResult.ok)
    expect(noEvidenceResult.issues[0]?.path).toBe("$/evidence");

  const unknownSeverity = clone(
    validProtocolExamples.canonicalFinding,
  ) as Record<string, unknown>;
  unknownSeverity.severity = "urgent";
  expect(validateProtocolValue("canonicalFinding", unknownSeverity).ok).toBe(
    false,
  );
});

test("candidate dispositions retain the canonical finding link when one exists", () => {
  const missingLink = {
    source: {
      runId: "run-1",
      attemptId: "attempt-1",
      localId: "finding-1",
      direction: "correctness",
    },
    disposition: "CANONICALIZED",
    reason: "The candidate was retained.",
  };
  expect(validateProtocolValue("candidateDisposition", missingLink).ok).toBe(
    false,
  );
});

test("worker output rejects unsupported versions, incomplete NO_FINDINGS and SHA format mismatch", () => {
  const unsupportedVersion = clone(
    validProtocolExamples.workerOutput,
  ) as Record<string, unknown>;
  unsupportedVersion.schemaVersion = "nr-review/2";
  expect(validateProtocolValue("workerOutput", unsupportedVersion).ok).toBe(
    false,
  );

  const incompleteNoFindings = clone(
    validProtocolExamples.workerOutput,
  ) as Record<string, unknown>;
  incompleteNoFindings.coverage = {
    complete: false,
    paths: [],
    limitations: ["not all paths were reviewed"],
  };
  expect(validateProtocolValue("workerOutput", incompleteNoFindings).ok).toBe(
    false,
  );

  const inconsistentSha = clone(validProtocolExamples.workerOutput) as Record<
    string,
    unknown
  >;
  inconsistentSha.objectFormat = "sha256";
  expect(validateProtocolValue("workerOutput", inconsistentSha).ok).toBe(false);
});

test("submit input rejects short and format-mismatched Git object IDs", () => {
  const shortSha = clone(validProtocolExamples.reviewSubmitInput) as Record<
    string,
    unknown
  >;
  shortSha.baseSha = protocolExampleSha1.slice(0, 7);
  expect(validateProtocolValue("reviewSubmitInput", shortSha).ok).toBe(false);

  const inconsistentFormat = clone(
    validProtocolExamples.reviewSubmitInput,
  ) as Record<string, unknown>;
  inconsistentFormat.objectFormat = "sha256";
  inconsistentFormat.baseSha = protocolExampleSha256;
  expect(
    validateProtocolValue("reviewSubmitInput", inconsistentFormat).ok,
  ).toBe(false);
});

test("serialized schema documents reject unknown authority-bearing fields", () => {
  for (const name of schemaNames) {
    expect(exportedValidators[name].Check(invalidProtocolExamples[name])).toBe(
      false,
    );
  }
});
