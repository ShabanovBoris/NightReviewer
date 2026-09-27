export interface SessionConfig {
  readonly protocolVersion: "nr-dev/1";
  readonly repository: string;
  readonly targetBranch: string;
  readonly leadChatUrl: string;
  readonly reviewerChatUrl: string;
  readonly sessionId: string;
  readonly transport: "browser-or-manual-relay";
  readonly model: string;
  readonly reasoningEffort: string;
  readonly maxFixRoundsBeforeLead: number;
  readonly mergePolicy: "reviewer-approved-plus-lead-merge-authorized";
  readonly runtimeConcurrency: number;
}

/** Reads untrusted JSON fields without echoing their values, which may contain private chat links. */
function requireStringField(
  input: Record<string, unknown>,
  field: string,
): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

/** Compares normalized conversation paths so query or fragment changes cannot disguise one chat as two. */
function conversationIdentity(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute HTTPS URL.`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`${field} must be an absolute HTTPS URL.`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${field} must not embed credentials.`);
  }
  return `${url.origin}${url.pathname}`;
}

/** Keeps local session validation pure so setup tooling can reject unsafe role bindings before creating runtime state. */
export function parseSessionConfig(value: unknown): SessionConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Session config must be a JSON object.");
  }
  const input = value as Record<string, unknown>;

  const protocolVersion = input.protocolVersion;
  if (protocolVersion !== "nr-dev/1") {
    throw new Error("protocolVersion must be nr-dev/1.");
  }

  const repository = requireStringField(input, "repository");
  let repositoryUrl: URL;
  try {
    repositoryUrl = new URL(repository);
  } catch {
    throw new Error("repository must be an absolute HTTPS URL.");
  }
  if (repositoryUrl.protocol !== "https:") {
    throw new Error("repository must be an absolute HTTPS URL.");
  }

  const targetBranch = requireStringField(input, "targetBranch");
  const leadChatUrl = requireStringField(input, "leadChatUrl");
  const reviewerChatUrl = requireStringField(input, "reviewerChatUrl");
  const leadIdentity = conversationIdentity(leadChatUrl, "leadChatUrl");
  const reviewerIdentity = conversationIdentity(
    reviewerChatUrl,
    "reviewerChatUrl",
  );
  if (leadIdentity === reviewerIdentity) {
    throw new Error(
      "leadChatUrl and reviewerChatUrl must identify different conversations.",
    );
  }

  const sessionId = requireStringField(input, "sessionId");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      sessionId,
    )
  ) {
    throw new Error("sessionId must be a UUID v4.");
  }

  const transport = input.transport;
  if (transport !== "browser-or-manual-relay") {
    throw new Error("transport must be browser-or-manual-relay.");
  }

  const model = requireStringField(input, "model");
  const reasoningEffort = requireStringField(input, "reasoningEffort");
  const maxFixRoundsBeforeLead = input.maxFixRoundsBeforeLead;
  if (
    typeof maxFixRoundsBeforeLead !== "number" ||
    !Number.isSafeInteger(maxFixRoundsBeforeLead) ||
    maxFixRoundsBeforeLead < 1
  ) {
    throw new Error("maxFixRoundsBeforeLead must be a positive safe integer.");
  }

  const mergePolicy = input.mergePolicy;
  if (mergePolicy !== "reviewer-approved-plus-lead-merge-authorized") {
    throw new Error(
      "mergePolicy must require reviewer approval and lead merge authorization.",
    );
  }

  const runtimeConcurrency = input.runtimeConcurrency;
  if (
    typeof runtimeConcurrency !== "number" ||
    !Number.isSafeInteger(runtimeConcurrency) ||
    runtimeConcurrency < 1
  ) {
    throw new Error("runtimeConcurrency must be a positive safe integer.");
  }

  return {
    protocolVersion,
    repository,
    targetBranch,
    leadChatUrl,
    reviewerChatUrl,
    sessionId,
    transport,
    model,
    reasoningEffort,
    maxFixRoundsBeforeLead,
    mergePolicy,
    runtimeConcurrency,
  };
}
