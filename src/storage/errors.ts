export type StorageErrorCode =
  | "INVALID_ARGUMENT"
  | "CONFLICT"
  | "NOT_FOUND"
  | "NEEDS_RECONCILIATION"
  | "UNSUPPORTED_SCHEMA"
  | "INVARIANT_VIOLATION"
  | "IO_ERROR";

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly retryable: boolean;

  constructor(
    code: StorageErrorCode,
    message: string,
    options: { cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "StorageError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export function conflict(message: string): StorageError {
  return new StorageError("CONFLICT", message);
}

export function invalidArgument(message: string): StorageError {
  return new StorageError("INVALID_ARGUMENT", message);
}

export function invariantViolation(message: string): StorageError {
  return new StorageError("INVARIANT_VIOLATION", message);
}

export function needsReconciliation(message: string): StorageError {
  return new StorageError("NEEDS_RECONCILIATION", message);
}
