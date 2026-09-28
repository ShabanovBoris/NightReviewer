# NR-02 local bridge spike

This is a diagnostic client for the pinned upstream Responses route. It is deliberately outside `src/index.ts`: a function-call relay is being measured here, not added to NightReviewer’s production `ReviewerBackend` contract.

## Current live gate

Lead decision D3 (`NR-02-D3-ALLOW-ISOLATED-6_1_1-PRODUCTION-SPIKE`) approves a standard production-profile runtime from commit `a13cd09950969f43e3b7e25c71fa43efaf5446c5` / version `6.1.1`, isolated from DEV and shared production homes. After ordinary setup, the spike may set only `automaticAppName` and `appName` to the unique connector identity `Codex Native2 NR-02`; `manualAppName` stays pinned. The normal setup flow has no connector-name option and resets the production identity to `Codex Native2`, so the override must be revalidated through the pinned parser and runtime. This is a spike-specific config override, not an upstream-supported arbitrary-name setup flow.

Lead D3 requires a new Platform Tunnel, separate runtime key, unique ChatGPT connector named `Codex Native2 NR-02`, and a separate browser login if needed. The user authorized the D3 setup and separately authorized ordinary DEV for all NightReviewer development. Creating the unique connector remains subject to the pending action-time confirmation; do not submit that form until the user confirms. Use new `CODEX_CHATGPT_WEB_HOME`, `CODEX_HOME`, `CODEX_WEB_GPT_LAUNCHER_DATA_DIR`, and browser profile. Do not read/copy/reuse DEV or shared 6.1.2 homes, credentials, tunnel, connector, or permissions. Bind the Responses listener to loopback only. The current logged-in ChatGPT Plugins page lists `Codex Native2` and `Codex Native2 DEV`; it does not show the required unique NR-02 identity.

The existing DEV profile is `purpose=dev-harness`; pinned source intentionally rejects starting a Responses listener from it. ChatGPT settings show the existing `Codex Native2 DEV` connector with `Allow low-risk tools`; this is DEV-only setup and does not prove the bridge's production Responses contract.
The user later authorized ordinary DEV for all NightReviewer development, and lead confirmed that authorization. D4's technical limits remain: keep `purpose=dev-harness`, preserve the existing tunnel credentials, connector identity, and permissions, and label any DEV result as non-qualifying. The current local status reports the launcher running but `mcpRuntime.ready=false` / `state=starting`. DEV tunnel lifecycle is owned by the launcher supervisor; a standalone `tunnel restart` command is not applicable to this profile. The pinned `dev setup --full` attempt failed browser-host verification before setup saved the profile, created a chat, or sent a prompt. See public details in `docs/evidence/NR-02.json` and the private checkpoint. Do not treat these failures as model, bridge, cancellation, connector, or isolation results. Do not retry setup or `dev chat` until the launcher ChatGPT session can be verified.

Do not remove the DEV purpose flag, copy/reinterpret its profile, attach its tunnel to an undocumented listener, or use the shared `6.1.2` Launcher. The live commands below are qualifying probes and may run only after the D3 production profile, unique connector, and external-resource ownership are verified. The existing direct Temporary Chat probe did not call `read_fixture` and is not acceptance evidence.

## Contract fixture checks

`bun run verify` includes deterministic SSE fixtures for completed function calls, connector errors, incomplete responses, a truncated stream, and client cancellation. These are `CONTRACT` checks. They do not establish that a live connector works.

## Live three-context check

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

## Live unavailable-connector check

Lead decision D5 authorizes one bounded production LIVE probe using a temporary missing identity in the isolated D3 profile. It does not authorize creating, disabling, renaming, or changing permissions on any ChatGPT connector, or changing a tunnel, runtime key, browser profile, or credential. The unique `Codex Native2 NR-02` connector and a healthy exact-pin D3 profile are prerequisites; the action-time confirmation for creating that connector is still pending.

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

## Live cancellation check

After the supported exact-pin runtime and ChatGPT session are ready, set `BRIDGE_SPIKE_CONTROL_TOKEN` from that runtime’s private settings, then run:

```sh
export BRIDGE_SPIKE_CONTROL_TOKEN='<local exact-pin runtime control token>'
bun run bridge:cancel
```

This starts one synthetic read-only turn with fresh UUIDs, calls `/admin/interrupt-turn` with exactly that `threadId` and `turnId`, and requires HTTP `200` with JSON `status=ok` and `cancelled_http_turns=1`. It does not use the global cancel-all endpoint. Before interrupting, the harness confirms exactly one active HTTP turn and checks that its correlated stream has not already terminated.

Lead decision D6 (`NR-02-D6-ACK-PLUS-CORRELATED-STREAM-TERMINATION`) defines the qualification rule. The correlated Responses stream must terminate within 10 seconds of the successful exact-turn acknowledgement and must not produce `response.completed`. The control acknowledgement and actual stream disposition are recorded separately with the synthetic identity and timestamps for Responses start, interrupt request, acknowledgement, and termination. The parser preserves explicit `response.failed`, `response.incomplete`, clean EOF/incomplete, and read cancellation/error as distinct outcomes. Clean EOF/incomplete qualifies only with the exact successful acknowledgement; never manufacture a typed SSE cancellation from EOF or a read error. An explicit `response.failed` with client-cancellation semantics is stronger evidence but is optional.

The control call and post-interrupt observation are bounded. If the stream does not settle within 10 seconds, the harness aborts its local fetch only to release the client resource and reports a failed probe; local cleanup is never recorded as server-side cancellation evidence. D6 classifies the evidence only and does not authorize a live cancellation action. Run the probe only after the qualifying isolated D3 exact-pin `6.1.1` profile and its external-resource prerequisites are ready.

## Connector availability and permission scope

The isolated DEV tunnel is Healthy and `Codex Native2 DEV` is Connected with `Authentication=None` and `Allow low-risk tools`. This is MCP setup evidence only: it is not a Responses turn owner. A direct Temporary Chat probe reported that `read_fixture` lacked a turn-bound token; no actual callback or fixture read occurred. A direct inventory call through the currently connected `Codex Native2` tools also cannot run without a valid turn token; an empty-token request was rejected by schema validation before reaching the connector. Do not invent/reuse a token, broaden permissions, or reuse the DEV tunnel through an undocumented listener to make the spike pass.

OpenAI's [Secure MCP Tunnel documentation](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) says the tunnel client connects outbound, the private MCP server has no public ingress, and tunnel access follows Platform organization and ChatGPT workspace context. This describes the product security boundary; it is not a live anonymous-request test of the configured DEV tunnel or evidence that it owns a Responses turn.

The exact 6.1.1 DEV browser smoke passed after sign-in, but that does not prove this Responses route, MCP tool delivery, cancellation, or session isolation. The installed shared Launcher reports version `6.1.2` and is non-qualifying. The uncredentialed catalog attempt against it returned `upstream_server_error`. D3 allows a distinct isolated production-profile route, subject to separate resource and connector-identity prerequisites; D4 allows DEV diagnostics only. No credentials belong in repository files or chat messages.
