import { randomUUID } from "node:crypto";
import type { FencingToken, LeaseRecord, SqliteStorage } from "../storage";
import { daemonOwnershipResourceId } from "../storage";

export const DAEMON_LEASE_TTL_MS = 30_000;
export const DAEMON_LEASE_RENEWAL_MS = 10_000;

export interface DaemonOwnerOptions {
  readonly ownerId?: string;
  readonly now?: () => string;
  readonly ttlMs?: number;
  readonly renewalIntervalMs?: number;
  readonly startHeartbeat?: boolean;
}

export class DaemonOwner {
  readonly resourceId: string;
  readonly ownerId: string;
  private lease: LeaseRecord;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lost = false;
  private released = false;

  private constructor(
    private readonly store: SqliteStorage,
    private readonly now: () => string,
    private readonly ttlMs: number,
    renewalIntervalMs: number,
    lease: LeaseRecord,
    startHeartbeat: boolean,
  ) {
    this.resourceId = lease.resourceId;
    this.ownerId = lease.ownerId;
    this.lease = lease;
    if (startHeartbeat) {
      this.timer = setInterval(
        () => this.renewInBackground(),
        renewalIntervalMs,
      );
    }
  }

  static acquire(
    store: SqliteStorage,
    options: DaemonOwnerOptions = {},
  ): DaemonOwner {
    const ttlMs = options.ttlMs ?? DAEMON_LEASE_TTL_MS;
    const renewalIntervalMs =
      options.renewalIntervalMs ?? DAEMON_LEASE_RENEWAL_MS;
    if (
      !Number.isSafeInteger(ttlMs) ||
      !Number.isSafeInteger(renewalIntervalMs) ||
      renewalIntervalMs < 1 ||
      renewalIntervalMs >= ttlMs
    ) {
      throw new TypeError("Daemon lease renewal must be below its TTL.");
    }
    const now = options.now ?? (() => new Date().toISOString());
    const ownerId = options.ownerId ?? randomUUID();
    const resourceId = daemonOwnershipResourceId(store.rootDir);
    const lease = store.acquireLease(resourceId, ownerId, ttlMs, now());
    return new DaemonOwner(
      store,
      now,
      ttlMs,
      renewalIntervalMs,
      lease,
      options.startHeartbeat ?? true,
    );
  }

  fencingToken(): FencingToken {
    if (
      this.lost ||
      this.released ||
      !this.store.hasLeaseOwnership(this.lease, this.now())
    ) {
      this.lost = true;
      throw new Error("Daemon ownership is no longer current.");
    }
    return {
      resourceId: this.lease.resourceId,
      ownerId: this.lease.ownerId,
      token: this.lease.token,
    };
  }

  renewNow(now = this.now()): LeaseRecord {
    if (this.lost || this.released) {
      throw new Error("Daemon ownership cannot be renewed after it was lost.");
    }
    try {
      this.lease = this.store.renewLease(this.lease, this.ttlMs, now);
      return this.lease;
    } catch (error) {
      this.lost = true;
      this.stopHeartbeat();
      throw error;
    }
  }

  isCurrent(): boolean {
    if (this.lost || this.released) return false;
    const current = this.store.hasLeaseOwnership(this.lease, this.now());
    if (!current) this.lost = true;
    return current;
  }

  stopHeartbeat(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  release(): void {
    this.stopHeartbeat();
    if (this.released) return;
    if (!this.isCurrent()) {
      this.released = true;
      return;
    }
    this.store.releaseLease(this.lease, this.now());
    this.released = true;
  }

  private renewInBackground(): void {
    try {
      this.renewNow();
    } catch {
      this.stopHeartbeat();
    }
  }
}
