import type { ProtocolError } from "../protocol";

export const DAEMON_RPC_PROTOCOL_VERSION = "nr-daemon-rpc/1" as const;
export const DAEMON_RPC_MAX_LINE_BYTES = 1_048_576;

export const DAEMON_RPC_METHODS = [
  "handshake",
  "review_submit",
  "review_status",
  "review_submit_fix",
  "review_cancel",
] as const;

export type DaemonRpcMethod = (typeof DAEMON_RPC_METHODS)[number];

export interface DaemonRpcRequest {
  readonly protocolVersion: string;
  readonly correlationId: string;
  readonly lifecycleToken: string;
  readonly method: string;
  readonly params?: unknown;
}

export type DaemonRpcResponse =
  | {
      readonly protocolVersion: typeof DAEMON_RPC_PROTOCOL_VERSION;
      readonly correlationId: string;
      readonly result: unknown;
    }
  | {
      readonly protocolVersion: typeof DAEMON_RPC_PROTOCOL_VERSION;
      readonly correlationId: string;
      readonly error: ProtocolError;
    };

export interface DaemonHandshake {
  readonly rpcProtocolVersion: typeof DAEMON_RPC_PROTOCOL_VERSION;
  readonly daemonInstanceId: string;
  readonly daemonOwnershipEpoch: number;
  readonly daemonOwnershipResourceId: string;
  readonly runtimeProtocolVersion: string;
  readonly storageSchemaVersion: number;
  readonly capabilities: readonly string[];
}
