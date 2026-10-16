# ADR 0010: NR-09 direct loopback authentication boundary

**Status:** Accepted by Lead D162 for NR-09 cycle 2 offline remediation
**Date:** 2026-10-16
**Scope:** The direct NR-09 bridge route for pinned upstream `6.1.3`; no proxy mode or LIVE authorization.

## Authority

Lead decision `NR-09-D161-REVISE-DIRECT-BRIDGE-AUTH-BOUNDARY` identifies the pinned upstream contract. Lead decision `NR-09-D162-AUTHORIZE-DIRECT-LOOPBACK-CONTRACT-REMEDIATION` authorizes this implementation correction on PR #10. D162 authorizes offline code and verification only. It grants no runtime, network, credential, Keychain, connector, tunnel, reviewer, merge, or acceptance action.

## Evidence

The pinned source is `miuuyy/codex-chatgpt-web` commit `fa2d2c6c24926078b46eedb2186f69f2e8d548d7`, corresponding to release `6.1.3`:

- [`src/server.ts`](https://github.com/miuuyy/codex-chatgpt-web/blob/fa2d2c6c24926078b46eedb2186f69f2e8d548d7/src/server.ts) binds the direct listener to `127.0.0.1`. Its `controlAuthorized` guard is used by administrative routes; the direct `GET /v1/models` and `POST /v1/responses` dispatches do not validate an HTTP bearer token.
- [`src/config.ts`](https://github.com/miuuyy/codex-chatgpt-web/blob/fa2d2c6c24926078b46eedb2186f69f2e8d548d7/src/config.ts) generates the `controlToken` for those admin controls. It is not a Responses API credential.

## Decision

- The only implemented auth mode is `LOOPBACK_LOCAL`, with exact origin `http://127.0.0.1:17841`, upstream pin `6.1.3`, model `chatgpt-web/gpt-5.6-sol`, and reasoning effort `high`.
- The adapter omits `Authorization` on `/v1/models` and `/v1/responses`. No bearer, `controlToken`, credential profile, credential source, generation, or Keychain lookup authenticates this route.
- Private binding schema v2 requires `authMode`, exact bridge identity, client version and validated active-bundle provenance, model, effort, and evidence timestamp. Legacy credential-bearing v1 bindings, unknown auth modes, and unsupported origins fail closed.
- The backend configuration digest binds auth mode, origin, bridge version, client version and stable provenance fields, model, effort, capabilities, and limits. `createdAtUtc` and provenance observation time remain evidence metadata and are excluded from the digest.
- Runtime qualification must still bind the exact supervisor-owned runtime and current client provenance. This local route contract does not itself authorize a live request or establish runtime ownership.
- An authenticated proxy or tunnel would be a separate route and authentication contract with its own threat model, configuration identity, tests, and review.

## Consequences

The direct bridge relies on loopback binding plus trusted local process/profile ownership and exact runtime identity. Any process able to reach the same host listener may call its unauthenticated Responses route; the bearer header does not change that boundary. The implementation rejects other origins before fetch, keeps the child-process environment allowlisted, preserves private file permissions and symlink/ownership checks, and emits no secret material.

NR-09 acceptance remains AC1–AC4 unchanged. AC1 and AC4 LIVE evidence are still `NOT_RUN`; this ADR and offline tests do not satisfy them. Fresh reviewer authorization and a separate Lead LIVE decision are required before Phase B.
