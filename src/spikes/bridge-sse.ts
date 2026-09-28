/** Carries the call identity needed to pair the host's function_call_output with the same request. */
export interface BridgeFunctionCall {
  readonly itemId: string;
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
}

/** Keeps terminal outcomes mutually exclusive so partial and failed turns cannot look successful. */
export type BridgeSseOutcome =
  | {
      readonly kind: "completed";
      readonly responseId?: string;
      readonly outputText: string;
      readonly functionCalls: readonly BridgeFunctionCall[];
      readonly events: readonly string[];
    }
  | {
      readonly kind: "incomplete";
      readonly responseId?: string;
      readonly reason: string;
      readonly events: readonly string[];
    }
  | {
      readonly kind: "failed";
      readonly status: number;
      readonly errorType: string;
      readonly code: string;
      readonly events: readonly string[];
    }
  | { readonly kind: "cancelled"; readonly events: readonly string[] };

/** Restricts terminal-time notifications to the Responses events that end a turn. */
export type BridgeSseTerminalEvent =
  | "response.completed"
  | "response.incomplete"
  | "response.failed";

/** Holds one event until its blank-line delimiter arrives, even when network chunks split fields. */
interface SseFrame {
  event?: string;
  readonly data: string[];
}

/** Accumulates one streamed function item before exposing its final call_id and arguments. */
interface FunctionCallState {
  itemId: string;
  callId?: string;
  name?: string;
  arguments: string;
  complete: boolean;
}

/** Keeps parsed event data untrusted until it has the object shape expected by the reducer. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Extracts optional protocol strings without coercing numbers or nested values. */
function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Keeps evidence to known Responses event names instead of retaining provider-controlled payloads. */
const observedResponseEvents = new Set([
  "response.created",
  "response.in_progress",
  "response.output_item.added",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.output_item.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.output_text.delta",
  "response.output_text.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.heartbeat",
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

/** Keeps the spike contract separate from production and exposes terminal timing to exact-turn probes. */
export async function readBridgeSse(
  response: Response,
  signal?: AbortSignal,
  onTerminalEvent?: (eventName: BridgeSseTerminalEvent) => void,
): Promise<BridgeSseOutcome> {
  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    const error = record(record(body)?.error);
    return {
      kind: "failed",
      status: response.status,
      errorType: stringField(error?.type) ?? "http_error",
      code: stringField(error?.code) ?? `http_${response.status}`,
      events: [],
    };
  }
  if (!response.body)
    return { kind: "incomplete", reason: "response_body_missing", events: [] };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const functionCalls = new Map<string, FunctionCallState>();
  let frame: SseFrame = { data: [] };
  let pending = "";
  let responseId: string | undefined;
  let outputText = "";
  let terminal: BridgeSseOutcome | undefined;
  const events = new Set<string>();
  // The control probe must distinguish a terminal SSE frame from later HTTP-owner cleanup.
  const notifyTerminalEvent = (eventName: string | undefined): void => {
    if (
      eventName === "response.completed" ||
      eventName === "response.incomplete" ||
      eventName === "response.failed"
    ) {
      onTerminalEvent?.(eventName);
    }
  };

  const dispatch = (): void => {
    const eventName = frame.event;
    if (frame.data.length === 0) {
      if (eventName && observedResponseEvents.has(eventName)) {
        events.add(eventName);
        notifyTerminalEvent(eventName);
        if (terminal) terminal = { ...terminal, events: [...events] };
      }
      frame = { data: [] };
      return;
    }
    const payload = frame.data.join("\n");
    frame = { data: [] };
    if (payload === "[DONE]") {
      events.add("data:[DONE]");
      if (terminal) terminal = { ...terminal, events: [...events] };
      return;
    }
    if (eventName && observedResponseEvents.has(eventName))
      events.add(eventName);
    notifyTerminalEvent(eventName);

    let body: Record<string, unknown> | undefined;
    try {
      body = record(JSON.parse(payload));
    } catch {
      if (terminal) {
        terminal = { ...terminal, events: [...events] };
        return;
      }
      terminal = {
        kind: "failed",
        status: 502,
        errorType: "bridge_protocol_error",
        code: "invalid_sse_json",
        events: [...events],
      };
      return;
    }
    if (!body) {
      if (terminal) terminal = { ...terminal, events: [...events] };
      return;
    }

    const type = stringField(body.type) ?? eventName;
    if (type && observedResponseEvents.has(type)) events.add(type);
    notifyTerminalEvent(type);
    if (terminal) {
      // ❌ Удален ранний выход после первого terminal event: D6 требует заметить поздний response.completed.
      terminal = { ...terminal, events: [...events] };
      return;
    }
    const responseBody = record(body.response);
    responseId ??= stringField(responseBody?.id);

    if (type === "response.output_text.delta") {
      const delta = body.delta;
      if (typeof delta === "string") outputText += delta;
      return;
    }

    if (
      type === "response.output_item.added" ||
      type === "response.output_item.done"
    ) {
      const item = record(body.item);
      if (item?.type !== "function_call") return;
      const itemId =
        stringField(item.id) ??
        `output_${String(body.output_index ?? "unknown")}`;
      const call = functionCalls.get(itemId) ?? {
        itemId,
        arguments: "",
        complete: false,
      };
      const callId = stringField(item.call_id);
      const name = stringField(item.name);
      if (callId) call.callId = callId;
      if (name) call.name = name;
      if (typeof item.arguments === "string") call.arguments = item.arguments;
      if (type === "response.output_item.done") call.complete = true;
      functionCalls.set(itemId, call);
      return;
    }

    if (type === "response.function_call_arguments.delta") {
      const itemId = stringField(body.item_id);
      const delta = body.delta;
      if (!itemId || typeof delta !== "string") return;
      const call = functionCalls.get(itemId) ?? {
        itemId,
        arguments: "",
        complete: false,
      };
      call.arguments += delta;
      functionCalls.set(itemId, call);
      return;
    }

    if (type === "response.completed") {
      const calls: BridgeFunctionCall[] = [];
      for (const call of functionCalls.values()) {
        if (!call.callId || !call.name || !call.complete) {
          terminal = {
            kind: "failed",
            status: 502,
            errorType: "bridge_protocol_error",
            code: call.complete
              ? "function_call_missing_identity"
              : "function_call_item_not_done",
            events: [...events],
          };
          return;
        }
        calls.push({
          itemId: call.itemId,
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
        });
      }
      terminal = {
        kind: "completed",
        ...(responseId ? { responseId } : {}),
        outputText,
        functionCalls: calls,
        events: [...events],
      };
      return;
    }

    if (type === "response.incomplete") {
      const details =
        record(responseBody?.incomplete_details) ??
        record(body.incomplete_details);
      terminal = {
        kind: "incomplete",
        ...(responseId ? { responseId } : {}),
        reason: stringField(details?.reason) ?? "unspecified",
        events: [...events],
      };
      return;
    }

    if (type === "response.failed") {
      const error = record(responseBody?.error) ?? record(body.error);
      terminal = {
        kind: "failed",
        status: typeof error?.status === "number" ? error.status : 502,
        errorType: stringField(error?.type) ?? "upstream_error",
        code: stringField(error?.code) ?? "response_failed",
        events: [...events],
      };
    }
  };

  const consumeLine = (line: string): void => {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const fieldName = colon < 0 ? line : line.slice(0, colon);
    let fieldValue = colon < 0 ? "" : line.slice(colon + 1);
    if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
    if (fieldName === "event") frame.event = fieldValue;
    else if (fieldName === "data") frame.data.push(fieldValue);
  };

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      let cursor = 0;
      for (let index = 0; index < pending.length; index += 1) {
        const character = pending[index];
        if (character !== "\r" && character !== "\n") continue;
        if (character === "\r" && index === pending.length - 1) break;
        consumeLine(pending.slice(cursor, index));
        if (character === "\r" && pending[index + 1] === "\n") index += 1;
        cursor = index + 1;
      }
      pending = pending.slice(cursor);
    }
    pending += decoder.decode();
    let cursor = 0;
    for (let index = 0; index < pending.length; index += 1) {
      const character = pending[index];
      if (character !== "\r" && character !== "\n") continue;
      consumeLine(pending.slice(cursor, index));
      if (character === "\r" && pending[index + 1] === "\n") index += 1;
      cursor = index + 1;
    }
    pending = pending.slice(cursor);
    if (pending) consumeLine(pending);
    dispatch();
  } catch (error) {
    if (signal?.aborted) return { kind: "cancelled", events: [...events] };
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (signal?.aborted) return { kind: "cancelled", events: [...events] };
  return terminal
    ? { ...terminal, events: [...events] }
    : {
        kind: "incomplete",
        ...(responseId ? { responseId } : {}),
        reason: "stream_ended_without_terminal_event",
        events: [...events],
      };
}
