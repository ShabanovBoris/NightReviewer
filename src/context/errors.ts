export type ReviewContextErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONTEXT_TOO_LARGE"
  | "BACKEND_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class ReviewContextError extends Error {
  readonly code: ReviewContextErrorCode;

  constructor(code: ReviewContextErrorCode, message: string) {
    super(message);
    this.name = "ReviewContextError";
    this.code = code;
  }
}
