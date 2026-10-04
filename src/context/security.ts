import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { ReviewContextError } from "./errors";
import type {
  ReviewContextBinding,
  ReviewContextPair,
  ReviewContextTool,
} from "./types";
import { REVIEW_CONTEXT_TOOLS } from "./types";

const roleTools: Readonly<
  Record<ReviewContextBinding["role"], readonly ReviewContextTool[]>
> = Object.freeze({
  reviewer: Object.freeze([
    "review_context_manifest",
    "review_context_diff",
    "review_context_read_file",
    "review_context_search",
    "review_context_list_files",
    "review_context_test_results",
  ] as const),
  adjudicator: Object.freeze([
    "review_context_manifest",
    "review_context_diff",
    "review_context_read_file",
    "review_context_test_results",
  ] as const),
  fix_verifier: Object.freeze([
    "review_context_manifest",
    "review_context_diff",
    "review_context_read_file",
    "review_context_search",
    "review_context_list_files",
    "review_context_test_results",
  ] as const),
});

export interface SelectedSnapshotBinding {
  readonly pair: ReviewContextPair;
  readonly cycleId: string;
  readonly snapshotId: string;
  readonly baseSha: string;
  readonly headSha: string;
}

export interface SearchCursorState {
  readonly fileIndex: number;
  readonly lineIndex: number;
  readonly charOffset: number;
  readonly matchesSeen: number;
  readonly skippedByState: Readonly<Record<string, number>>;
}

interface CursorPayload {
  readonly v: 1;
  readonly capabilityDigest: string;
  readonly snapshotId: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly tool: ReviewContextTool;
  readonly pair: ReviewContextPair;
  readonly requestDigest: string;
  readonly offset: number;
  readonly searchState?: SearchCursorState;
}

interface StoredCapability {
  readonly digest: string;
  readonly binding: ReviewContextBinding;
  revoked: boolean;
}

export interface ResolvedCapability {
  readonly digest: string;
  readonly binding: ReviewContextBinding;
  readonly selected: SelectedSnapshotBinding;
}

export class ContextCapabilityAuthority {
  private readonly records = new Map<string, StoredCapability>();
  private readonly cursorSecret = randomBytes(32);
  private closed = false;

  constructor(
    private readonly now: () => number,
    private readonly maxActive: number,
  ) {}

  issue(binding: ReviewContextBinding): { capability: string } {
    this.ensureOpen();
    this.pruneExpired();
    if (this.records.size >= this.maxActive) {
      throw new ReviewContextError(
        "CONTEXT_TOO_LARGE",
        "The active review-context capability limit has been reached.",
      );
    }
    const secret = randomBytes(32).toString("base64url");
    const digest = this.digest(secret);
    this.records.set(digest, {
      digest,
      binding,
      revoked: false,
    });
    return { capability: secret };
  }

  resolve(
    secret: unknown,
    tool: ReviewContextTool,
    pairName: ReviewContextPair | undefined,
  ): ResolvedCapability {
    this.ensureOpen();
    if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
      throw forbidden();
    }
    const digest = this.digest(secret);
    const record = this.records.get(digest);
    if (
      record === undefined ||
      record.revoked ||
      Date.parse(record.binding.expiresAtUtc) <= this.now()
    ) {
      throw forbidden();
    }
    if (
      !record.binding.allowedTools.includes(tool) ||
      !roleTools[record.binding.role].includes(tool)
    ) {
      throw forbidden();
    }
    const pair = pairName ?? "current";
    if (pair === "previous") {
      const previous = record.binding.previousSnapshot;
      if (record.binding.role !== "fix_verifier" || previous === undefined) {
        throw forbidden();
      }
      return {
        digest,
        binding: record.binding,
        selected: {
          pair,
          cycleId: previous.cycleId,
          snapshotId: previous.snapshotId,
          baseSha: previous.baseSha,
          headSha: previous.headSha,
        },
      };
    }
    if (pair !== "current") throw forbidden();
    return {
      digest,
      binding: record.binding,
      selected: {
        pair,
        cycleId: record.binding.cycleId,
        snapshotId: record.binding.snapshotId,
        baseSha: record.binding.baseSha,
        headSha: record.binding.headSha,
      },
    };
  }

  revoke(secret: unknown): void {
    this.ensureOpen();
    if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
      throw forbidden();
    }
    const record = this.records.get(this.digest(secret));
    if (record === undefined || record.revoked) throw forbidden();
    record.revoked = true;
  }

  revokeRun(runId: string): number {
    this.ensureOpen();
    let revoked = 0;
    for (const record of this.records.values()) {
      if (!record.revoked && record.binding.runId === runId) {
        record.revoked = true;
        revoked += 1;
      }
    }
    return revoked;
  }

  createCursor(
    resolved: ResolvedCapability,
    tool: ReviewContextTool,
    requestDigest: string,
    offset: number,
    searchState?: SearchCursorState,
  ): string {
    this.ensureOpen();
    const payload: CursorPayload = {
      v: 1,
      capabilityDigest: resolved.digest,
      snapshotId: resolved.selected.snapshotId,
      baseSha: resolved.selected.baseSha,
      headSha: resolved.selected.headSha,
      tool,
      pair: resolved.selected.pair,
      requestDigest,
      offset,
      ...(searchState === undefined ? {} : { searchState }),
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url",
    );
    const signature = createHmac("sha256", this.cursorSecret)
      .update(encoded)
      .digest("base64url");
    return `${encoded}.${signature}`;
  }

  readCursor(
    cursor: unknown,
    resolved: ResolvedCapability,
    tool: ReviewContextTool,
    requestDigest: string,
  ): { offset: number; searchState?: SearchCursorState } | undefined {
    this.ensureOpen();
    if (cursor === undefined) return undefined;
    if (
      typeof cursor !== "string" ||
      cursor.length < 80 ||
      cursor.length > 8_192
    ) {
      throw invalidCursor();
    }
    const parts = cursor.split(".");
    if (parts.length !== 2) throw invalidCursor();
    const [encoded, signatureText] = parts;
    if (
      encoded === undefined ||
      signatureText === undefined ||
      !/^[A-Za-z0-9_-]+$/.test(encoded) ||
      !/^[A-Za-z0-9_-]{43}$/.test(signatureText)
    ) {
      throw invalidCursor();
    }
    const suppliedSignature = Buffer.from(signatureText, "base64url");
    if (suppliedSignature.toString("base64url") !== signatureText) {
      throw invalidCursor();
    }
    const expectedSignature = createHmac("sha256", this.cursorSecret)
      .update(encoded)
      .digest();
    if (
      suppliedSignature.byteLength !== expectedSignature.byteLength ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      throw invalidCursor();
    }
    let value: unknown;
    try {
      const raw = Buffer.from(encoded, "base64url");
      if (raw.toString("base64url") !== encoded) throw invalidCursor();
      value = JSON.parse(raw.toString("utf8"));
    } catch {
      throw invalidCursor();
    }
    if (!isCursorPayload(value)) throw invalidCursor();
    if (value.capabilityDigest !== resolved.digest) throw forbidden();
    if (
      value.snapshotId !== resolved.selected.snapshotId ||
      value.baseSha !== resolved.selected.baseSha ||
      value.headSha !== resolved.selected.headSha ||
      value.pair !== resolved.selected.pair
    ) {
      throw forbidden();
    }
    if (value.tool !== tool || value.requestDigest !== requestDigest) {
      throw invalidCursor();
    }
    return {
      offset: value.offset,
      ...(value.searchState === undefined
        ? {}
        : { searchState: value.searchState }),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const record of this.records.values()) record.revoked = true;
    this.records.clear();
    this.cursorSecret.fill(0);
  }

  private digest(secret: string): string {
    return createHash("sha256").update(secret, "utf8").digest("hex");
  }

  private ensureOpen(): void {
    if (this.closed) throw forbidden();
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [digest, record] of this.records) {
      if (record.revoked || Date.parse(record.binding.expiresAtUtc) <= now) {
        this.records.delete(digest);
      }
    }
  }
}

export function permittedToolsForRole(
  role: ReviewContextBinding["role"],
): readonly ReviewContextTool[] {
  return roleTools[role];
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const item = value as Record<string, unknown>;
  return (
    item.v === 1 &&
    typeof item.capabilityDigest === "string" &&
    /^[0-9a-f]{64}$/.test(item.capabilityDigest) &&
    typeof item.snapshotId === "string" &&
    typeof item.baseSha === "string" &&
    typeof item.headSha === "string" &&
    REVIEW_CONTEXT_TOOLS.includes(item.tool as ReviewContextTool) &&
    typeof item.pair === "string" &&
    (item.pair === "current" || item.pair === "previous") &&
    typeof item.requestDigest === "string" &&
    /^[0-9a-f]{64}$/.test(item.requestDigest) &&
    Number.isSafeInteger(item.offset) &&
    (item.offset as number) >= 0 &&
    (item.searchState === undefined || isSearchCursorState(item.searchState))
  );
}

function isSearchCursorState(value: unknown): value is SearchCursorState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const state = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(state.fileIndex) &&
    (state.fileIndex as number) >= 0 &&
    Number.isSafeInteger(state.lineIndex) &&
    (state.lineIndex as number) >= 0 &&
    Number.isSafeInteger(state.charOffset) &&
    (state.charOffset as number) >= 0 &&
    Number.isSafeInteger(state.matchesSeen) &&
    (state.matchesSeen as number) >= 0 &&
    typeof state.skippedByState === "object" &&
    state.skippedByState !== null &&
    !Array.isArray(state.skippedByState) &&
    Object.values(state.skippedByState).every(
      (count) => Number.isSafeInteger(count) && (count as number) >= 0,
    )
  );
}

function forbidden(): ReviewContextError {
  return new ReviewContextError(
    "FORBIDDEN",
    "Review-context capability is invalid or does not authorize this operation.",
  );
}

function invalidCursor(): ReviewContextError {
  return new ReviewContextError(
    "INVALID_ARGUMENT",
    "Pagination cursor is invalid or bound to another request.",
  );
}
