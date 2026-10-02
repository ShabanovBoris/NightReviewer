import { expect, test } from "bun:test";
import { readBridgeSse } from "../src/spikes/bridge-sse";

/** Loads immutable transcript fixtures so tests exercise the same byte boundaries on every run. */
async function fixture(name: string): Promise<string> {
  return Bun.file(`tests/fixtures/bridge/${name}`).text();
}

/** Splits fixture bytes at arbitrary offsets to exercise stream parsing rather than whole-body JSON. */
function streamFromChunks(
  chunks: readonly string[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
  });
}

test("reassembles chunked SSE tool calls and preserves the completed response", async () => {
  const source = await fixture("completed.sse");
  const chunks = [
    source.slice(0, 47),
    source.slice(47, 201),
    source.slice(201),
  ];
  const outcome = await readBridgeSse(new Response(streamFromChunks(chunks)));

  expect(outcome).toEqual({
    kind: "completed",
    responseId: "resp_fixture",
    outputText: "fixture read complete",
    functionCalls: [
      {
        itemId: "fc_item",
        callId: "call_fixture",
        name: "read_fixture",
        arguments: '{"fixture":"probe"}',
      },
    ],
    events: [
      "response.created",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.output_item.done",
      "response.output_text.delta",
      "response.completed",
      "data:[DONE]",
    ],
  });
});

test("captures a bounded digest-bound trace without retaining output text", async () => {
  const privateOutput = "generated-canary-output-that-must-not-enter-the-trace";
  const source = [
    "event: response.created",
    'data: {"type":"response.created","response":{"id":"resp_trace"}}',
    "",
    "event: response.output_item.added",
    'data: {"type":"response.output_item.added","item":{"id":"fc_item","type":"function_call","call_id":"call_fixture","name":"read_fixture","arguments":""}}',
    "",
    "event: response.function_call_arguments.delta",
    'data: {"type":"response.function_call_arguments.delta","item_id":"fc_item","delta":"{\\"fixture\\":\\"probe\\"}"}',
    "",
    "event: response.output_item.done",
    'data: {"type":"response.output_item.done","item":{"id":"fc_item","type":"function_call","call_id":"call_fixture","name":"read_fixture","arguments":"{\\"fixture\\":\\"probe\\"}"}}',
    "",
    "event: response.output_text.delta",
    `data: {"type":"response.output_text.delta","delta":"${privateOutput}"}`,
    "",
    "event: response.completed",
    'data: {"type":"response.completed","response":{"id":"resp_trace","status":"completed"}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const outcome = await readBridgeSse(new Response(source), {
    captureSanitizedTrace: true,
  });
  const trace = outcome.sanitizedTrace;

  expect(outcome.kind).toBe("completed");
  expect(trace?.complete).toBe(true);
  expect(trace?.frames.map(({ event }) => event)).toContain(
    "response.function_call_arguments.delta",
  );
  expect(
    trace?.frames.find(({ event }) => event === "response.created"),
  ).toMatchObject({ responseId: "resp_trace" });
  expect(
    trace?.frames.find(({ event }) => event === "response.output_item.done"),
  ).toMatchObject({
    itemId: "fc_item",
    callId: "call_fixture",
    toolName: "read_fixture",
  });
  expect(
    trace?.frames.every(({ dataSha256 }) => /^[a-f0-9]{64}$/.test(dataSha256)),
  ).toBe(true);
  expect(JSON.stringify(trace)).not.toContain(privateOutput);
});

test("marks a sanitized trace incomplete when the frame budget is exceeded", async () => {
  const frames = Array.from(
    { length: 513 },
    () => 'event: response.heartbeat\ndata: {"type":"response.heartbeat"}',
  );
  const outcome = await readBridgeSse(new Response(frames.join("\n\n")), {
    captureSanitizedTrace: true,
  });

  expect(outcome.sanitizedTrace).toMatchObject({
    complete: false,
    observedFrames: 513,
  });
  expect(outcome.sanitizedTrace?.frames).toHaveLength(512);
});

test("preserves event names when CRLF is split across stream chunks", async () => {
  const source = [
    "event: response.created",
    'data: {"response":{"id":"resp_crlf"}}',
    "",
    "event: response.completed",
    'data: {"response":{"id":"resp_crlf","status":"completed"}}',
    "",
  ].join("\r\n");
  const split = source.indexOf("\r\n") + 1;
  const outcome = await readBridgeSse(
    new Response(
      streamFromChunks([source.slice(0, split), source.slice(split)]),
    ),
  );

  expect(outcome).toEqual({
    kind: "completed",
    responseId: "resp_crlf",
    outputText: "",
    functionCalls: [],
    events: ["response.created", "response.completed"],
  });
});

test("keeps connector failures typed instead of treating them as empty output", async () => {
  const outcome = await readBridgeSse(
    new Response(await fixture("failed.sse"), {
      headers: { "content-type": "text/event-stream" },
    }),
  );

  expect(outcome).toEqual({
    kind: "failed",
    status: 424,
    responseStatus: "failed",
    errorType: "connector_error",
    code: "connector_not_found",
    events: ["response.failed", "data:[DONE]"],
  });
});

test("preserves the 6.1.3 failed response shape without inventing a numeric status", async () => {
  const outcome = await readBridgeSse(
    new Response(
      [
        "event: response.failed",
        'data: {"type":"response.failed","response":{"status":"failed","error":{"type":"connector_error","code":"connector_not_found"}}}',
        "",
        "event: data:[DONE]",
        "data: [DONE]",
        "",
      ].join("\n"),
      { headers: { "content-type": "text/event-stream" } },
    ),
    { captureSanitizedTrace: true },
  );

  expect(outcome).toMatchObject({
    kind: "failed",
    status: null,
    responseStatus: "failed",
    errorType: "connector_error",
    code: "connector_not_found",
    sanitizedTrace: { complete: true },
  });
});

test("keeps an observed optional numeric failed-event status without using a fallback", async () => {
  const outcome = await readBridgeSse(
    new Response(
      'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"status":424,"type":"connector_error","code":"connector_not_found"}}}\n\n',
    ),
  );

  expect(outcome).toMatchObject({
    kind: "failed",
    status: 424,
    responseStatus: "failed",
    errorType: "connector_error",
    code: "connector_not_found",
  });
});

test("preserves partial completion as incomplete", async () => {
  const outcome = await readBridgeSse(
    new Response(await fixture("incomplete.sse")),
  );

  expect(outcome).toEqual({
    kind: "incomplete",
    responseId: "resp_partial",
    reason: "adapter_eof",
    events: ["response.incomplete", "data:[DONE]"],
  });
});

test("treats EOF without a terminal event as incomplete", async () => {
  const outcome = await readBridgeSse(
    new Response(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    ),
  );

  expect(outcome).toEqual({
    kind: "incomplete",
    reason: "stream_ended_without_terminal_event",
    events: ["response.output_text.delta"],
  });
});

test("preserves a response.completed event that follows an earlier terminal", async () => {
  const source = [
    "event: response.incomplete",
    'data: {"type":"response.incomplete","response":{"id":"resp_partial"}}',
    "",
    "event: response.completed",
    'data: {"type":"response.completed","response":{"id":"resp_completed","status":"completed"}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const outcome = await readBridgeSse(new Response(source));

  expect(outcome).toEqual({
    kind: "incomplete",
    responseId: "resp_partial",
    reason: "unspecified",
    events: ["response.incomplete", "response.completed", "data:[DONE]"],
  });
});

test("reports a terminal event before the response body closes", async () => {
  const encoder = new TextEncoder();
  let closeStream: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          [
            "event: response.incomplete",
            'data: {"type":"response.incomplete","response":{"id":"resp_active"}}',
            "",
            "",
          ].join("\n"),
        ),
      );
      closeStream = () => controller.close();
    },
  });
  let resolveTerminalEvent: (eventName: string) => void = () => undefined;
  const terminalEvent = new Promise<string>((resolve) => {
    resolveTerminalEvent = resolve;
  });
  const outcomePromise = readBridgeSse(new Response(body), {
    onTerminalEvent: resolveTerminalEvent,
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const eventName = await Promise.race([
      terminalEvent,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Terminal event callback was not called.")),
          1_000,
        );
      }),
    ]);
    expect(eventName).toBe("response.incomplete");
  } finally {
    if (timeout) clearTimeout(timeout);
    closeStream?.();
  }

  expect(await outcomePromise).toMatchObject({
    kind: "incomplete",
    responseId: "resp_active",
  });
});

test("does not expose a function call before the item-done event", async () => {
  const source = [
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"fc_partial","type":"function_call","call_id":"call_partial","name":"read_fixture","arguments":""}}',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_partial","delta":"{\\"fixture\\":\\"probe\\"}"}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_partial_call","status":"completed"}}',
  ].join("\n\n");
  const outcome = await readBridgeSse(new Response(source));

  expect(outcome).toEqual({
    kind: "failed",
    status: null,
    responseStatus: null,
    errorType: "bridge_protocol_error",
    code: "function_call_item_not_done",
    events: [
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.completed",
    ],
  });
});

test("classifies an aborted stream as cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.error(new DOMException("aborted", "AbortError"));
    },
  });

  expect(
    await readBridgeSse(new Response(body), { signal: controller.signal }),
  ).toEqual({
    kind: "cancelled",
    events: [],
  });
});

test("retains typed HTTP errors from a non-streaming response", async () => {
  const outcome = await readBridgeSse(
    Response.json(
      {
        error: { type: "connector_error", code: "connector_not_found" },
      },
      { status: 424 },
    ),
  );

  expect(outcome).toEqual({
    kind: "failed",
    status: 424,
    responseStatus: null,
    errorType: "connector_error",
    code: "connector_not_found",
    events: [],
  });
});
