/**
 * Names the D6 acknowledgement window as a pure check so its acceptance boundary can be
 * verified without a live bridge; request identity and actual stream disposition stay in the harness.
 */
export function isStreamTerminationWithinAcknowledgementWindow(
  acknowledgedAtMs: number | undefined,
  terminatedAtMs: number,
): boolean {
  if (acknowledgedAtMs === undefined) return false;
  const elapsedMs = terminatedAtMs - acknowledgedAtMs;
  return elapsedMs >= 0 && elapsedMs <= 10_000;
}
