# NR-02 local bridge spike

This diagnostic client remains outside `src/index.ts`: its function-call relay is not NightReviewer’s production `ReviewerBackend`.

## Current acceptance status — D105

The D66 AC1 round-trip and D67 cancellation have qualifying immutable LIVE receipts; both remain `PASS_LIVE_PENDING_INDEPENDENT_REVIEW`. AC2 unavailable remains pending independent review of the D102 observable contract and frozen D100 evidence, so AC2 overall is `INCOMPLETE`. AC3 remains deferred hardening and AC4 remains documentation-only pending independent review. D105 authorizes status/evidence correction, publication, exact-head CI, and a conditional reviewer bootstrap/fix review. It authorizes no new LIVE or runtime action and no merge.

## Historical implementation context — D56 offline route remediation

The target runtime remains production Codex Web GPT `6.1.3` with unchanged connector `Codex Native2`, selected by production `config.appName`. D53's single authorized AC1 run sent `gpt-6.1-sol` and received HTTP 400 before any tool call. D55 proved that this unprefixed slug enters native Responses passthrough, so the browser adapter/connector cannot run on that route. D55 classified the source path as `NON_REQUEST_CONTRACT_400`; the downstream reason for HTTP 400 is unknown and is not attributed to the model route.

D56 assigns only offline remediation in PR #3. AC1 must use the exact supported route `chatgpt-web/gpt-5.6-sol` at `high` reasoning. Runtime version `6.1.3` and routed browser model `5.6-sol` are separate concepts. Reject any other model before the first fetch; require the exact catalog row with `high`; include the exact model/effort in sanitized evidence. Keep D52's durable host-capture and stage ledger unchanged. D56 allows commit/push to the existing branch, PR narrative update and exact-head CI. It prohibits production HTTP, connector calls, LIVE retry, AC2/AC3, DEV/runtime/tunnel/config/credential/permission changes, reviewer request and merge.

D52's `bridge:live` entry routes through `scripts/bridge-live-capture.ts`. Before it spawns the fixed Bun 1.4.2 AC1 child, the wrapper checks the clean `nr-02-chatgpt-web-spike` branch and an exact match with `BRIDGE_SPIKE_EXPECTED_PR_HEAD_SHA`, then creates and flushes private `0700/0600` run storage. It captures every stdout/stderr byte privately under ignored `.nightreviewer/`, validates the ordered stage ledger and terminal outcome, and emits only exact UTC start/finish, head, exit code/signal, classification, safe stage metadata, byte counts and hashes. Missing or malformed ledger data fails closed. A storage error prevents child spawn.

The runner records each `_attempted` event synchronously before a network side effect, then separately records response receipt, stream end, tool observation, fixture preparation, final correlation and post-run health. Request attempt is not treated as a response receipt. Unknown transport outcomes remain `UNKNOWN`; no prompt, key, cookie, model free text, fixture contents or raw tool output enters the sanitized receipt. The settings and catalog evidence now also bind the exact D56 routed slug and effort.

D56 verification used fake fetch/injected boundaries only: reject native/unsupported slugs before fetch, accept the exact model, validate catalog effort, check simulated request shape and stage metadata, and assert zero real fetch/connector calls. Those offline checks did not satisfy AC1; the later D66 LIVE receipt is pending independent review. D105 supersedes D56's next-step instructions: complete the status/evidence correction, verify exact-head CI, then use the conditionally authorized reviewer bootstrap and fix review. No new LIVE attempt is authorized.

### Historical D42/D43 route correction

D42's one replacement preflight passed initial `/healthz`, then authenticated `/v1/models` returned non-2xx with no retained exact status; the second health and `/v1/responses` were not reached. D43 found the missing explicit release-only `client_version` as a plausible source mismatch, not a live-proven cause, and authorized offline correction, publication and exact-head CI. That D43 authorization and CI do not verify the later D52 head or override the D49–D52 hold.

## Historical cycle 1 D3/D5/D6 runbook — preserved, superseded for current acceptance

Everything in this section before deterministic fixture checks records the former exact-6.1.1 D3 route and associated requirements. It is historical context; it is not the current D40/D41 route and must not be executed for cycle 2.


Lead decision D3 (`NR-02-D3-ALLOW-ISOLATED-6_1_1-PRODUCTION-SPIKE`) approves a standard production-profile runtime from commit `a13cd09950969f43e3b7e25c71fa43efaf5446c5` / version `6.1.1`, isolated from DEV and shared production homes. After ordinary setup, the spike may set only `automaticAppName` and `appName` to the unique connector identity `Codex Native2 NR-02`; `manualAppName` stays pinned. The normal setup flow has no connector-name option and resets the production identity to `Codex Native2`, so the override must be revalidated through the pinned parser and runtime. This is a spike-specific config override, not an upstream-supported arbitrary-name setup flow.

Lead D3 requires a new Platform Tunnel, separate runtime key, unique ChatGPT connector named `Codex Native2 NR-02`, and a separate browser login if needed. The user authorized the D3 setup and separately authorized ordinary DEV for all NightReviewer development. Creating the unique connector remains subject to the pending action-time confirmation; do not submit that form until the user confirms. Use new `CODEX_CHATGPT_WEB_HOME`, `CODEX_HOME`, `CODEX_WEB_GPT_LAUNCHER_DATA_DIR`, and browser profile. Do not read/copy/reuse DEV or shared 6.1.2 homes, credentials, tunnel, connector, or permissions. Bind the Responses listener to loopback only. The current logged-in ChatGPT Plugins page lists `Codex Native2` and `Codex Native2 DEV`; it does not show the required unique NR-02 identity.

The existing DEV profile is `purpose=dev-harness`; pinned source intentionally rejects starting a Responses listener from it. ChatGPT settings show the existing `Codex Native2 DEV` connector with `Allow low-risk tools`; this is DEV-only setup and does not prove the bridge's production Responses contract.
The user later authorized ordinary DEV for all NightReviewer development, and lead confirmed that authorization. D4's technical limits remain: keep `purpose=dev-harness`, preserve the existing tunnel credentials, connector identity, and permissions, and label any DEV result as non-qualifying. The current local status reports the launcher running but `mcpRuntime.ready=false` / `state=starting`. DEV tunnel lifecycle is owned by the launcher supervisor; a standalone `tunnel restart` command is not applicable to this profile. The pinned `dev setup --full` attempt failed browser-host verification before setup saved the profile, created a chat, or sent a prompt. See public details in `docs/evidence/NR-02.json` and the private checkpoint. Do not treat these failures as model, bridge, cancellation, connector, or isolation results. Do not retry setup or `dev chat` until the launcher ChatGPT session can be verified.

Do not remove the DEV purpose flag, copy/reinterpret its profile, attach its tunnel to an undocumented listener, or use the shared `6.1.2` Launcher. The live commands below are qualifying probes and may run only after the D3 production profile, unique connector, and external-resource ownership are verified. The existing direct Temporary Chat probe did not call `read_fixture` and is not acceptance evidence.

## Commands — not authorized by D52; require a separate Lead authorization

If a later Lead decision explicitly authorizes another attempt, first resolve the release version from the active Codex app's embedded executable. The current local command reports `codex-cli 0.159.0`; submit only the version string, never any credential or token:

```sh
/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex --version
export BRIDGE_SPIKE_CLIENT_VERSION='<active release major.minor.patch>'
```

Then configure the already-authorized loopback bridge inputs without putting credential values in shell history. The preflight must confirm healthy exact `6.1.3`, full/accepting mode, zero active HTTP/browser turns both before and after authenticated model discovery, the selected model with `high` effort, stable PID/version, and production `config.appName=Codex Native2`.

```sh
bun run bridge:preflight
```

The following LIVE commands are examples of the D41 contract only. A successful preflight or CI does not authorize these commands under D52; run an action only if a current Lead decision explicitly authorizes it.

Only after a later Lead decision explicitly authorizes a bounded LIVE attempt, set `BRIDGE_SPIKE_EXPECTED_PR_HEAD_SHA` to the exact reviewed PR head. `bridge:live` starts the host capture wrapper, which enforces the clean branch/head/runtime guard before creating the AC1 child and never echoes its raw output. It does not run the historical three-context matrix.

```sh
bun run bridge:live
```

Only if AC1 passes and post-AC1 health is healthy and idle, and a current Lead decision explicitly authorizes cancellation, may one synthetic cancellation use `--cancel-only`. The unavailable-connector command is not currently authorized; D102 changes its offline acceptance contract but does not authorize another LIVE request.

```sh
bun run bridge:cancel
```

## D102 observable 6.1.3 unavailable-connector contract

The pinned 6.1.3 SSE contract is outer HTTP 200 `text/event-stream`, one complete terminal `response.failed`, wrapper `response.status="failed"`, `error.type="connector_error"`, and `error.code="connector_not_found"`. Numeric `error.status=424` may exist internally but is not serialized by this runtime; it is not an acceptance gate. An absent numeric field remains absent, and a local parser fallback such as `502` must not be reported as provider evidence. The runner retains exact pre/post health identity, complete-stream, and no-tool/no-continuation guards. D100 remains consumed with no acceptance credit pending independent review of the D102 contract and frozen evidence.

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

The control call and post-interrupt observation are bounded. If the stream does not settle within 10 seconds, the harness aborts its local fetch only to release the client resource and reports a failed probe; local cleanup is never recorded as server-side cancellation evidence. D6 originally classified evidence only. D41 later granted one conditional cancellation on current `6.1.3`, but D43 supersedes launch timing: successful publication or CI alone does not authorize LIVE work. Use only a current Lead decision for the next action.

## Historical cycle 1 connector setup observations

The isolated DEV tunnel is Healthy and `Codex Native2 DEV` is Connected with `Authentication=None` and `Allow low-risk tools`. This is MCP setup evidence only: it is not a Responses turn owner. A direct Temporary Chat probe reported that `read_fixture` lacked a turn-bound token; no actual callback or fixture read occurred. A direct inventory call through the currently connected `Codex Native2` tools also cannot run without a valid turn token; an empty-token request was rejected by schema validation before reaching the connector. Do not invent/reuse a token, broaden permissions, or reuse the DEV tunnel through an undocumented listener to make the spike pass.

OpenAI's [Secure MCP Tunnel documentation](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) says the tunnel client connects outbound, the private MCP server has no public ingress, and tunnel access follows Platform organization and ChatGPT workspace context. This describes the product security boundary; it is not a live anonymous-request test of the configured DEV tunnel or evidence that it owns a Responses turn.

The exact 6.1.1 DEV browser smoke passed after sign-in, but that does not prove this Responses route, MCP tool delivery, cancellation, or session isolation. The installed shared Launcher reports version `6.1.2` and is non-qualifying. The uncredentialed catalog attempt against it returned `upstream_server_error`. D3 allows a distinct isolated production-profile route, subject to separate resource and connector-identity prerequisites; D4 allows DEV diagnostics only. No credentials belong in repository files or chat messages.


## Historical D41 execution sequence — superseded by D42/D43

D41 originally required exact-head CI before one preflight, followed by gated AC1 and cancellation. D42 consumed its replacement preflight with an authenticated catalog failure; D43 supersedes that sequence and prohibits automatic retry after publication or CI. Do not use this historical sequence unless a future Lead decision explicitly authorizes the relevant next action.
