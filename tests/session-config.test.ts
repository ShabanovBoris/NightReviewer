import { expect, test } from "bun:test";
import { parseSessionConfig } from "../src/config/session";

const sampleConfig: unknown = await Bun.file(
  "config/session.example.json",
).json();

test("accepts the documented sample session config", () => {
  const config = parseSessionConfig(sampleConfig);

  expect(config.protocolVersion).toBe("nr-dev/1");
  expect(config.runtimeConcurrency).toBe(3);
});

test("rejects two role URLs that resolve to the same conversation", () => {
  const config = parseSessionConfig(sampleConfig);

  expect(() =>
    parseSessionConfig({
      ...config,
      reviewerChatUrl: `${config.leadChatUrl}?view=other#different-fragment`,
    }),
  ).toThrow("must identify different conversations");
});

test("rejects non-HTTPS chat URLs without including their value in the error", () => {
  const config = parseSessionConfig(sampleConfig);
  const privateValue = "http://chatgpt.com/private-chat-token";
  let message = "";

  try {
    parseSessionConfig({ ...config, leadChatUrl: privateValue });
  } catch (error) {
    if (error instanceof Error) message = error.message;
  }

  expect(message).toContain("leadChatUrl");
  expect(message).not.toContain(privateValue);
});
