export type SnapshotErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "REPOSITORY_UNAVAILABLE"
  | "REVISION_INVALID"
  | "ANCESTRY_VIOLATION"
  | "LIMIT_EXCEEDED"
  | "CONTENT_UNAVAILABLE"
  | "GIT_FAILED"
  | "CLOSED";

export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;

  constructor(code: SnapshotErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SnapshotError";
    this.code = code;
  }
}
