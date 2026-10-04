import type {
  SnapshotChange,
  SnapshotFileDescriptor,
  SnapshotManifest,
  SnapshotSide,
} from "../snapshot";
import type { ArtifactReference, DirectionRunBinding } from "../storage/types";

export const REVIEW_CONTEXT_TOOLS = Object.freeze([
  "review_context_manifest",
  "review_context_diff",
  "review_context_read_file",
  "review_context_search",
  "review_context_list_files",
  "review_context_test_results",
] as const);

export type ReviewContextTool = (typeof REVIEW_CONTEXT_TOOLS)[number];
export type ReviewContextRole = DirectionRunBinding["role"];
export type ReviewContextPair = "current" | "previous";

export interface ReviewContextSnapshotBinding {
  readonly cycleId: string;
  readonly snapshotId: string;
  readonly baseSha: string;
  readonly headSha: string;
}

export interface ReviewContextBinding extends DirectionRunBinding {
  readonly snapshotId: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly previousSnapshot?: ReviewContextSnapshotBinding;
  readonly expiresAtUtc: string;
  readonly allowedTools: readonly ReviewContextTool[];
  /** Exact artifacts explicitly bound for adjudication or fix verification. */
  readonly boundTestArtifacts?: readonly {
    readonly source: DirectionRunBinding;
    readonly reference: ArtifactReference;
  }[];
}

export interface IssuedReviewContextCapability {
  readonly capability: string;
  readonly expiresAtUtc: string;
}

export interface ReviewContextLimits {
  readonly maxCapabilityLifetimeMs: number;
  readonly maxActiveCapabilities: number;
  readonly maxPathBytes: number;
  readonly maxQueryBytes: number;
  readonly maxPageSize: number;
  readonly defaultPageSize: number;
  readonly maxResponseBytes: number;
  readonly maxFileChunkBytes: number;
  readonly defaultFileChunkBytes: number;
  readonly maxSearchScannedBytes: number;
  readonly maxRequestTimeMs: number;
  readonly maxTestArtifactBytes: number;
  readonly maxCommandBytes: number;
  readonly maxProducerBytes: number;
  readonly maxEnvironmentBytes: number;
}

export const defaultReviewContextLimits: ReviewContextLimits = Object.freeze({
  maxCapabilityLifetimeMs: 86_400_000,
  maxActiveCapabilities: 10_000,
  maxPathBytes: 4_096,
  maxQueryBytes: 4_096,
  maxPageSize: 50,
  defaultPageSize: 25,
  maxResponseBytes: 262_144,
  maxFileChunkBytes: 32_768,
  defaultFileChunkBytes: 16_384,
  maxSearchScannedBytes: 16_777_216,
  maxRequestTimeMs: 10_000,
  maxTestArtifactBytes: 1_048_576,
  maxCommandBytes: 2_048,
  maxProducerBytes: 256,
  maxEnvironmentBytes: 4_096,
});

export interface ReviewContextMetadata {
  readonly snapshotId: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly tool: ReviewContextTool;
  readonly total: number;
  readonly truncated: boolean;
  readonly cursor: string | null;
  readonly pair: ReviewContextPair;
}

export interface ReviewContextPage<T> {
  readonly metadata: ReviewContextMetadata;
  readonly items: readonly T[];
}

export interface ReviewContextManifestSummary {
  readonly schemaVersion: SnapshotManifest["schemaVersion"];
  readonly repoId: string;
  readonly objectFormat: SnapshotManifest["objectFormat"];
  readonly mergeBaseSha: string;
  readonly ancestryPolicy: SnapshotManifest["ancestryPolicy"];
  readonly diffPolicy: SnapshotManifest["diffPolicy"];
  readonly createdAtUtc: string;
  readonly coverage: SnapshotManifest["coverage"];
  readonly treeEntryCount: number;
  readonly packedObjectCount: number;
  readonly snapshotObjectBytes: number;
}

export interface ReviewContextManifestPage
  extends ReviewContextPage<SnapshotChange> {
  readonly manifest: ReviewContextManifestSummary;
}

export interface ReviewContextDiffPage
  extends ReviewContextPage<SnapshotChange> {
  readonly diffPolicy: SnapshotManifest["diffPolicy"];
}

export interface ReviewContextReadFileResult {
  readonly metadata: ReviewContextMetadata;
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
  readonly side: SnapshotSide;
  readonly contentState:
    | SnapshotFileDescriptor["contentState"]
    | "BINARY"
    | "INVALID_UTF8";
  readonly encoding: "utf-8" | "base64";
  readonly text?: string;
  readonly bytesBase64?: string;
}

export interface ReviewContextListFilesPage
  extends ReviewContextPage<SnapshotFileDescriptor> {
  readonly side: SnapshotSide;
}

export interface ReviewContextSearchMatch {
  readonly path: string;
  readonly pathBytesBase64: string;
  readonly line: number;
  /** One-based UTF-16 column, matching JavaScript literal search semantics. */
  readonly column: number;
  readonly match: string;
  readonly snippet: string;
}

export interface ReviewContextSearchPage
  extends ReviewContextPage<ReviewContextSearchMatch> {
  readonly side: SnapshotSide;
  readonly totalExact: boolean;
  readonly skippedByState: Readonly<Record<string, number>>;
  readonly scannedBytes: number;
}

export interface ReviewContextTestEnvironment {
  readonly os: string;
  readonly arch: string;
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly ci: boolean;
}

export interface ReviewContextTestResultDocument {
  readonly schemaVersion: "nr-test-result/1";
  readonly commitSha: string;
  readonly command: string;
  readonly exitCode: number | null;
  readonly startedAtUtc: string;
  readonly finishedAtUtc: string;
  readonly environment: ReviewContextTestEnvironment;
  readonly producer: string;
}

export interface ReviewContextTestResult {
  readonly resultId: string;
  readonly reviewId: string;
  readonly cycleId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly direction: DirectionRunBinding["direction"];
  readonly role: ReviewContextRole;
  readonly commitSha: string;
  readonly command: string;
  readonly exitCode: number | null;
  readonly startedAtUtc: string;
  readonly finishedAtUtc: string;
  readonly environment: ReviewContextTestEnvironment;
  readonly producer: string;
  readonly executionTrust: "UNVERIFIED";
  readonly artifactIntegrity: "VERIFIED_SHA256_SIZE";
  readonly applicability: "APPLICABLE" | "NOT_APPLICABLE_STALE";
  readonly artifact: ArtifactReference;
}

export interface ReviewContextTestResultsPage
  extends ReviewContextPage<ReviewContextTestResult> {}

export interface ReviewContextPageRequest {
  readonly capability: string;
  readonly pair?: ReviewContextPair;
  readonly cursor?: string;
  readonly pageSize?: number;
}

export interface ReviewContextReadFileRequest {
  readonly capability: string;
  readonly pair?: ReviewContextPair;
  readonly path: string;
  readonly side: SnapshotSide;
  readonly cursor?: string;
  readonly maxBytes?: number;
}

export interface ReviewContextSearchRequest {
  readonly capability: string;
  readonly pair?: ReviewContextPair;
  readonly side: SnapshotSide;
  readonly query: string;
  readonly mode?: "literal" | "regex";
  readonly cursor?: string;
  readonly pageSize?: number;
}

export interface ReviewContextListFilesRequest
  extends ReviewContextPageRequest {
  readonly side: SnapshotSide;
}

export interface ReviewContextTestResultIngestRequest {
  readonly capability: string;
  readonly expectedSha256: string;
  readonly expectedSizeBytes: number;
  readonly artifactBytes: Uint8Array;
}

export interface ReviewContextService {
  issueCapability(binding: ReviewContextBinding): IssuedReviewContextCapability;
  revokeCapability(capability: string): void;
  revokeRun(runId: string): number;
  manifest(
    request: ReviewContextPageRequest,
  ): Promise<ReviewContextManifestPage>;
  diff(request: ReviewContextPageRequest): Promise<ReviewContextDiffPage>;
  readFile(
    request: ReviewContextReadFileRequest,
  ): Promise<ReviewContextReadFileResult>;
  search(request: ReviewContextSearchRequest): Promise<ReviewContextSearchPage>;
  listFiles(
    request: ReviewContextListFilesRequest,
  ): Promise<ReviewContextListFilesPage>;
  testResults(
    request: ReviewContextPageRequest,
  ): Promise<ReviewContextTestResultsPage>;
  ingestTestResult(
    request: ReviewContextTestResultIngestRequest,
  ): Promise<ArtifactReference>;
  close(): void;
}

export interface ReviewContextServiceOptions {
  readonly store: import("../storage").SqliteStorage;
  readonly snapshotService: import("../snapshot").SnapshotService;
  readonly limits?: Partial<ReviewContextLimits>;
  readonly now?: () => number;
}
