import type { Static } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import Schema from "typebox/schema";
import type { ProtocolSchemaName, ProtocolValueBySchema } from "./schemas";
import { protocolSchemas, type ValidationIssueSchema } from "./schemas";

export type ProtocolValidationResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | {
      readonly ok: false;
      readonly issues: readonly ValidationIssue[];
    };

export type ValidationIssue = Static<typeof ValidationIssueSchema>;

const validators = {
  protocolError: Schema.Compile(protocolSchemas.protocolError),
  versionHashBinding: Schema.Compile(protocolSchemas.versionHashBinding),
  approvalEvidence: Schema.Compile(protocolSchemas.approvalEvidence),
  reviewSubmitInput: Schema.Compile(protocolSchemas.reviewSubmitInput),
  reviewSubmitResult: Schema.Compile(protocolSchemas.reviewSubmitResult),
  reviewStatusInput: Schema.Compile(protocolSchemas.reviewStatusInput),
  reviewStatusResult: Schema.Compile(protocolSchemas.reviewStatusResult),
  reviewSubmitFixInput: Schema.Compile(protocolSchemas.reviewSubmitFixInput),
  reviewSubmitFixResult: Schema.Compile(protocolSchemas.reviewSubmitFixResult),
  reviewCancelInput: Schema.Compile(protocolSchemas.reviewCancelInput),
  reviewCancelResult: Schema.Compile(protocolSchemas.reviewCancelResult),
  workerOutput: Schema.Compile(protocolSchemas.workerOutput),
  canonicalFinding: Schema.Compile(protocolSchemas.canonicalFinding),
  candidateDisposition: Schema.Compile(protocolSchemas.candidateDisposition),
  fixVerificationInput: Schema.Compile(protocolSchemas.fixVerificationInput),
  fixVerificationResult: Schema.Compile(protocolSchemas.fixVerificationResult),
  reviewCycleState: Schema.Compile(protocolSchemas.reviewCycleState),
  reviewTransitionCommand: Schema.Compile(
    protocolSchemas.reviewTransitionCommand,
  ),
  reviewTransitionResult: Schema.Compile(
    protocolSchemas.reviewTransitionResult,
  ),
  strictPolicy: Schema.Compile(protocolSchemas.strictPolicy),
  strictRuntimeConfig: Schema.Compile(protocolSchemas.strictRuntimeConfig),
  idempotencyBinding: Schema.Compile(protocolSchemas.idempotencyBinding),
} as const;

function classificationFor(error: TLocalizedValidationError): string {
  switch (error.keyword) {
    case "type":
      return "TYPE";
    case "required":
      return "REQUIRED";
    case "additionalProperties":
    case "unevaluatedProperties":
      return "UNKNOWN_PROPERTY";
    case "anyOf":
    case "oneOf":
      return "UNION";
    case "enum":
    case "const":
      return "ENUM";
    case "pattern":
      return "PATTERN";
    case "minimum":
    case "exclusiveMinimum":
      return "MINIMUM";
    case "maximum":
    case "exclusiveMaximum":
      return "MAXIMUM";
    case "minLength":
      return "MIN_LENGTH";
    case "maxLength":
      return "MAX_LENGTH";
    case "minItems":
      return "MIN_ITEMS";
    case "maxItems":
      return "MAX_ITEMS";
    case "uniqueItems":
      return "UNIQUE_ITEMS";
    default:
      return "SCHEMA_CONSTRAINT";
  }
}

function escapePointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function issuePath(error: TLocalizedValidationError): string {
  const prefix = error.instancePath === "" ? "$" : `$${error.instancePath}`;
  if (error.keyword === "required") {
    const property = error.params.requiredProperties[0];
    return property === undefined
      ? prefix
      : `${prefix}/${escapePointerSegment(property)}`;
  }
  if (error.keyword === "additionalProperties") {
    const property = error.params.additionalProperties[0];
    return property === undefined
      ? prefix
      : `${prefix}/${escapePointerSegment(property)}`;
  }
  if (error.keyword === "unevaluatedProperties") {
    const property = error.params.unevaluatedProperties[0];
    return property === undefined
      ? prefix
      : `${prefix}/${escapePointerSegment(String(property))}`;
  }
  return prefix;
}

function toIssue(error: TLocalizedValidationError): ValidationIssue {
  const classification = classificationFor(error);
  return {
    path: issuePath(error).slice(0, 2048),
    classification,
    message: `Value does not satisfy ${classification.toLowerCase()}.`,
  };
}

export function validateProtocolValue<Name extends ProtocolSchemaName>(
  name: Name,
  value: unknown,
): ProtocolValidationResult<ProtocolValueBySchema[Name]> {
  const [valid, errors] = validators[name].Errors(value);
  if (valid) {
    return {
      ok: true,
      value: value as ProtocolValueBySchema[Name],
    };
  }

  return {
    ok: false,
    issues:
      errors.length > 0
        ? errors.map(toIssue)
        : [
            {
              path: "$",
              classification: "SCHEMA_CONSTRAINT",
              message: "Value does not satisfy schema.",
            },
          ],
  };
}
