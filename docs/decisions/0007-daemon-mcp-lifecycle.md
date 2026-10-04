# ADR 0007: Local daemon, RPC and MCP lifecycle

**Статус:** Accepted for NR-07 implementation by Lead D127
**Дата:** 2026-10-04
**Scope:** NR-07 only; worker scheduling remains NR-08.

## Контекст

NR-04 owns durable review state in SQLite, NR-05 creates immutable snapshots, and NR-06 supplies bounded read-only context. The implementer MCP process may exit at any time, so it cannot own review progress. Multiple daemon processes must not mutate one storage root concurrently. The existing NR-03 reducer and error vocabulary remain authoritative.

## Решение

### Ownership and fencing

One daemon owns a storage root through an NR-04 SQLite lease whose resource ID is derived from the canonical root. The daemon uses a 30-second lease and renews it every 10 seconds. A second daemon fails before it serves requests. Each daemon-originated review insertion, state transition, and snapshot commit validates the current root fencing token inside the corresponding SQLite transaction. If ownership is lost, the old daemon cannot mutate review state.

### Runtime files and local RPC

Runtime files live under `<storage-root>/runtime`, with directory mode `0700` on POSIX. The daemon binds only a Unix-domain socket at `runtime/s`, mode `0600`; TCP listeners are not implemented. A socket path longer than the supported local Unix socket limit is rejected.

Each ownership epoch gets a new 256-bit lifecycle token, atomically written to `runtime/lifecycle.token` with mode `0600`. The token is not passed through argv or environment variables and never appears in stdout or diagnostics. Every RPC request, including handshake, carries the token and a required correlation ID. Authentication completes before method dispatch. RPC uses bounded newline-delimited JSON under `nr-daemon-rpc/1`; there is no silent version fallback.

A replacement process first acquires the durable lease, then probes any old socket using its previous token. It removes the stale socket and rotates the token only after that health probe fails. A responsive prior daemon prevents startup.

The handshake reports the RPC and runtime protocol versions, daemon instance ID, ownership epoch/resource, SQLite schema version, and supported capabilities. A mismatched protocol or schema fails closed.

### Stdio MCP boundary

The MCP adapter is a thin child process: it implements the MCP stdio initialize, `tools/list`, and `tools/call` flow, then forwards the four NR-03 tools through authenticated local RPC. It publishes the existing NR-03 TypeBox schemas and validates inputs again in the daemon. Stdout carries JSON-RPC only; diagnostics use stderr. Closing the MCP process closes its RPC connection and never cancels accepted work.

NR-07 implements the initialize-era protocol through MCP revision `2025-11-25`, as required by the assigned initialize/list/call acceptance flow. Other MCP protocol eras are not negotiated in this task.

### Snapshot boundary

`review_submit` validates the full NR-03 request, checks the trusted repo allowlist, derives version/context bindings in the daemon, and atomically persists the review, cycle, idempotency record, event, and outbox entry. It returns the durable ID while the background owner proceeds from `QUEUED` to `SNAPSHOTTING`.

The daemon reuses NR-05 to persist an immutable snapshot. Only after complete snapshot evidence is durable does it advance to `REVIEWING`. It stops there; NR-07 creates no worker runs or scheduler. A structurally valid current fix request returns `BACKEND_UNAVAILABLE` with `retryable=false` and makes no state change.

`review_status` reads the current durable cycle and returns stable event pages in SQLite sequence order. Opaque cursors bind to both review and cycle. Strict profile progress stays at 0 of 9 until NR-08 dispatches work. Coverage is explicitly incomplete while a snapshot is pending.

### Cancellation and shutdown

Cancellation first persists `CANCEL_REQUESTED`. An active snapshot receives an abort signal; `CANCELLED` is recorded only after that snapshot task has stopped and can no longer commit. Client disconnect is not cancellation.

Drain rejects new mutations while status and handshake remain available. Active snapshot work is allowed to reach a durable boundary; on timeout, the daemon aborts in-memory snapshot work and leaves the accepted review in a resumable `QUEUED` or `SNAPSHOTTING` state. The listener closes before the lease is released. Shutdown never deletes an accepted review or marks it failed solely because the process is stopping.

## Последствия

- The daemon and MCP adapter are started separately; MCP does not spawn or stop the daemon.
- Durable review state survives adapter exit, while the daemon lease prevents split-brain writes.
- A pending review at `REVIEWING` is intentionally incomplete until later scheduler/backend tasks exist.
- The daemon exposes no remote transport, arbitrary target path, or target-repository command execution.
