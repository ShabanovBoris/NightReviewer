import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import type { ProtocolError } from "../protocol";
import { StorageError } from "../storage";
import type {
  DaemonRpcMethod,
  DaemonRpcRequest,
  DaemonRpcResponse,
} from "./types";
import {
  DAEMON_RPC_MAX_LINE_BYTES,
  DAEMON_RPC_PROTOCOL_VERSION,
} from "./types";

const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const RPC_TIMEOUT_MS = 5_000;

export class DaemonRpcError extends Error {
  constructor(readonly protocolError: ProtocolError) {
    super(protocolError.message);
    this.name = "DaemonRpcError";
  }
}

export interface RpcDispatchContext {
  readonly correlationId: string;
}

export type RpcDispatcher = (
  method: DaemonRpcMethod,
  params: unknown,
  context: RpcDispatchContext,
) => Promise<unknown>;

export interface RpcServerHandle {
  close(): Promise<void>;
  readonly server: Server;
}

export async function startRpcServer(
  socketPath: string,
  lifecycleToken: string,
  dispatch: RpcDispatcher,
): Promise<RpcServerHandle> {
  if (!TOKEN.test(lifecycleToken)) {
    throw new Error("Daemon lifecycle token has an invalid format.");
  }
  const server = createServer((socket) => {
    void serveConnection(socket, lifecycleToken, dispatch);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export async function callDaemonRpc(
  socketPath: string,
  lifecycleToken: string,
  method: DaemonRpcMethod,
  params?: unknown,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<unknown> {
  const correlationId = randomUUID();
  const request: DaemonRpcRequest = {
    protocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
    correlationId,
    lifecycleToken,
    method,
    ...(params === undefined ? {} : { params }),
  };
  const response = await exchange(socketPath, request, timeoutMs);
  if ("error" in response) throw new DaemonRpcError(response.error);
  return response.result;
}

async function serveConnection(
  socket: Socket,
  expectedToken: string,
  dispatch: RpcDispatcher,
): Promise<void> {
  let pending = Buffer.alloc(0);
  let complete = false;
  socket.setTimeout(RPC_TIMEOUT_MS, () => socket.destroy());
  socket.on("data", (chunk: Buffer) => {
    if (complete) return;
    pending = Buffer.concat([pending, chunk]);
    const newline = pending.indexOf(0x0a);
    if (newline < 0) {
      if (pending.byteLength > DAEMON_RPC_MAX_LINE_BYTES) {
        complete = true;
        sendFailure(
          socket,
          "INVALID_ARGUMENT",
          "RPC request exceeds the size limit.",
          randomUUID(),
        );
      }
      return;
    }
    complete = true;
    if (
      newline > DAEMON_RPC_MAX_LINE_BYTES ||
      pending.indexOf(0x0a, newline + 1) >= 0
    ) {
      sendFailure(
        socket,
        "INVALID_ARGUMENT",
        "RPC connection must contain one bounded request.",
        randomUUID(),
      );
      return;
    }
    void handleLine(
      socket,
      pending.subarray(0, newline),
      expectedToken,
      dispatch,
    );
  });
  socket.on("error", () => undefined);
}

async function handleLine(
  socket: Socket,
  line: Buffer,
  expectedToken: string,
  dispatch: RpcDispatcher,
): Promise<void> {
  const fallbackCorrelationId = randomUUID();
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch {
    sendFailure(
      socket,
      "INVALID_ARGUMENT",
      "RPC request is not valid JSON.",
      fallbackCorrelationId,
    );
    return;
  }
  if (!isRecord(value)) {
    sendFailure(
      socket,
      "AUTH_REQUIRED",
      "A valid lifecycle token is required.",
      fallbackCorrelationId,
    );
    return;
  }
  const request = value as Partial<DaemonRpcRequest>;
  const correlationId =
    typeof request.correlationId === "string" &&
    CORRELATION_ID.test(request.correlationId)
      ? request.correlationId
      : fallbackCorrelationId;
  if (!tokenMatches(request.lifecycleToken, expectedToken)) {
    sendFailure(
      socket,
      "AUTH_REQUIRED",
      "A valid lifecycle token is required.",
      correlationId,
    );
    return;
  }
  if (request.protocolVersion !== DAEMON_RPC_PROTOCOL_VERSION) {
    sendFailure(
      socket,
      "INVALID_ARGUMENT",
      "RPC protocol version is unsupported.",
      correlationId,
    );
    return;
  }
  if (
    typeof request.correlationId !== "string" ||
    !CORRELATION_ID.test(request.correlationId)
  ) {
    sendFailure(
      socket,
      "INVALID_ARGUMENT",
      "RPC correlationId is required.",
      correlationId,
    );
    return;
  }
  if (typeof request.method !== "string" || !isDaemonMethod(request.method)) {
    sendFailure(
      socket,
      "INVALID_ARGUMENT",
      "RPC method is unsupported.",
      correlationId,
    );
    return;
  }
  try {
    const result = await dispatch(request.method, request.params, {
      correlationId,
    });
    sendSuccess(socket, correlationId, result);
  } catch (error) {
    const protocolError =
      getProtocolError(error) ??
      (error instanceof StorageError
        ? storageProtocolError(error, correlationId)
        : safeInternalError(correlationId));
    sendFailure(
      socket,
      protocolError.code,
      protocolError.message,
      correlationId,
      protocolError,
    );
  }
}

function exchange(
  socketPath: string,
  request: DaemonRpcRequest,
  timeoutMs: number,
): Promise<DaemonRpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let data = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, response?: DaemonRpcResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error !== undefined) reject(error);
      else if (response !== undefined) resolve(response);
      else reject(new Error("Daemon returned an empty RPC response."));
    };
    const timer = setTimeout(
      () => finish(new Error("Daemon RPC timed out.")),
      timeoutMs,
    );
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.byteLength > DAEMON_RPC_MAX_LINE_BYTES) {
        finish(new Error("Daemon RPC response exceeds the size limit."));
        return;
      }
      const newline = data.indexOf(0x0a);
      if (newline < 0) return;
      try {
        const parsed: unknown = JSON.parse(
          data.subarray(0, newline).toString("utf8"),
        );
        if (!isRpcResponse(parsed, request.correlationId)) {
          throw new Error("Daemon returned a malformed RPC response.");
        }
        finish(undefined, parsed);
      } catch (error) {
        finish(
          error instanceof Error
            ? error
            : new Error("Daemon returned malformed JSON."),
        );
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      if (data.indexOf(0x0a) < 0)
        finish(new Error("Daemon closed before replying."));
    });
  });
}

function tokenMatches(candidate: unknown, expected: string): boolean {
  if (typeof candidate !== "string" || !TOKEN.test(candidate)) return false;
  const candidateBytes = Buffer.from(candidate, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  return (
    candidateBytes.length === 32 &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}

function sendSuccess(
  socket: Socket,
  correlationId: string,
  result: unknown,
): void {
  writeResponse(socket, {
    protocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
    correlationId,
    result,
  });
}

function sendFailure(
  socket: Socket,
  code: ProtocolError["code"],
  message: string,
  correlationId: string,
  error?: ProtocolError,
): void {
  writeResponse(socket, {
    protocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
    correlationId,
    error: error ?? {
      code,
      message,
      retryable: false,
      correlationId,
    },
  });
}

function writeResponse(socket: Socket, response: DaemonRpcResponse): void {
  if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
}

function safeInternalError(correlationId: string): ProtocolError {
  return {
    code: "INTERNAL_ERROR",
    message: "Daemon could not complete the request.",
    retryable: false,
    correlationId,
  };
}

function storageProtocolError(
  error: StorageError,
  correlationId: string,
): ProtocolError {
  switch (error.code) {
    case "INVALID_ARGUMENT":
      return {
        code: "INVALID_ARGUMENT",
        message: "Request failed storage validation.",
        retryable: false,
        correlationId,
      };
    case "CONFLICT":
      return {
        code: "CONFLICT",
        message: "Request conflicts with the current durable review state.",
        retryable: false,
        correlationId,
      };
    case "NOT_FOUND":
      return {
        code: "NOT_FOUND",
        message: "Review was not found.",
        retryable: false,
        correlationId,
      };
    case "NEEDS_RECONCILIATION":
      return {
        code: "NEEDS_RECONCILIATION",
        message: "Persisted review state requires reconciliation.",
        retryable: false,
        correlationId,
      };
    case "INVARIANT_VIOLATION":
      return {
        code: "NEEDS_RECONCILIATION",
        message: "Persisted review state requires reconciliation.",
        retryable: false,
        correlationId,
      };
    case "UNSUPPORTED_SCHEMA":
    case "IO_ERROR":
      return {
        code: "BACKEND_UNAVAILABLE",
        message: "Local daemon storage is unavailable.",
        retryable: error.retryable,
        correlationId,
      };
  }
}

function getProtocolError(error: unknown): ProtocolError | undefined {
  if (error instanceof DaemonRpcError) return error.protocolError;
  if (
    typeof error === "object" &&
    error !== null &&
    "protocolError" in error &&
    isProtocolError(error.protocolError)
  ) {
    return error.protocolError;
  }
  return isProtocolError(error) ? error : undefined;
}

function isProtocolError(value: unknown): value is ProtocolError {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean" &&
    typeof value.correlationId === "string"
  );
}

function isRpcResponse(
  value: unknown,
  correlationId: string,
): value is DaemonRpcResponse {
  return (
    isRecord(value) &&
    value.protocolVersion === DAEMON_RPC_PROTOCOL_VERSION &&
    value.correlationId === correlationId &&
    ("result" in value || isProtocolError(value.error))
  );
}

function isDaemonMethod(value: string): value is DaemonRpcMethod {
  return (
    value === "handshake" ||
    value === "review_submit" ||
    value === "review_status" ||
    value === "review_submit_fix" ||
    value === "review_cancel"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
