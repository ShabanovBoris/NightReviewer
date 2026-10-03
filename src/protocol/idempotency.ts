import { CanonicalizationError, hashCanonicalJson } from "./canonical";
import type { IdempotencyBinding, ProtocolError } from "./schemas";
import { validateProtocolValue } from "./validation";

export type IdempotencyPreparation =
  | { readonly ok: true; readonly binding: IdempotencyBinding }
  | { readonly ok: false; readonly error: ProtocolError };

export type IdempotencyDecision =
  | { readonly kind: "NEW" }
  | { readonly kind: "REPLAY" }
  | { readonly kind: "CONFLICT"; readonly error: ProtocolError };

function protocolError(
  code: ProtocolError["code"],
  message: string,
  correlationId: string,
): ProtocolError {
  return { code, message, retryable: false, correlationId };
}

/** Hashes only the normalized payload; collection order remains semantically significant. */
export function createIdempotencyBinding(
  idempotencyKey: string,
  payload: unknown,
  correlationId = "idempotency",
): IdempotencyPreparation {
  let normalizedPayloadHash: string;
  try {
    normalizedPayloadHash = hashCanonicalJson(payload);
  } catch (error) {
    if (error instanceof CanonicalizationError) {
      return {
        ok: false,
        error: protocolError(
          "INVALID_ARGUMENT",
          "Idempotency payload is outside the supported JSON data model.",
          correlationId,
        ),
      };
    }
    return {
      ok: false,
      error: protocolError(
        "INVALID_ARGUMENT",
        "Idempotency payload could not be normalized.",
        correlationId,
      ),
    };
  }

  const validation = validateProtocolValue("idempotencyBinding", {
    idempotencyKey,
    normalizedPayloadHash,
  });
  if (!validation.ok) {
    return {
      ok: false,
      error: protocolError(
        "INVALID_ARGUMENT",
        "Idempotency key is invalid.",
        correlationId,
      ),
    };
  }
  return { ok: true, binding: validation.value };
}

export function compareIdempotencyBindings(
  existing: IdempotencyBinding | undefined,
  incoming: IdempotencyBinding,
  correlationId = "idempotency",
): IdempotencyDecision {
  if (
    existing === undefined ||
    existing.idempotencyKey !== incoming.idempotencyKey
  ) {
    return { kind: "NEW" };
  }
  if (existing.normalizedPayloadHash === incoming.normalizedPayloadHash) {
    return { kind: "REPLAY" };
  }
  return {
    kind: "CONFLICT",
    error: protocolError(
      "CONFLICT",
      "The idempotency key was already used with a different normalized payload.",
      correlationId,
    ),
  };
}
