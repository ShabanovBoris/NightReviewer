import { Buffer } from "node:buffer";
import type { Readable, Writable } from "node:stream";
import type { DaemonRpcClient } from "../daemon/client";
import { DaemonRpcError } from "../daemon/rpc";
import { DAEMON_RPC_MAX_LINE_BYTES } from "../daemon/types";
import {
  protocolSchemas,
  type ReviewCancelInput,
  type ReviewStatusInput,
  type ReviewSubmitFixInput,
  type ReviewSubmitInput,
} from "../protocol";

const SERVER_NAME = "NightReviewer";
const SERVER_VERSION = "0.1.0";
const MCP_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);
type InitializationState = "NEW" | "NEGOTIATED" | "READY";

interface McpTool {
  readonly name:
    | "review_submit"
    | "review_status"
    | "review_submit_fix"
    | "review_cancel";
  readonly description: string;
  readonly inputSchema: unknown;
}

const tools: readonly McpTool[] = [
  {
    name: "review_submit",
    description: "Durably accept a review request and return its review ID.",
    inputSchema: protocolSchemas.reviewSubmitInput,
  },
  {
    name: "review_status",
    description:
      "Read durable review state, findings, coverage and paged events.",
    inputSchema: protocolSchemas.reviewStatusInput,
  },
  {
    name: "review_submit_fix",
    description: "Submit resolutions for a NEEDS_FIX review cycle.",
    inputSchema: protocolSchemas.reviewSubmitFixInput,
  },
  {
    name: "review_cancel",
    description: "Durably request and confirm cancellation of a review.",
    inputSchema: protocolSchemas.reviewCancelInput,
  },
];

export async function serveMcpStdio(
  daemon: DaemonRpcClient,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  let initializationState: InitializationState = "NEW";
  let parts: Buffer[] = [];
  let lineBytes = 0;
  let discarding = false;
  for await (const chunkValue of input) {
    const chunk = Buffer.isBuffer(chunkValue)
      ? chunkValue
      : Buffer.from(chunkValue);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      if (!discarding) {
        if (lineBytes + part.byteLength > DAEMON_RPC_MAX_LINE_BYTES) {
          discarding = true;
          parts = [];
          lineBytes = 0;
        } else if (part.byteLength > 0) {
          parts.push(part);
          lineBytes += part.byteLength;
        }
      }
      if (newline < 0) break;
      if (discarding) {
        writeJsonRpcError(
          output,
          null,
          -32600,
          "MCP request exceeds the size limit.",
        );
      } else {
        const line = Buffer.concat(parts, lineBytes);
        initializationState = await handleLine(
          line,
          daemon,
          output,
          initializationState,
        );
      }
      parts = [];
      lineBytes = 0;
      discarding = false;
      start = newline + 1;
    }
  }
  if (discarding) {
    writeJsonRpcError(
      output,
      null,
      -32600,
      "MCP request exceeds the size limit.",
    );
  } else if (lineBytes > 0) {
    initializationState = await handleLine(
      Buffer.concat(parts, lineBytes),
      daemon,
      output,
      initializationState,
    );
  }
}

async function handleLine(
  line: Buffer,
  daemon: DaemonRpcClient,
  output: Writable,
  initializationState: InitializationState,
): Promise<InitializationState> {
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch {
    writeJsonRpcError(output, null, -32700, "Parse error.");
    return initializationState;
  }
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    typeof value.method !== "string"
  ) {
    const invalidId =
      isRecord(value) && validRequestId(value.id) ? value.id : null;
    writeJsonRpcError(output, invalidId, -32600, "Invalid JSON-RPC request.");
    return initializationState;
  }
  const id = validRequestId(value.id) ? value.id : undefined;
  const isNotification = id === undefined;
  const params = isRecord(value.params) ? value.params : {};

  if (value.method === "notifications/initialized") {
    return initializationState === "NEGOTIATED" ? "READY" : initializationState;
  }
  if (value.method === "initialize") {
    if (isNotification) return initializationState;
    if (initializationState !== "NEW") {
      writeJsonRpcError(output, id, -32600, "Server is already initializing.");
      return initializationState;
    }
    const requestedVersion = params.protocolVersion;
    if (
      typeof requestedVersion !== "string" ||
      !MCP_PROTOCOL_VERSIONS.has(requestedVersion)
    ) {
      writeJsonRpcError(
        output,
        id,
        -32602,
        "Unsupported MCP protocol version.",
      );
      return initializationState;
    }
    writeJsonRpcResult(output, id, {
      protocolVersion: requestedVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return "NEGOTIATED";
  }
  if (value.method === "ping") {
    if (!isNotification) writeJsonRpcResult(output, id, {});
    return initializationState;
  }
  if (value.method === "tools/list") {
    if (isNotification) return initializationState;
    if (initializationState !== "READY") {
      writeJsonRpcError(output, id, -32002, "Server not initialized.");
      return initializationState;
    }
    writeJsonRpcResult(output, id, { tools });
    return initializationState;
  }
  if (value.method === "tools/call") {
    if (isNotification) return initializationState;
    if (initializationState !== "READY") {
      writeJsonRpcError(output, id, -32002, "Server not initialized.");
      return initializationState;
    }
    await handleToolCall(id, params, daemon, output);
    return initializationState;
  }
  if (isNotification) return initializationState;
  writeJsonRpcError(output, id, -32601, "Method not found.");
  return initializationState;
}

async function handleToolCall(
  id: number | string,
  params: Record<string, unknown>,
  daemon: DaemonRpcClient,
  output: Writable,
): Promise<void> {
  const name = params.name;
  const args = params.arguments ?? {};
  if (
    name !== "review_submit" &&
    name !== "review_status" &&
    name !== "review_submit_fix" &&
    name !== "review_cancel"
  ) {
    writeJsonRpcError(output, id, -32602, "Unknown tool name.");
    return;
  }
  try {
    let result: unknown;
    switch (name) {
      case "review_submit":
        result = await daemon.call(name, args as ReviewSubmitInput);
        break;
      case "review_status":
        result = await daemon.call(name, args as ReviewStatusInput);
        break;
      case "review_submit_fix":
        result = await daemon.call(name, args as ReviewSubmitFixInput);
        break;
      case "review_cancel":
        result = await daemon.call(name, args as ReviewCancelInput);
        break;
    }
    writeJsonRpcResult(output, id, {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    });
  } catch (error) {
    const protocolError =
      error instanceof DaemonRpcError
        ? error.protocolError
        : {
            code: "INTERNAL_ERROR",
            message: "Daemon could not complete the tool call.",
            retryable: false,
          };
    const content = JSON.stringify(protocolError);
    writeJsonRpcResult(output, id, {
      content: [{ type: "text", text: content }],
      structuredContent: { error: protocolError },
      isError: true,
    });
  }
}

function writeJsonRpcResult(
  output: Writable,
  id: number | string | undefined,
  result: unknown,
): void {
  if (id === undefined) return;
  output.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeJsonRpcError(
  output: Writable,
  id: number | string | null | undefined,
  code: number,
  message: string,
): void {
  output.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } })}\n`,
  );
}

function validRequestId(value: unknown): value is number | string {
  return (
    (typeof value === "string" && value.length > 0 && value.length <= 128) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
