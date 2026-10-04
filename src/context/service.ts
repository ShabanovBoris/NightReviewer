import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";
import type {
  SnapshotFileDescriptor,
  SnapshotManifest,
  SnapshotReader,
  SnapshotService,
} from "../snapshot";
import { SnapshotError } from "../snapshot/errors";
import {
  artifactReferenceFor,
  type SqliteStorage,
  StorageError,
} from "../storage";
import type {
  ArtifactReference,
  DirectionRunBinding,
  WorkerResultRecord,
} from "../storage/types";
import { ReviewContextError } from "./errors";
import type { ResolvedCapability, SearchCursorState } from "./security";
import { ContextCapabilityAuthority, permittedToolsForRole } from "./security";
import type {
  IssuedReviewContextCapability,
  ReviewContextBinding,
  ReviewContextDiffPage,
  ReviewContextLimits,
  ReviewContextListFilesPage,
  ReviewContextListFilesRequest,
  ReviewContextManifestPage,
  ReviewContextMetadata,
  ReviewContextPage,
  ReviewContextPageRequest,
  ReviewContextReadFileRequest,
  ReviewContextReadFileResult,
  ReviewContextSearchMatch,
  ReviewContextSearchPage,
  ReviewContextSearchRequest,
  ReviewContextService,
  ReviewContextServiceOptions,
  ReviewContextSnapshotBinding,
  ReviewContextTestEnvironment,
  ReviewContextTestResult,
  ReviewContextTestResultDocument,
  ReviewContextTestResultIngestRequest,
  ReviewContextTestResultsPage,
  ReviewContextTool,
} from "./types";
import { defaultReviewContextLimits, REVIEW_CONTEXT_TOOLS } from "./types";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();
const TEST_REPORT_KEYS = [
  "schemaVersion",
  "commitSha",
  "command",
  "exitCode",
  "startedAtUtc",
  "finishedAtUtc",
  "environment",
  "producer",
] as const;
const ENVIRONMENT_KEYS = [
  "os",
  "arch",
  "runtime",
  "runtimeVersion",
  "ci",
] as const;
const SEARCH_SKIP_STATES = [
  "BINARY",
  "INVALID_UTF8",
  "LFS_POINTER",
  "PATH_ENCODING_UNSUPPORTED",
  "SYMLINK_METADATA",
  "SUBMODULE_METADATA",
  "TOO_LARGE",
  "INSPECTION_LIMIT",
] as const;

interface BoundTestArtifact {
  readonly source: DirectionRunBinding;
  readonly reference: ArtifactReference;
}

interface TestResultRecord extends ReviewContextTestResult {
  readonly artifact: ArtifactReference;
}

type PageFactory<T, R extends ReviewContextPage<T>> = (
  metadata: ReviewContextMetadata,
  items: readonly T[],
) => R;

export function createReviewContextService(
  options: ReviewContextServiceOptions,
): ReviewContextService {
  const limits = resolveLimits(options.limits);
  const now = options.now ?? Date.now;
  return new ReviewContextServiceImpl(
    options.store,
    options.snapshotService,
    limits,
    now,
  );
}

class ReviewContextServiceImpl implements ReviewContextService {
  private readonly authority: ContextCapabilityAuthority;

  constructor(
    private readonly store: SqliteStorage,
    private readonly snapshotService: SnapshotService,
    private readonly limits: ReviewContextLimits,
    private readonly now: () => number,
  ) {
    this.authority = new ContextCapabilityAuthority(
      this.now,
      this.limits.maxActiveCapabilities,
    );
  }

  issueCapability(input: ReviewContextBinding): IssuedReviewContextCapability {
    const binding = normalizeBinding(input, this.limits, this.now());
    const runBinding = this.readRunBinding(binding.runId, binding.attemptId);
    if (!sameRunBinding(runBinding, binding)) throw forbidden();
    this.verifySnapshotBinding(binding.reviewId, {
      cycleId: binding.cycleId,
      snapshotId: binding.snapshotId,
      baseSha: binding.baseSha,
      headSha: binding.headSha,
    });
    if (binding.previousSnapshot !== undefined) {
      this.verifySnapshotBinding(binding.reviewId, binding.previousSnapshot);
    }
    const allowedCycles = new Set([
      binding.cycleId,
      ...(binding.previousSnapshot === undefined
        ? []
        : [binding.previousSnapshot.cycleId]),
    ]);
    for (const item of binding.boundTestArtifacts ?? []) {
      const source = this.readRunBinding(
        item.source.runId,
        item.source.attemptId,
      );
      if (
        !sameRunBinding(source, item.source) ||
        source.reviewId !== binding.reviewId ||
        !allowedCycles.has(source.cycleId) ||
        source.direction !== "tests"
      ) {
        throw forbidden();
      }
      const workerResult = this.readWorkerResult(source.attemptId);
      if (
        workerResult.directionRunId !== source.runId ||
        !sameArtifact(workerResult.rawArtifact, item.reference)
      ) {
        throw forbidden();
      }
    }
    const issued = this.authority.issue(binding);
    return {
      capability: issued.capability,
      expiresAtUtc: binding.expiresAtUtc,
    };
  }

  revokeCapability(capability: string): void {
    this.authority.revoke(capability);
  }

  revokeRun(runId: string): number {
    if (!isIdentifier(runId)) {
      throw invalidArgument("runId is invalid.");
    }
    return this.authority.revokeRun(runId);
  }

  async manifest(
    request: ReviewContextPageRequest,
  ): Promise<ReviewContextManifestPage> {
    const resolved = this.authorize(request, "review_context_manifest");
    const pageSize = this.pageSize(request.pageSize);
    const requestDigest = digestRequest({
      pair: resolved.selected.pair,
      pageSize,
    });
    return this.withReader(resolved, async (reader) => {
      const page = this.paginate(
        resolved,
        "review_context_manifest",
        reader.manifest.changes,
        request.cursor,
        pageSize,
        requestDigest,
        (metadata, items) => ({
          metadata,
          manifest: manifestSummary(reader.manifest),
          items,
        }),
      );
      return page;
    });
  }

  async diff(
    request: ReviewContextPageRequest,
  ): Promise<ReviewContextDiffPage> {
    const resolved = this.authorize(request, "review_context_diff");
    const pageSize = this.pageSize(request.pageSize);
    const requestDigest = digestRequest({
      pair: resolved.selected.pair,
      pageSize,
    });
    return this.withReader(resolved, async (reader) =>
      this.paginate(
        resolved,
        "review_context_diff",
        reader.diff,
        request.cursor,
        pageSize,
        requestDigest,
        (metadata, items) => ({
          metadata,
          diffPolicy: reader.manifest.diffPolicy,
          items,
        }),
      ),
    );
  }

  async readFile(
    request: ReviewContextReadFileRequest,
  ): Promise<ReviewContextReadFileResult> {
    const resolved = this.authorize(request, "review_context_read_file");
    const filePath = validatePath(request.path, this.limits.maxPathBytes);
    const side = validateSide(request.side);
    const chunkLimit = this.fileChunkSize(request.maxBytes);
    const requestDigest = digestRequest({
      pair: resolved.selected.pair,
      path: filePath,
      side,
      maxBytes: chunkLimit,
    });
    const cursor = this.authority.readCursor(
      request.cursor,
      resolved,
      "review_context_read_file",
      requestDigest,
    );
    if (cursor?.searchState !== undefined)
      throw invalidArgument("Cursor is invalid.");
    return this.withReader(resolved, async (reader, deadlineAt) => {
      const file = await reader.readFile(filePath, side, deadlineAt);
      const content = classifyContent(file.bytes, file.contentState);
      const offset = cursor?.offset ?? 0;
      if (offset > file.bytes.byteLength)
        throw invalidArgument("Cursor is outside the file.");
      let chunkLength = Math.min(chunkLimit, file.bytes.byteLength - offset);
      let result: ReviewContextReadFileResult;
      for (;;) {
        if (content.encoding === "utf-8") {
          chunkLength = utf8ChunkLength(file.bytes, offset, chunkLength);
        }
        const nextOffset = offset + chunkLength;
        const truncated = nextOffset < file.bytes.byteLength;
        const nextCursor = truncated
          ? this.authority.createCursor(
              resolved,
              "review_context_read_file",
              requestDigest,
              nextOffset,
            )
          : null;
        const metadata = this.metadata(
          resolved,
          "review_context_read_file",
          file.bytes.byteLength,
          truncated,
          nextCursor,
        );
        const chunk = file.bytes.subarray(offset, nextOffset);
        result = {
          metadata,
          path: file.path,
          mode: file.mode,
          oid: file.oid,
          side,
          contentState: content.state,
          encoding: content.encoding,
          ...(content.encoding === "utf-8"
            ? { text: UTF8.decode(chunk) }
            : { bytesBase64: Buffer.from(chunk).toString("base64") }),
        };
        if (jsonSize(result) <= this.limits.maxResponseBytes) break;
        if (chunkLength <= 1) {
          throw tooLarge("One file byte cannot fit within the response limit.");
        }
        chunkLength = Math.max(1, Math.floor(chunkLength / 2));
      }
      return result;
    });
  }

  async listFiles(
    request: ReviewContextListFilesRequest,
  ): Promise<ReviewContextListFilesPage> {
    const resolved = this.authorize(request, "review_context_list_files");
    const side = validateSide(request.side);
    const pageSize = this.pageSize(request.pageSize);
    const requestDigest = digestRequest({
      pair: resolved.selected.pair,
      side,
      pageSize,
    });
    return this.withReader(resolved, async (reader, deadlineAt) => {
      const files = await reader.listFiles(side, deadlineAt);
      return this.paginate(
        resolved,
        "review_context_list_files",
        files,
        request.cursor,
        pageSize,
        requestDigest,
        (metadata, items) => ({ metadata, side, items }),
      );
    });
  }

  async search(
    request: ReviewContextSearchRequest,
  ): Promise<ReviewContextSearchPage> {
    const resolved = this.authorize(request, "review_context_search");
    const side = validateSide(request.side);
    if (request.mode !== undefined && request.mode !== "literal") {
      throw invalidArgument("Only literal UTF-8 search is supported.");
    }
    const query = validateQuery(request.query, this.limits.maxQueryBytes);
    const pageSize = this.pageSize(request.pageSize);
    const requestDigest = digestRequest({
      pair: resolved.selected.pair,
      side,
      mode: "literal",
      query,
      pageSize,
    });
    const cursor = this.authority.readCursor(
      request.cursor,
      resolved,
      "review_context_search",
      requestDigest,
    );
    if (cursor !== undefined && cursor.searchState === undefined) {
      throw invalidArgument("Search cursor is invalid.");
    }
    if (cursor !== undefined && cursor.offset !== 0) {
      throw invalidArgument("Search cursor is invalid.");
    }
    return this.withReader(resolved, async (reader, deadlineAt) => {
      const files = await reader.listFiles(side, deadlineAt);
      const initialState: SearchCursorState = cursor?.searchState ?? {
        fileIndex: 0,
        lineIndex: 0,
        charOffset: 0,
        matchesSeen: 0,
        skippedByState: {},
      };
      validateSearchState(initialState, files.length);
      const outcome = await scanSearch({
        reader,
        files,
        side,
        query,
        initialState,
        pageSize,
        maxScannedBytes: this.limits.maxSearchScannedBytes,
        deadlineAt,
        maxResponseBytes: this.limits.maxResponseBytes,
        resolved,
        requestDigest,
        authority: this.authority,
        metadata: (total, truncated, nextCursor) =>
          this.metadata(
            resolved,
            "review_context_search",
            total,
            truncated,
            nextCursor,
          ),
      });
      const response: ReviewContextSearchPage = {
        metadata: outcome.metadata,
        side,
        totalExact: outcome.totalExact,
        skippedByState: outcome.searchState.skippedByState,
        scannedBytes: outcome.scannedBytes,
        items: outcome.items,
      };
      if (jsonSize(response) > this.limits.maxResponseBytes) {
        throw tooLarge("Search results exceed the response limit.");
      }
      return response;
    });
  }

  async testResults(
    request: ReviewContextPageRequest,
  ): Promise<ReviewContextTestResultsPage> {
    const resolved = this.authorize(request, "review_context_test_results");
    const pageSize = this.pageSize(request.pageSize);
    const requestDeadlineAt = Date.now() + this.limits.maxRequestTimeMs;
    const requestDigest = digestRequest({
      pair: resolved.selected.pair,
      pageSize,
    });
    const references = this.boundTestArtifactRefs(resolved);
    references.sort(
      (left, right) =>
        compareStable(left.reference.sha256, right.reference.sha256) ||
        compareStable(left.source.runId, right.source.runId) ||
        compareStable(left.source.attemptId, right.source.attemptId),
    );
    return this.paginateTestResults(
      resolved,
      references,
      request.cursor,
      pageSize,
      requestDigest,
      requestDeadlineAt,
    );
  }

  async ingestTestResult(
    request: ReviewContextTestResultIngestRequest,
  ): Promise<ArtifactReference> {
    const resolved = this.authorize(request, "review_context_test_results");
    if (
      resolved.binding.role !== "reviewer" ||
      resolved.binding.direction !== "tests"
    ) {
      throw forbidden();
    }
    const requestDeadlineAt = Date.now() + this.limits.maxRequestTimeMs;
    if (
      typeof request.expectedSha256 !== "string" ||
      !SHA256.test(request.expectedSha256) ||
      !Number.isSafeInteger(request.expectedSizeBytes) ||
      request.expectedSizeBytes <= 0 ||
      !(request.artifactBytes instanceof Uint8Array) ||
      request.artifactBytes.byteLength === 0 ||
      request.artifactBytes.byteLength > this.limits.maxTestArtifactBytes ||
      request.artifactBytes.byteLength !== request.expectedSizeBytes
    ) {
      throw invalidArgument(
        "Test-result artifact identity or size is invalid.",
      );
    }
    const expected = artifactReferenceFor(request.artifactBytes);
    if (expected.sha256 !== request.expectedSha256) {
      throw invalidArgument(
        "Test-result artifact SHA-256 does not match its bytes.",
      );
    }
    const report = parseTestResultDocument(request.artifactBytes, this.limits);
    const expectedOidLength = resolved.binding.baseSha.length;
    if (
      report.commitSha.length !== expectedOidLength ||
      !isFullOid(report.commitSha)
    ) {
      throw invalidArgument(
        "Test-result commit SHA does not match the bound repository format.",
      );
    }
    const existing = this.tryReadWorkerResult(resolved.binding.attemptId);
    if (existing !== undefined) {
      if (
        existing.directionRunId === resolved.binding.runId &&
        sameArtifact(existing.rawArtifact, expected)
      ) {
        const raw = await this.readArtifact(existing.rawArtifact);
        this.assertWithinDeadline(requestDeadlineAt);
        if (bytesEqual(raw, request.artifactBytes)) {
          this.assertWithinDeadline(requestDeadlineAt);
          return existing.rawArtifact;
        }
      }
      throw invalidArgument(
        "This worker attempt already has a different result artifact.",
      );
    }
    const status = this.readRunStatus(resolved.binding.runId);
    if (status !== "PENDING" && status !== "RUNNING") {
      throw invalidArgument(
        "Test results can only be ingested for an active bound run.",
      );
    }
    this.assertWithinDeadline(requestDeadlineAt);
    const reference = await this.persistArtifact(request.artifactBytes);
    this.assertWithinDeadline(requestDeadlineAt);
    const storedBytes = await this.readArtifact(reference);
    this.assertWithinDeadline(requestDeadlineAt);
    if (!bytesEqual(storedBytes, request.artifactBytes)) {
      throw backendUnavailable(
        "Persisted test-result artifact failed verification.",
      );
    }
    try {
      await this.store.recordWorkerResult({
        attemptId: resolved.binding.attemptId,
        rawArtifact: reference,
        disposition: report.exitCode === 0 ? "VALID" : "FAILED",
        selected: false,
        contentType: "application/json",
        parsedResult:
          report as unknown as import("../protocol").ProtocolJsonValue,
        recordedAtUtc: new Date(this.now()).toISOString(),
      });
    } catch {
      const raced = this.tryReadWorkerResult(resolved.binding.attemptId);
      if (
        raced !== undefined &&
        raced.directionRunId === resolved.binding.runId &&
        sameArtifact(raced.rawArtifact, reference)
      ) {
        this.assertWithinDeadline(requestDeadlineAt);
        return reference;
      }
      throw backendUnavailable(
        "Test-result record could not be committed to its bound attempt.",
      );
    }
    this.assertWithinDeadline(requestDeadlineAt);
    return reference;
  }

  close(): void {
    this.authority.close();
  }

  private authorize(
    request: unknown,
    tool: ReviewContextTool,
  ): ResolvedCapability {
    const record = isRecord(request) ? request : undefined;
    const pairName = record?.pair;
    return this.authority.resolve(
      record?.capability,
      tool,
      pairName as "current" | "previous" | undefined,
    );
  }

  private pageSize(value: unknown): number {
    if (value === undefined) return this.limits.defaultPageSize;
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < 1 ||
      (value as number) > this.limits.maxPageSize
    ) {
      throw invalidArgument("pageSize is outside the configured range.");
    }
    return value as number;
  }

  private fileChunkSize(value: unknown): number {
    if (value === undefined) return this.limits.defaultFileChunkBytes;
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < 1 ||
      (value as number) > this.limits.maxFileChunkBytes
    ) {
      throw invalidArgument(
        "maxBytes is outside the configured file-chunk range.",
      );
    }
    return value as number;
  }

  private metadata(
    resolved: ResolvedCapability,
    tool: ReviewContextTool,
    total: number,
    truncated: boolean,
    cursor: string | null,
  ): ReviewContextMetadata {
    return {
      snapshotId: resolved.selected.snapshotId,
      baseSha: resolved.selected.baseSha,
      headSha: resolved.selected.headSha,
      tool,
      total,
      truncated,
      cursor,
      pair: resolved.selected.pair,
    };
  }

  private paginate<T, R extends ReviewContextPage<T>>(
    resolved: ResolvedCapability,
    tool: ReviewContextTool,
    allItems: readonly T[],
    suppliedCursor: unknown,
    pageSize: number,
    requestDigest: string,
    factory: PageFactory<T, R>,
  ): R {
    const cursor = this.authority.readCursor(
      suppliedCursor,
      resolved,
      tool,
      requestDigest,
    );
    if (cursor?.searchState !== undefined)
      throw invalidArgument("Cursor is invalid.");
    const offset = cursor?.offset ?? 0;
    if (offset > allItems.length)
      throw invalidArgument("Cursor is outside the result set.");
    let end = Math.min(offset + pageSize, allItems.length);
    for (;;) {
      const truncated = end < allItems.length;
      const nextCursor = truncated
        ? this.authority.createCursor(resolved, tool, requestDigest, end)
        : null;
      const page = factory(
        this.metadata(resolved, tool, allItems.length, truncated, nextCursor),
        allItems.slice(offset, end),
      );
      if (jsonSize(page) <= this.limits.maxResponseBytes) return page;
      if (end <= offset)
        throw tooLarge("One context item exceeds the response limit.");
      end -= 1;
    }
  }

  private async withReader<T>(
    resolved: ResolvedCapability,
    action: (reader: SnapshotReader, deadlineAt: number) => Promise<T>,
  ): Promise<T> {
    const deadlineAt = Date.now() + this.limits.maxRequestTimeMs;
    let reader: SnapshotReader;
    try {
      reader = await this.snapshotService.openSnapshot(
        resolved.selected.cycleId,
        resolved.selected.snapshotId,
        deadlineAt,
      );
    } catch (error) {
      throw mapBackendError(error);
    }
    if (
      reader.manifest.snapshotId !== resolved.selected.snapshotId ||
      reader.manifest.cycleId !== resolved.selected.cycleId ||
      reader.manifest.baseSha !== resolved.selected.baseSha ||
      reader.manifest.headSha !== resolved.selected.headSha
    ) {
      await reader.close().catch(() => undefined);
      throw forbidden();
    }
    try {
      this.assertWithinDeadline(deadlineAt);
      const result = await action(reader, deadlineAt);
      this.assertWithinDeadline(deadlineAt);
      return result;
    } catch (error) {
      throw mapBackendError(error);
    } finally {
      await reader.close().catch(() => undefined);
    }
  }

  private assertWithinDeadline(deadlineAt: number): void {
    if (Date.now() >= deadlineAt) {
      throw tooLarge("Review-context request exceeded its time budget.");
    }
  }

  private verifySnapshotBinding(
    reviewId: string,
    reference: ReviewContextSnapshotBinding,
  ): void {
    try {
      const cycleContext = this.store.readSnapshotCycleContext(
        reference.cycleId,
      );
      if (cycleContext.reviewId !== reviewId) throw forbidden();
      const record = this.store
        .readSnapshots(reference.cycleId)
        .find((item) => item.snapshotId === reference.snapshotId);
      if (
        record === undefined ||
        record.baseSha !== reference.baseSha ||
        record.headSha !== reference.headSha ||
        manifestIdentityMismatch(record.manifest, reference)
      ) {
        throw forbidden();
      }
    } catch (error) {
      if (error instanceof ReviewContextError) throw error;
      throw forbidden();
    }
  }

  private readRunBinding(
    runId: string,
    attemptId: string,
  ): DirectionRunBinding {
    try {
      return this.store.readDirectionRunBinding(runId, attemptId);
    } catch {
      throw forbidden();
    }
  }

  private readWorkerResult(attemptId: string): WorkerResultRecord {
    try {
      return this.store.readWorkerResult(attemptId);
    } catch {
      throw backendUnavailable("A bound test-result record could not be read.");
    }
  }

  private tryReadWorkerResult(
    attemptId: string,
  ): WorkerResultRecord | undefined {
    try {
      return this.store.readWorkerResult(attemptId);
    } catch (error) {
      if (error instanceof StorageError && error.code === "NOT_FOUND")
        return undefined;
      throw mapBackendError(error);
    }
  }

  private readRunStatus(runId: string): string {
    try {
      return this.store.readDirectionRunStatus(runId);
    } catch {
      throw forbidden();
    }
  }

  private async readArtifact(
    reference: ArtifactReference,
  ): Promise<Uint8Array> {
    try {
      return await this.store.readRawArtifact(reference);
    } catch {
      throw backendUnavailable(
        "A bound test-result artifact failed verification.",
      );
    }
  }

  private async persistArtifact(bytes: Uint8Array): Promise<ArtifactReference> {
    try {
      return await this.store.persistRawArtifact(bytes);
    } catch {
      throw backendUnavailable("Test-result artifact could not be persisted.");
    }
  }

  private boundTestArtifactRefs(
    resolved: ResolvedCapability,
  ): BoundTestArtifact[] {
    const binding = resolved.binding;
    const refs: BoundTestArtifact[] = [];
    if (
      binding.role === "reviewer" &&
      binding.direction === "tests" &&
      resolved.selected.cycleId === binding.cycleId
    ) {
      const workerResult = this.tryReadWorkerResult(binding.attemptId);
      if (workerResult !== undefined) {
        if (workerResult.directionRunId !== binding.runId) throw forbidden();
        refs.push({
          source: bindingSource(binding),
          reference: workerResult.rawArtifact,
        });
      }
    } else {
      refs.push(
        ...(binding.boundTestArtifacts ?? []).filter(
          (item) => item.source.cycleId === resolved.selected.cycleId,
        ),
      );
    }
    return refs;
  }

  private async paginateTestResults(
    resolved: ResolvedCapability,
    references: readonly BoundTestArtifact[],
    suppliedCursor: unknown,
    pageSize: number,
    requestDigest: string,
    deadlineAt: number,
  ): Promise<ReviewContextTestResultsPage> {
    const cursor = this.authority.readCursor(
      suppliedCursor,
      resolved,
      "review_context_test_results",
      requestDigest,
    );
    if (cursor?.searchState !== undefined) {
      throw invalidArgument("Cursor is invalid.");
    }
    const offset = cursor?.offset ?? 0;
    if (offset > references.length) {
      throw invalidArgument("Cursor is outside the result set.");
    }
    let end = Math.min(offset + pageSize, references.length);
    const loaded = await this.readBoundTestResults(
      resolved,
      references.slice(offset, end),
      deadlineAt,
    );
    for (;;) {
      const truncated = end < references.length;
      const nextCursor = truncated
        ? this.authority.createCursor(
            resolved,
            "review_context_test_results",
            requestDigest,
            end,
          )
        : null;
      const page: ReviewContextTestResultsPage = {
        metadata: this.metadata(
          resolved,
          "review_context_test_results",
          references.length,
          truncated,
          nextCursor,
        ),
        items: loaded.slice(0, end - offset),
      };
      if (jsonSize(page) <= this.limits.maxResponseBytes) {
        this.assertWithinDeadline(deadlineAt);
        return page;
      }
      if (end <= offset) {
        throw tooLarge("One test-result item exceeds the response limit.");
      }
      end -= 1;
    }
  }

  private async readBoundTestResults(
    resolved: ResolvedCapability,
    refs: readonly BoundTestArtifact[],
    deadlineAt: number,
  ): Promise<TestResultRecord[]> {
    const output: TestResultRecord[] = [];
    for (const item of refs) {
      this.assertWithinDeadline(deadlineAt);
      const workerResult = this.readWorkerResult(item.source.attemptId);
      if (
        workerResult.directionRunId !== item.source.runId ||
        !sameArtifact(workerResult.rawArtifact, item.reference)
      ) {
        throw forbidden();
      }
      if (
        !Number.isSafeInteger(item.reference.sizeBytes) ||
        item.reference.sizeBytes <= 0
      ) {
        throw backendUnavailable(
          "A persisted test-result reference is malformed.",
        );
      }
      if (item.reference.sizeBytes > this.limits.maxTestArtifactBytes) {
        throw tooLarge("A bound test-result artifact exceeds the read limit.");
      }
      const bytes = await this.readArtifact(item.reference);
      this.assertWithinDeadline(deadlineAt);
      let report: ReviewContextTestResultDocument;
      try {
        report = parseTestResultDocument(bytes, this.limits);
      } catch {
        throw backendUnavailable(
          "A persisted test-result artifact is malformed.",
        );
      }
      const commits = [resolved.selected.baseSha, resolved.selected.headSha];
      output.push({
        resultId: workerResult.resultId,
        reviewId: item.source.reviewId,
        cycleId: item.source.cycleId,
        runId: item.source.runId,
        attemptId: item.source.attemptId,
        direction: item.source.direction,
        role: item.source.role,
        commitSha: report.commitSha,
        command: report.command,
        exitCode: report.exitCode,
        startedAtUtc: report.startedAtUtc,
        finishedAtUtc: report.finishedAtUtc,
        environment: report.environment,
        producer: report.producer,
        executionTrust: "UNVERIFIED",
        artifactIntegrity: "VERIFIED_SHA256_SIZE",
        applicability: commits.includes(report.commitSha)
          ? "APPLICABLE"
          : "NOT_APPLICABLE_STALE",
        artifact: item.reference,
      });
    }
    return output;
  }
}

async function scanSearch(input: {
  readonly reader: SnapshotReader;
  readonly files: readonly SnapshotFileDescriptor[];
  readonly side: "base" | "head";
  readonly query: string;
  readonly initialState: SearchCursorState;
  readonly pageSize: number;
  readonly maxScannedBytes: number;
  readonly deadlineAt: number;
  readonly maxResponseBytes: number;
  readonly resolved: ResolvedCapability;
  readonly requestDigest: string;
  readonly authority: ContextCapabilityAuthority;
  readonly metadata: (
    total: number,
    truncated: boolean,
    cursor: string | null,
  ) => ReviewContextMetadata;
}): Promise<{
  readonly items: readonly ReviewContextSearchMatch[];
  readonly metadata: ReviewContextMetadata;
  readonly totalExact: boolean;
  readonly searchState: SearchCursorState;
  readonly scannedBytes: number;
}> {
  const skipped = { ...input.initialState.skippedByState };
  const matches: Array<{
    readonly value: ReviewContextSearchMatch;
    readonly before: SearchCursorState;
  }> = [];
  let state: SearchCursorState = {
    ...input.initialState,
    skippedByState: skipped,
  };
  let scannedBytes = 0;
  let stoppedForBudget = false;
  let pageComplete = false;
  while (state.fileIndex < input.files.length) {
    if (Date.now() >= input.deadlineAt) {
      stoppedForBudget = true;
      break;
    }
    const fileIndex = state.fileIndex;
    const descriptor = input.files[fileIndex];
    if (descriptor === undefined)
      throw invalidArgument("Search cursor is invalid.");
    const unsupported = unsupportedSearchState(
      descriptor,
      input.reader.manifest.limits.maxBlobReadBytes,
    );
    if (unsupported !== undefined) {
      skipped[unsupported] = (skipped[unsupported] ?? 0) + 1;
      state = nextFileState(state, skipped);
      continue;
    }
    const sizeBytes = descriptor.sizeBytes;
    if (sizeBytes === undefined || sizeBytes > input.maxScannedBytes) {
      skipped.INSPECTION_LIMIT = (skipped.INSPECTION_LIMIT ?? 0) + 1;
      state = nextFileState(state, skipped);
      continue;
    }
    if (scannedBytes + sizeBytes > input.maxScannedBytes) {
      stoppedForBudget = true;
      break;
    }
    const file = await input.reader.readFile(
      descriptor.path,
      input.side,
      input.deadlineAt,
    );
    scannedBytes += file.bytes.byteLength;
    if (Date.now() >= input.deadlineAt) {
      stoppedForBudget = true;
      break;
    }
    if (file.bytes.includes(0)) {
      skipped.BINARY = (skipped.BINARY ?? 0) + 1;
      state = nextFileState(state, skipped);
      continue;
    }
    let text: string;
    try {
      text = UTF8.decode(file.bytes);
    } catch {
      skipped.INVALID_UTF8 = (skipped.INVALID_UTF8 ?? 0) + 1;
      state = nextFileState(state, skipped);
      continue;
    }
    const lines = text.split("\n");
    let lineIndex = state.lineIndex;
    let charOffset = state.charOffset;
    while (lineIndex < lines.length) {
      if (Date.now() >= input.deadlineAt) {
        state = {
          ...state,
          fileIndex,
          lineIndex,
          charOffset,
          skippedByState: { ...skipped },
        };
        stoppedForBudget = true;
        break;
      }
      const line = lines[lineIndex] ?? "";
      const matchIndex = line.indexOf(input.query, charOffset);
      if (matchIndex < 0) {
        lineIndex += 1;
        charOffset = 0;
        state = {
          ...state,
          fileIndex,
          lineIndex,
          charOffset,
          skippedByState: { ...skipped },
        };
        continue;
      }
      const before = {
        ...state,
        fileIndex,
        lineIndex,
        charOffset: matchIndex,
        skippedByState: { ...skipped },
      };
      const resume = advanceSearchPosition(
        state,
        line,
        lineIndex,
        matchIndex + input.query.length,
        lines.length,
        input.files.length,
        skipped,
      );
      const start = Math.max(0, matchIndex - 80);
      const end = Math.min(line.length, matchIndex + input.query.length + 120);
      matches.push({
        value: {
          path: descriptor.path,
          pathBytesBase64: descriptor.pathBytesBase64,
          line: lineIndex + 1,
          column: matchIndex + 1,
          match: input.query,
          snippet: line.slice(start, end),
        },
        before,
      });
      state = resume;
      if (resume.fileIndex === fileIndex) {
        lineIndex = resume.lineIndex;
        charOffset = resume.charOffset;
      } else {
        lineIndex = lines.length;
      }
      if (matches.length >= input.pageSize) {
        pageComplete = true;
        break;
      }
    }
    if (pageComplete || stoppedForBudget) break;
    if (lineIndex >= lines.length && state.fileIndex === fileIndex) {
      state = nextFileState(state, skipped);
    }
  }
  let nextState = state;
  let totalExact =
    nextState.fileIndex >= input.files.length &&
    Object.values(nextState.skippedByState).every((count) => count === 0);
  let truncated = nextState.fileIndex < input.files.length || stoppedForBudget;
  let items = matches.map((item) => item.value);
  let matchedCount = nextState.matchesSeen;
  let nextCursor = truncated
    ? input.authority.createCursor(
        input.resolved,
        "review_context_search",
        input.requestDigest,
        0,
        nextState,
      )
    : null;
  let metadata = input.metadata(matchedCount, truncated, nextCursor);
  while (
    items.length > 0 &&
    input.maxResponseBytes <
      jsonSize({
        metadata,
        side: input.side,
        totalExact,
        skippedByState: nextState.skippedByState,
        scannedBytes,
        items,
      })
  ) {
    const removed = matches.pop();
    if (removed === undefined) break;
    items = matches.map((item) => item.value);
    nextState = removed.before;
    matchedCount = nextState.matchesSeen;
    totalExact = false;
    truncated = true;
    nextCursor = input.authority.createCursor(
      input.resolved,
      "review_context_search",
      input.requestDigest,
      0,
      nextState,
    );
    metadata = input.metadata(matchedCount, truncated, nextCursor);
  }
  return {
    items,
    metadata,
    totalExact,
    searchState: nextState,
    scannedBytes,
  };
}

function resolveLimits(
  overrides: Partial<ReviewContextLimits> | undefined,
): ReviewContextLimits {
  const limits = { ...defaultReviewContextLimits, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw invalidArgument(
        `Context limit ${name} must be a positive safe integer.`,
      );
    }
  }
  if (
    limits.defaultPageSize > limits.maxPageSize ||
    limits.defaultFileChunkBytes > limits.maxFileChunkBytes
  ) {
    throw invalidArgument("Default context limits exceed their hard bounds.");
  }
  return Object.freeze(limits);
}

function normalizeBinding(
  input: ReviewContextBinding,
  limits: ReviewContextLimits,
  now: number,
): ReviewContextBinding {
  if (!isRecord(input)) throw invalidArgument("Capability binding is invalid.");
  const allowedKeys = [
    "reviewId",
    "cycleId",
    "runId",
    "attemptId",
    "direction",
    "role",
    "snapshotId",
    "baseSha",
    "headSha",
    "previousSnapshot",
    "expiresAtUtc",
    "allowedTools",
    "boundTestArtifacts",
  ];
  if (Object.keys(input).some((key) => !allowedKeys.includes(key))) {
    throw invalidArgument("Capability binding contains unsupported fields.");
  }
  for (const id of [
    input.reviewId,
    input.cycleId,
    input.runId,
    input.attemptId,
    input.snapshotId,
  ]) {
    if (!isIdentifier(id))
      throw invalidArgument("Capability binding identifier is invalid.");
  }
  if (
    input.direction !== "correctness" &&
    input.direction !== "tests" &&
    input.direction !== "design"
  ) {
    throw invalidArgument("Capability direction is invalid.");
  }
  if (
    input.role !== "reviewer" &&
    input.role !== "adjudicator" &&
    input.role !== "fix_verifier"
  ) {
    throw invalidArgument("Capability role is invalid.");
  }
  const shaLength = input.baseSha?.length;
  if (
    typeof input.baseSha !== "string" ||
    typeof input.headSha !== "string" ||
    input.headSha.length !== shaLength ||
    !isFullOid(input.baseSha) ||
    !isFullOid(input.headSha)
  ) {
    throw invalidArgument("Capability revision pair is invalid.");
  }
  const expiresAtMs = canonicalUtc(input.expiresAtUtc);
  if (
    expiresAtMs <= now ||
    expiresAtMs - now > limits.maxCapabilityLifetimeMs
  ) {
    throw invalidArgument(
      "Capability expiry must be finite and within the configured lifetime.",
    );
  }
  if (!Array.isArray(input.allowedTools) || input.allowedTools.length === 0) {
    throw invalidArgument("Capability must allow at least one context tool.");
  }
  const roleTools = permittedToolsForRole(input.role);
  const tools = [...input.allowedTools];
  if (
    tools.some(
      (tool) =>
        typeof tool !== "string" ||
        !REVIEW_CONTEXT_TOOLS.includes(tool as ReviewContextTool) ||
        !roleTools.includes(tool as ReviewContextTool),
    ) ||
    new Set(tools).size !== tools.length
  ) {
    throw invalidArgument("Capability tool list exceeds its role permissions.");
  }
  tools.sort();
  const previous =
    input.previousSnapshot === undefined
      ? undefined
      : normalizeSnapshotReference(input.previousSnapshot);
  if (input.role === "fix_verifier" && previous === undefined) {
    throw invalidArgument(
      "Fix-verifier capabilities require an explicit previous snapshot pair.",
    );
  }
  if (input.role !== "fix_verifier" && previous !== undefined) {
    throw invalidArgument(
      "Only fix-verifier capabilities may bind a previous snapshot pair.",
    );
  }
  const rawArtifacts = input.boundTestArtifacts ?? [];
  if (!Array.isArray(rawArtifacts) || rawArtifacts.length > 100) {
    throw invalidArgument(
      "Bound test artifact list exceeds the configured limit.",
    );
  }
  if (input.role === "reviewer" && rawArtifacts.length > 0) {
    throw invalidArgument(
      "Reviewer capabilities cannot bind foreign worker artifacts.",
    );
  }
  const boundTestArtifacts: BoundTestArtifact[] = rawArtifacts.map((item) => {
    if (
      !isRecord(item) ||
      !isRecord(item.source) ||
      !isRecord(item.reference)
    ) {
      throw invalidArgument("Bound test artifact reference is invalid.");
    }
    return {
      source: normalizeRunBinding(
        item.source as unknown as DirectionRunBinding,
      ),
      reference: normalizeArtifactReference(
        item.reference as unknown as ArtifactReference,
      ),
    };
  });
  const root: ReviewContextBinding = {
    reviewId: input.reviewId,
    cycleId: input.cycleId,
    runId: input.runId,
    attemptId: input.attemptId,
    direction: input.direction,
    role: input.role,
    snapshotId: input.snapshotId,
    baseSha: input.baseSha,
    headSha: input.headSha,
    ...(previous === undefined ? {} : { previousSnapshot: previous }),
    expiresAtUtc: input.expiresAtUtc,
    allowedTools: Object.freeze(tools),
    ...(boundTestArtifacts.length === 0
      ? {}
      : { boundTestArtifacts: Object.freeze(boundTestArtifacts) }),
  };
  return Object.freeze(root);
}

function normalizeSnapshotReference(
  input: ReviewContextSnapshotBinding,
): ReviewContextSnapshotBinding {
  if (
    !isRecord(input) ||
    Object.keys(input).some(
      (key) => !["cycleId", "snapshotId", "baseSha", "headSha"].includes(key),
    )
  ) {
    throw invalidArgument("Bound snapshot pair is invalid.");
  }
  if (
    !isIdentifier(input.cycleId) ||
    !isIdentifier(input.snapshotId) ||
    typeof input.baseSha !== "string" ||
    typeof input.headSha !== "string" ||
    input.baseSha.length !== input.headSha.length ||
    !isFullOid(input.baseSha) ||
    !isFullOid(input.headSha)
  ) {
    throw invalidArgument("Bound snapshot pair is invalid.");
  }
  return Object.freeze({
    cycleId: input.cycleId,
    snapshotId: input.snapshotId,
    baseSha: input.baseSha,
    headSha: input.headSha,
  });
}

function normalizeRunBinding(input: DirectionRunBinding): DirectionRunBinding {
  if (
    !isRecord(input) ||
    Object.keys(input).some(
      (key) =>
        ![
          "reviewId",
          "cycleId",
          "runId",
          "attemptId",
          "direction",
          "role",
        ].includes(key),
    ) ||
    !isIdentifier(input.reviewId) ||
    !isIdentifier(input.cycleId) ||
    !isIdentifier(input.runId) ||
    !isIdentifier(input.attemptId) ||
    (input.direction !== "correctness" &&
      input.direction !== "tests" &&
      input.direction !== "design") ||
    (input.role !== "reviewer" &&
      input.role !== "adjudicator" &&
      input.role !== "fix_verifier")
  ) {
    throw invalidArgument("Bound worker provenance is invalid.");
  }
  return Object.freeze({
    reviewId: input.reviewId,
    cycleId: input.cycleId,
    runId: input.runId,
    attemptId: input.attemptId,
    direction: input.direction,
    role: input.role,
  });
}

function normalizeArtifactReference(
  input: ArtifactReference,
): ArtifactReference {
  if (
    !isRecord(input) ||
    Object.keys(input).some(
      (key) => !["sha256", "sizeBytes", "relativePath"].includes(key),
    ) ||
    typeof input.sha256 !== "string" ||
    !SHA256.test(input.sha256) ||
    !Number.isSafeInteger(input.sizeBytes) ||
    (input.sizeBytes as number) < 0 ||
    typeof input.relativePath !== "string" ||
    input.relativePath.length > 512 ||
    input.relativePath.startsWith("/") ||
    input.relativePath.split("/").some((part) => part === ".." || part === "")
  ) {
    throw invalidArgument("Test artifact reference is invalid.");
  }
  return Object.freeze({
    sha256: input.sha256,
    sizeBytes: input.sizeBytes as number,
    relativePath: input.relativePath,
  });
}

function bindingSource(binding: ReviewContextBinding): DirectionRunBinding {
  return {
    reviewId: binding.reviewId,
    cycleId: binding.cycleId,
    runId: binding.runId,
    attemptId: binding.attemptId,
    direction: binding.direction,
    role: binding.role,
  };
}

function sameRunBinding(
  left: DirectionRunBinding,
  right: DirectionRunBinding,
): boolean {
  return (
    left.reviewId === right.reviewId &&
    left.cycleId === right.cycleId &&
    left.runId === right.runId &&
    left.attemptId === right.attemptId &&
    left.direction === right.direction &&
    left.role === right.role
  );
}

function sameArtifact(
  left: ArtifactReference,
  right: ArtifactReference,
): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.sizeBytes === right.sizeBytes &&
    left.relativePath === right.relativePath
  );
}

function manifestIdentityMismatch(
  manifest: unknown,
  reference: ReviewContextSnapshotBinding,
): boolean {
  if (!isRecord(manifest)) return true;
  return (
    manifest.snapshotId !== reference.snapshotId ||
    manifest.cycleId !== reference.cycleId ||
    manifest.baseSha !== reference.baseSha ||
    manifest.headSha !== reference.headSha
  );
}

function manifestSummary(manifest: SnapshotManifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    repoId: manifest.repoId,
    objectFormat: manifest.objectFormat,
    mergeBaseSha: manifest.mergeBaseSha,
    ancestryPolicy: manifest.ancestryPolicy,
    diffPolicy: manifest.diffPolicy,
    createdAtUtc: manifest.createdAtUtc,
    coverage: manifest.coverage,
    treeEntryCount: manifest.treeEntryCount,
    packedObjectCount: manifest.packedObjectCount,
    snapshotObjectBytes: manifest.snapshotObjectBytes,
  };
}

function validatePath(input: unknown, maxBytes: number): string {
  if (typeof input !== "string" || input.length === 0 || !validUnicode(input)) {
    throw invalidArgument(
      "File path must be a non-empty valid UTF-8 Git path.",
    );
  }
  const bytes = UTF8_ENCODER.encode(input);
  if (
    bytes.byteLength > maxBytes ||
    input.includes("\0") ||
    input.startsWith("/") ||
    input
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw invalidArgument(
      "File path is invalid or exceeds the configured path limit.",
    );
  }
  return input;
}

function validateQuery(input: unknown, maxBytes: number): string {
  if (typeof input !== "string" || input.length === 0 || !validUnicode(input)) {
    throw invalidArgument("Search query must be non-empty valid UTF-8 text.");
  }
  const bytes = UTF8_ENCODER.encode(input);
  if (
    bytes.byteLength > maxBytes ||
    input.includes("\0") ||
    input.includes("\n") ||
    input.includes("\r")
  ) {
    throw invalidArgument(
      "Search query is invalid or exceeds the configured limit.",
    );
  }
  return input;
}

function validateSide(input: unknown): "base" | "head" {
  if (input !== "base" && input !== "head") {
    throw invalidArgument("Snapshot side must be base or head.");
  }
  return input;
}

function classifyContent(
  bytes: Uint8Array,
  declared: SnapshotFileDescriptor["contentState"],
): {
  readonly encoding: "utf-8" | "base64";
  readonly state: ReviewContextReadFileResult["contentState"];
} {
  if (declared === "SYMLINK_METADATA") {
    return { encoding: "base64", state: declared };
  }
  if (declared === "BINARY" || bytes.includes(0)) {
    return { encoding: "base64", state: "BINARY" };
  }
  try {
    UTF8.decode(bytes);
    return { encoding: "utf-8", state: declared };
  } catch {
    return { encoding: "base64", state: "INVALID_UTF8" };
  }
}

function utf8ChunkLength(
  bytes: Uint8Array,
  offset: number,
  desired: number,
): number {
  if (desired === 0) return 0;
  let length = desired;
  while (length > 0) {
    try {
      UTF8.decode(bytes.subarray(offset, offset + length));
      return length;
    } catch {
      length -= 1;
    }
  }
  throw tooLarge("File chunk cannot be aligned to a UTF-8 boundary.");
}

function unsupportedSearchState(
  file: SnapshotFileDescriptor,
  maxBlobReadBytes: number,
): (typeof SEARCH_SKIP_STATES)[number] | undefined {
  if (file.contentState === "PATH_ENCODING_UNSUPPORTED")
    return "PATH_ENCODING_UNSUPPORTED";
  if (file.contentState === "SYMLINK_METADATA") return "SYMLINK_METADATA";
  if (
    file.contentState === "SUBMODULE_METADATA" ||
    file.objectType === "commit"
  )
    return "SUBMODULE_METADATA";
  if (
    file.contentState === "TOO_LARGE" ||
    (file.sizeBytes ?? 0) > maxBlobReadBytes
  )
    return "TOO_LARGE";
  if (file.contentState === "INSPECTION_LIMIT") return "INSPECTION_LIMIT";
  if (file.contentState === "LFS_POINTER") return "LFS_POINTER";
  if (file.contentState === "BINARY") return "BINARY";
  return undefined;
}

function nextFileState(
  state: SearchCursorState,
  skippedByState: Readonly<Record<string, number>>,
): SearchCursorState {
  return {
    fileIndex: state.fileIndex + 1,
    lineIndex: 0,
    charOffset: 0,
    matchesSeen: state.matchesSeen,
    skippedByState: { ...skippedByState },
  };
}

function advanceSearchPosition(
  state: SearchCursorState,
  line: string,
  lineIndex: number,
  charOffset: number,
  lineCount: number,
  fileCount: number,
  skippedByState: Readonly<Record<string, number>>,
): SearchCursorState {
  let nextLine = lineIndex;
  let nextOffset = charOffset;
  if (line.length - nextOffset === 0) {
    nextLine += 1;
    nextOffset = 0;
  }
  if (nextLine >= lineCount) {
    if (state.fileIndex + 1 >= fileCount) {
      return {
        fileIndex: fileCount,
        lineIndex: 0,
        charOffset: 0,
        matchesSeen: state.matchesSeen + 1,
        skippedByState: { ...skippedByState },
      };
    }
    return {
      fileIndex: state.fileIndex + 1,
      lineIndex: 0,
      charOffset: 0,
      matchesSeen: state.matchesSeen + 1,
      skippedByState: { ...skippedByState },
    };
  }
  return {
    fileIndex: state.fileIndex,
    lineIndex: nextLine,
    charOffset: nextOffset,
    matchesSeen: state.matchesSeen + 1,
    skippedByState: { ...skippedByState },
  };
}

function validateSearchState(
  state: SearchCursorState,
  fileCount: number,
): void {
  if (
    !Number.isSafeInteger(state.fileIndex) ||
    state.fileIndex < 0 ||
    state.fileIndex > fileCount ||
    !Number.isSafeInteger(state.lineIndex) ||
    state.lineIndex < 0 ||
    !Number.isSafeInteger(state.charOffset) ||
    state.charOffset < 0 ||
    !Number.isSafeInteger(state.matchesSeen) ||
    state.matchesSeen < 0 ||
    !isRecord(state.skippedByState) ||
    Object.entries(state.skippedByState).some(
      ([key, count]) =>
        !SEARCH_SKIP_STATES.includes(
          key as (typeof SEARCH_SKIP_STATES)[number],
        ) ||
        !Number.isSafeInteger(count) ||
        (count as number) < 0,
    )
  ) {
    throw invalidArgument("Search cursor state is invalid.");
  }
}

function parseTestResultDocument(
  bytes: Uint8Array,
  limits: ReviewContextLimits,
): ReviewContextTestResultDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8.decode(bytes));
  } catch {
    throw invalidArgument("Test-result artifact must be valid UTF-8 JSON.");
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== TEST_REPORT_KEYS.length ||
    Object.keys(parsed).some(
      (key) =>
        !TEST_REPORT_KEYS.includes(key as (typeof TEST_REPORT_KEYS)[number]),
    )
  ) {
    throw invalidArgument("Test-result artifact has an unsupported schema.");
  }
  const report = parsed as unknown as ReviewContextTestResultDocument;
  if (
    report.schemaVersion !== "nr-test-result/1" ||
    typeof report.commitSha !== "string" ||
    !isFullOid(report.commitSha) ||
    typeof report.command !== "string" ||
    !validUnicode(report.command) ||
    UTF8_ENCODER.encode(report.command).byteLength < 1 ||
    UTF8_ENCODER.encode(report.command).byteLength > limits.maxCommandBytes ||
    report.command.includes("\0") ||
    !(
      report.exitCode === null ||
      (Number.isSafeInteger(report.exitCode) &&
        report.exitCode >= 0 &&
        report.exitCode <= 255)
    ) ||
    !isCanonicalUtc(report.startedAtUtc) ||
    !isCanonicalUtc(report.finishedAtUtc) ||
    Date.parse(report.finishedAtUtc) < Date.parse(report.startedAtUtc) ||
    typeof report.producer !== "string" ||
    !validUnicode(report.producer) ||
    UTF8_ENCODER.encode(report.producer).byteLength < 1 ||
    UTF8_ENCODER.encode(report.producer).byteLength > limits.maxProducerBytes ||
    report.producer.includes("\0") ||
    !validateTestEnvironment(report.environment, limits.maxEnvironmentBytes)
  ) {
    throw invalidArgument("Test-result artifact fields are invalid.");
  }
  return {
    schemaVersion: "nr-test-result/1",
    commitSha: report.commitSha,
    command: report.command,
    exitCode: report.exitCode,
    startedAtUtc: report.startedAtUtc,
    finishedAtUtc: report.finishedAtUtc,
    environment: Object.freeze({ ...report.environment }),
    producer: report.producer,
  };
}

function validateTestEnvironment(
  value: ReviewContextTestEnvironment,
  maxBytes: number,
): value is ReviewContextTestEnvironment {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== ENVIRONMENT_KEYS.length ||
    Object.keys(value).some(
      (key) =>
        !ENVIRONMENT_KEYS.includes(key as (typeof ENVIRONMENT_KEYS)[number]),
    ) ||
    typeof value.os !== "string" ||
    typeof value.arch !== "string" ||
    typeof value.runtime !== "string" ||
    typeof value.runtimeVersion !== "string" ||
    typeof value.ci !== "boolean"
  ) {
    return false;
  }
  const values = [value.os, value.arch, value.runtime, value.runtimeVersion];
  if (
    values.some(
      (item) =>
        item.length === 0 ||
        item.length > 128 ||
        item.includes("\0") ||
        !validUnicode(item),
    )
  ) {
    return false;
  }
  return UTF8_ENCODER.encode(JSON.stringify(value)).byteLength <= maxBytes;
}

function canonicalUtc(value: unknown): number {
  if (!isCanonicalUtc(value))
    throw invalidArgument("UTC timestamp is invalid.");
  return Date.parse(value);
}

function isCanonicalUtc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function digestRequest(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function jsonSize(value: unknown): number {
  return UTF8_ENCODER.encode(JSON.stringify(value)).byteLength;
}

function validUnicode(value: string): boolean {
  try {
    return UTF8.decode(UTF8_ENCODER.encode(value)) === value;
  } catch {
    return false;
  }
}

function isFullOid(value: unknown): value is string {
  return typeof value === "string" && (SHA1.test(value) || SHA256.test(value));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function mapBackendError(error: unknown): ReviewContextError {
  if (error instanceof ReviewContextError) return error;
  if (error instanceof SnapshotError) {
    if (error.code === "NOT_FOUND")
      return new ReviewContextError(
        "NOT_FOUND",
        "Bound snapshot content was not found.",
      );
    if (error.code === "INVALID_ARGUMENT")
      return new ReviewContextError(
        "INVALID_ARGUMENT",
        "Snapshot request is invalid.",
      );
    if (error.code === "LIMIT_EXCEEDED")
      return new ReviewContextError(
        "CONTEXT_TOO_LARGE",
        "Snapshot read exceeded its configured bounds.",
      );
    return backendUnavailable("Bound snapshot content is unavailable.");
  }
  if (error instanceof StorageError) {
    if (error.code === "NOT_FOUND")
      return new ReviewContextError(
        "NOT_FOUND",
        "Bound context record was not found.",
      );
    if (error.code === "INVALID_ARGUMENT")
      return new ReviewContextError(
        "INVALID_ARGUMENT",
        "Context record is invalid.",
      );
    return backendUnavailable("Bound context storage is unavailable.");
  }
  return backendUnavailable("Review-context backend is unavailable.");
}

function invalidArgument(message: string): ReviewContextError {
  return new ReviewContextError("INVALID_ARGUMENT", message);
}

function forbidden(): ReviewContextError {
  return new ReviewContextError(
    "FORBIDDEN",
    "Review-context capability is invalid or its stored binding does not authorize this operation.",
  );
}

function tooLarge(message: string): ReviewContextError {
  return new ReviewContextError("CONTEXT_TOO_LARGE", message);
}

function backendUnavailable(message: string): ReviewContextError {
  return new ReviewContextError("BACKEND_UNAVAILABLE", message);
}
