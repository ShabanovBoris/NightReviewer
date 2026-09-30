# NR-02 local bridge spike

This diagnostic client remains outside `src/index.ts`: its function-call relay is not NightReviewer’s production `ReviewerBackend`.

## Current cycle 2 route — D41

Lead D40 selects the already-running Codex Web GPT `6.1.3` production baseline and existing production tunnel. D41 source-checks that unchanged production `config.appName` selects **`Codex Native2`**. **`Codex Native2 NR-02` is auxiliary, stays unchanged, and is not used for this LIVE route.** No qualifying Responses/tool round-trip has been observed yet.

AC1 is `NOT_RUN`. AC2 is `PARTIALLY_AUTHORIZED` and `NOT_RUN`: one bounded cancellation may run after the D41 gates; unavailable-connector/tool remains `NOT_RUN` and must not run. AC3's former three-context matrix is `DEFERRED_HARDENING`. DEV is not the LIVE acceptance owner.

The runner now requires exact version `6.1.3` and explicit live modes. Phase A verification and exact-head GitHub CI must pass before the one read-only production preflight. Do not stop/restart/reconfigure production, tunnel, connector, credentials or DEV; do not create IDs/keys; do not run setup or external Verify. A one-shot approval prompt may be approved only for the currently authorized tool operation; a request for persistent permission or settings changes is a stop condition.

## Historical cycle 1 D3/D5/D6 runbook — preserved, superseded for current acceptance

Everything in this section before deterministic fixture checks records the former exact-6.1.1 D3 route and associated requirements. It is historical context; it is not the current D40/D41 route and must not be executed for cycle 2.


Lead decision D3 (`NR-02-D3-ALLOW-ISOLATED-6_1_1-PRODUCTION-SPIKE`) approves a standard production-profile runtime from commit `a13cd09950969f43e3b7e25c71fa43efaf5446c5` / version `6.1.1`, isolated from DEV and shared production homes. After ordinary setup, the spike may set only `automaticAppName` and `appName` to the unique connector identity `Codex Native2 NR-02`; `manualAppName` stays pinned. The normal setup flow has no connector-name option and resets the production identity to `Codex Native2`, so the override must be revalidated through the pinned parser and runtime. This is a spike-specific config override, not an upstream-supported arbitrary-name setup flow.

Lead D3 requires a new Platform Tunnel, separate runtime key, unique ChatGPT connector named `Codex Native2 NR-02`, and a separate browser login if needed. The user authorized the D3 setup and separately authorized ordinary DEV for all NightReviewer development. Creating the unique connector remains subject to the pending action-time confirmation; do not submit that form until the user confirms. Use new `CODEX_CHATGPT_WEB_HOME`, `CODEX_HOME`, `CODEX_WEB_GPT_LAUNCHER_DATA_DIR`, and browser profile. Do not read/copy/reuse DEV or shared 6.1.2 homes, credentials, tunnel, connector, or permissions. Bind the Responses listener to loopback only. The current logged-in ChatGPT Plugins page lists `Codex Native2` and `Codex Native2 DEV`; it does not show the required unique NR-02 identity.

The existing DEV profile is `purpose=dev-harness`; pinned source intentionally rejects starting a Responses listener from it. ChatGPT settings show the existing `Codex Native2 DEV` connector with `Allow low-risk tools`; this is DEV-only setup and does not prove the bridge's production Responses contract.
The user later authorized ordinary DEV for all NightReviewer development, and lead confirmed that authorization. D4's technical limits remain: keep `purpose=dev-harness`, preserve the existing tunnel credentials, connector identity, and permissions, and label any DEV result as non-qualifying. The current local status reports the launcher running but `mcpRuntime.ready=false` / `state=starting`. DEV tunnel lifecycle is owned by the launcher supervisor; a standalone `tunnel restart` command is not applicable to this profile. The pinned `dev setup --full` attempt failed browser-host verification before setup saved the profile, created a chat, or sent a prompt. See public details in `docs/evidence/NR-02.json` and the private checkpoint. Do not treat these failures as model, bridge, cancellation, connector, or isolation results. Do not retry setup or `dev chat` until the launcher ChatGPT session can be verified.

Do not remove the DEV purpose flag, copy/reinterpret its profile, attach its tunnel to an undocumented listener, or use the shared `6.1.2` Launcher. The live commands below are qualifying probes and may run only after the D3 production profile, unique connector, and external-resource ownership are verified. The existing direct Temporary Chat probe did not call `read_fixture` and is not acceptance evidence.

## Current D41 minimum-working commands

These commands are gated: run them only after Phase A is published and GitHub `verify` succeeds on its exact head. The preflight is read-only and may run once. It requires healthy exact `6.1.3`, full/accepting mode, zero active HTTP/browser turns both before and after authenticated model discovery, the selected model with `high` effort, stable PID/version, and production `config.appName=Codex Native2`.

```sh
bun run bridge:preflight
```

After successful preflight, `bridge:live` runs exactly one AC1 fresh context and emits a sanitized digest-bound receipt. It does not run the historical three-context matrix.

```sh
bun run bridge:live
```

Only if AC1 passes and the post-AC1 health is healthy and idle, the D41 assignment allows one synthetic cancellation through `--cancel-only`. The unavailable-connector command is not authorized and must not be run.

```sh
bun run bridge:cancel
```

The AC1 receipt includes generated turn identity, one canary, response/call IDs, argument digest, fixture key/byte length/SHA-256, sanitized SSE traces, final correlation, timestamps and `liveTrace` digest/size. It excludes fixture contents, model output and credentials. Cancellation control tokens remain process-local and never enter evidence. The runner fails closed on unexpected tool calls, malformed continuation, incomplete trace, wrong canary/digest, non-idle bridge or changed process identity.

## Contract fixture checks

bun run verify includes deterministic SSE fixtures for completed function calls, connector errors, incomplete responses, a truncated stream, and client cancellation. These are CONTRACT checks only; they do not establish that the 6.1.3 live connector, tool callback, cancellation path, or model catalog works.

## Historical cycle 1 three-context runbook — deferred by D40

The script requires a local loopback server that reports upstream version `6.1.1`, a catalog model slug that advertises `high` reasoning, a local API key, and the ChatGPT tunnel/browser setup. It fails closed before model traffic if the endpoint is not loopback, the version differs, the bridge is draining, or the model/effort is absent.

Set these variables in a local shell without putting credential values in command history or repository files:

```sh
export BRIDGE_SPIKE_BASE_URL='http://127.0.0.1:<isolated-bridge-port>'
export BRIDGE_SPIKE_API_KEY='<local bridge bearer key>'
export BRIDGE_SPIKE_MODEL='<slug from the live /v1/models catalog>'
```

Then run:

```sh
bun run bridge:live
```

The command reads `/healthz`, calls `GET /v1/models`, then makes two `POST /v1/responses` requests in each of three new `thread_id` contexts. The first request forces one `read_fixture` function call; the host accepts only the fixed `probe` key and returns the bytes from `spikes/bridge/fixtures/probe.txt`. The environment message declares that fixture directory as the only read-only workspace, and the tool schema has no path argument. The continuation uses the upstream `previous_response_id` and the original `call_id`. Each final JSON result must contain its own random canary and the fixture digest, and no other session's canary.

The fixture is synthetic and contains no user data. The script prints generated IDs, model/effort, call IDs, and hashes; it does not print the API key, fixture contents, or full model output. It makes no retries.
The isolation assertion scans the first response text and function-call arguments as well as the final structured output. This strengthens the canary check, but does not replace live receipts.

Each `three-fresh-contexts` session receipt includes wall-clock start/finish times and monotonic elapsed time for both Responses legs and the fixture read. Its `sanitizedSse` frame list preserves event order, known event names, bounded response/item/call identities, exact payload byte lengths, and SHA-256 digests of each SSE data field; it never stores delta text or function argument contents. Unknown event names are represented by a digest. The `liveTrace` object also records the fixed `read_fixture` call, fixture and tool-output digests, and the validated canary/result fields. `liveTraceSha256` binds the exact UTF-8 bytes of `JSON.stringify(liveTrace)`, and `liveTraceBytes` records their length. The per-leg trace is bounded to 512 frames and 1 MiB of raw frame/event-name bytes; an incomplete capture fails closed before a session receipt can report `pass`. Each session records how many neighboring canaries were checked and any IDs found; the aggregate receipt reports the total leak count.

## Historical D5 unavailable-connector check — superseded by D40/D41

Lead D5 described one production LIVE probe using a temporary missing identity in the isolated D3 profile. It is historical and is not the D41 method. D41 does not authorize changing `appName`, stopping any runtime, or running `--connector-unavailable-only`.

Follow this sequence exactly:

1. Start the isolated D3 profile with its normal `Codex Native2 NR-02` identity. Record `/healthz` showing service `codex-chatgpt-web`, version `6.1.1`, and `accepting_turns=true`; record that the configured identity is the unique NR-02 connector.
2. Save the isolated AppConfig bytes and SHA-256. Confirm the profile paths differ from DEV and shared production homes.
3. Stop only the isolated D3 supervisor. Select a unique, deliberately nonexistent connector identity that does not match `Codex Native2`, `Codex Native2 DEV`, `Codex Native2 NR-02`, or any other known connector.
4. Change only `appName` and `automaticAppName` in the isolated AppConfig to that same nonexistent identity. Leave `manualAppName`, tunnel configuration/ID, runtime-key path, browser paths, permissions, runtime command, and credentials unchanged.
5. Reload the config with the pinned parser and require successful validation. Start the runtime through its normal D3 supervisor and recheck exact version `6.1.1` and `accepting_turns=true`.
6. Run exactly one `bun run bridge:unavailable` probe through the local production Responses route. Qualifying evidence requires HTTP `424`, error type `connector_error`, and code `connector_not_found`. Assistant prose, timeout, generic 5xx, a simulated result, or a local fixture is not a qualifying outcome. The probe does not read the fixture after the typed error.
7. Stop the isolated runtime immediately. Restore `appName` and `automaticAppName` to `Codex Native2 NR-02` even if the probe fails. Validate the restored config with the pinned parser, restart through the D3 supervisor, and confirm exact-pin health and restored identity.
8. Record the pre-probe, temporary, and restored config digests plus a sanitized diff proving only those two identity fields changed. Preserve the actual typed response and successful restoration/health receipts. If restoration or health verification fails, stop all further live probes until the D3 profile is recovered.

This is a configuration-only failure injection inside the isolated D3 profile. Do not change any external connector permission to create the failure. The method is approved; its LIVE outcome remains NOT_RUN until the D3 prerequisites are available. NR-02-AC2 also requires a separate qualifying cancellation outcome.

For cleanup evidence, use only the isolated production-profile Launcher and quit it normally after all probes. Pinned source routes normal Quit through RuntimeSupervisor, which drains and stops its owned tunnel and daemon; server shutdown clears turn sessions and closes browser workers and brokers. Capture the actual stop result and confirm the isolated daemon/tunnel are stopped. This sequence is source-reviewed, not live-verified. Do not quit the shared Launcher.

## Historical D6 exact-6.1.1 cancellation runbook — superseded route

After the supported exact-pin runtime and ChatGPT session are ready, set `BRIDGE_SPIKE_CONTROL_TOKEN` from that runtime’s private settings, then run:

```sh
export BRIDGE_SPIKE_CONTROL_TOKEN='<local exact-pin runtime control token>'
bun run bridge:cancel
```

This starts one synthetic read-only turn with fresh UUIDs, calls `/admin/interrupt-turn` with exactly that `threadId` and `turnId`, and requires HTTP `200` with JSON `status=ok` and `cancelled_http_turns=1`. It does not use the global cancel-all endpoint. Before interrupting, the harness confirms exactly one active HTTP turn and checks that its correlated stream has not already terminated.

Lead decision D6 (`NR-02-D6-ACK-PLUS-CORRELATED-STREAM-TERMINATION`) defines the qualification rule. The correlated Responses stream must terminate within 10 seconds of the successful exact-turn acknowledgement and must not produce `response.completed`. The control acknowledgement and actual stream disposition are recorded separately with the synthetic identity and timestamps for Responses start, interrupt request, acknowledgement, and termination. The parser preserves explicit `response.failed`, `response.incomplete`, clean EOF/incomplete, and read cancellation/error as distinct outcomes. Clean EOF/incomplete qualifies only with the exact successful acknowledgement; never manufacture a typed SSE cancellation from EOF or a read error. An explicit `response.failed` with client-cancellation semantics is stronger evidence but is optional.

The control call and post-interrupt observation are bounded. If the stream does not settle within 10 seconds, the harness aborts its local fetch only to release the client resource and reports a failed probe; local cleanup is never recorded as server-side cancellation evidence. D6 originally classified evidence only. D41 separately authorizes at most one cancellation on current `6.1.3`, after Phase A, exact-head CI, successful preflight, and a passing AC1. Use the current D41 commands above, not the old D3 profile prerequisites.

## Historical cycle 1 connector setup observations

The isolated DEV tunnel is Healthy and `Codex Native2 DEV` is Connected with `Authentication=None` and `Allow low-risk tools`. This is MCP setup evidence only: it is not a Responses turn owner. A direct Temporary Chat probe reported that `read_fixture` lacked a turn-bound token; no actual callback or fixture read occurred. A direct inventory call through the currently connected `Codex Native2` tools also cannot run without a valid turn token; an empty-token request was rejected by schema validation before reaching the connector. Do not invent/reuse a token, broaden permissions, or reuse the DEV tunnel through an undocumented listener to make the spike pass.

OpenAI's [Secure MCP Tunnel documentation](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) says the tunnel client connects outbound, the private MCP server has no public ingress, and tunnel access follows Platform organization and ChatGPT workspace context. This describes the product security boundary; it is not a live anonymous-request test of the configured DEV tunnel or evidence that it owns a Responses turn.

The exact 6.1.1 DEV browser smoke passed after sign-in, but that does not prove this Responses route, MCP tool delivery, cancellation, or session isolation. The installed shared Launcher reports version `6.1.2` and is non-qualifying. The uncredentialed catalog attempt against it returned `upstream_server_error`. D3 allows a distinct isolated production-profile route, subject to separate resource and connector-identity prerequisites; D4 allows DEV diagnostics only. No credentials belong in repository files or chat messages.


## D41 execution sequence

Complete and publish the bounded runner/docs adaptation, then require successful GitHub `verify` on that exact PR head. Run the read-only preflight once. If it passes, run AC1 once through production-selected `Codex Native2`; if AC1 passes and health remains idle, run cancellation once. Do not run unavailable-connector mode or three contexts. Record actual LIVE results, refresh evidence and canonical reviewContext/bundleHash, then send Lead a `DECISION_REQUEST` with the remaining AC2 blocker. Request a fresh Reviewer verdict after AC2 is fully satisfied or Lead explicitly revises the gate. Merge still requires later Lead authorization.
