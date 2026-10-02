import { expect, test } from "bun:test";
import { isStreamTerminationWithinAcknowledgementWindow } from "../src/spikes/cancellation-contract";

test("D6 window starts at the successful acknowledgement", () => {
  expect(isStreamTerminationWithinAcknowledgementWindow(5_000, 4_999)).toBe(
    false,
  );
  expect(isStreamTerminationWithinAcknowledgementWindow(5_000, 5_000)).toBe(
    true,
  );
});

test("D6 window includes termination at 10 seconds and rejects later reads", () => {
  expect(isStreamTerminationWithinAcknowledgementWindow(5_000, 15_000)).toBe(
    true,
  );
  expect(isStreamTerminationWithinAcknowledgementWindow(5_000, 15_001)).toBe(
    false,
  );
});

test("D6 window cannot pass without a successful acknowledgement timestamp", () => {
  expect(isStreamTerminationWithinAcknowledgementWindow(undefined, 5_000)).toBe(
    false,
  );
});
