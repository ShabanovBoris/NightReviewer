import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  hashCanonicalJson,
  type ProtocolJsonValue,
} from "../protocol";
import type { SqliteStorage } from "../storage";
import { artifactReferenceFor } from "../storage/files";
import type { SnapshotRecord } from "../storage/types";
import { SnapshotError } from "./errors";
import {
  comparePathBytes,
  createBareObjectStore,
  createGitWorkspace,
  createObjectPack,
  decodeLine,
  type GitDiffRecord,
  type GitTreeEntry,
  type GitWorkspace,
  pathBytesKey,
  pathInfo,
  readBlobBatch,
  readDiffRecords,
  readObjectInventory,
  readObjectSize,
  readTreeEntries,
  removeSnapshotWorkspace,
  resolveAllowedRepository,
  resolveCommitTree,
  runGit,
} from "./git";
import {
  defaultSnapshotLimits,
  type SnapshotChange,
  type SnapshotFileDescriptor,
  type SnapshotLimits,
  type SnapshotManifest,
  type SnapshotReader,
  type SnapshotService,
  type SnapshotServiceOptions,
} from "./types";

const SHA256 = /^[0-9a-f]{64}$/;
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

interface BuiltChange {
  readonly pathBytes: Uint8Array;
  readonly oldPathBytes?: Uint8Array;
  readonly status: SnapshotChange["status"];
  readonly baseEntry?: GitTreeEntry;
  readonly headEntry?: GitTreeEntry;
}

export async function createSnapshotService(
  options: SnapshotServiceOptions,
): Promise<SnapshotService> {
  const limits = resolveLimits(options.limits);
  const repositoryPaths = await resolveRepositoryPaths(options.repositoryPaths);
  const callerId = options.callerId ?? "snapshot-service";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(callerId)) {
    throw new SnapshotError(
      "INVALID_ARGUMENT",
      "Snapshot service callerId is invalid.",
    );
  }
  return new SnapshotServiceImpl(
    options.store,
    repositoryPaths,
    limits,
    callerId,
  );
}

class SnapshotServiceImpl implements SnapshotService {
  constructor(
    private readonly store: SqliteStorage,
    private readonly repositoryPaths: ReadonlyMap<string, string>,
    private readonly limits: SnapshotLimits,
    private readonly callerId: string,
  ) {}

  async createSnapshot(input: {
    readonly cycleId: string;
    readonly specSha256?: string;
  }): Promise<SnapshotManifest> {
    if (
      typeof input.cycleId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.cycleId)
    ) {
      throw new SnapshotError("INVALID_ARGUMENT", "cycleId is invalid.");
    }
    if (input.specSha256 !== undefined && !SHA256.test(input.specSha256)) {
      throw new SnapshotError("INVALID_ARGUMENT", "specSha256 is invalid.");
    }
    const context = this.store.readSnapshotCycleContext(input.cycleId);
    if (context.cycle.state !== "SNAPSHOTTING") {
      throw new SnapshotError(
        "INVALID_ARGUMENT",
        "Review cycle must be in SNAPSHOTTING before a Git snapshot is created.",
      );
    }
    const { objectFormat, baseSha, headSha } = context.cycle.revisions;
    const deadlineAt = Date.now() + this.limits.maxCreationTimeMs;
    let workspace: GitWorkspace | undefined;
    try {
      const configuredPath = this.repositoryPaths.get(context.repoId);
      if (configuredPath === undefined) {
        throw new SnapshotError(
          "REPOSITORY_UNAVAILABLE",
          "Review repository is not in the trusted local allowlist.",
        );
      }
      workspace = await createGitWorkspace();
      const repositoryRoot = await resolveAllowedRepository(
        configuredPath,
        workspace,
        this.limits,
        deadlineAt,
        objectFormat,
      );
      const baseTreeSha = await resolveCommitTree(
        workspace,
        repositoryRoot,
        baseSha,
        objectFormat,
        this.limits,
        deadlineAt,
      );
      const headTreeSha = await resolveCommitTree(
        workspace,
        repositoryRoot,
        headSha,
        objectFormat,
        this.limits,
        deadlineAt,
      );
      const mergeBases = decodeLine(
        await runGit(
          workspace,
          repositoryRoot,
          ["merge-base", "--all", baseSha, headSha],
          { limits: this.limits, deadlineAt, maxStdoutBytes: 1_024 },
        ),
      )
        .split("\n")
        .filter(Boolean);
      if (mergeBases.length !== 1 || mergeBases[0] !== baseSha) {
        throw new SnapshotError(
          "ANCESTRY_VIOLATION",
          "Pinned base must be the unique merge base of the pinned head.",
        );
      }
      const baseTree = await readTreeEntries(
        workspace,
        repositoryRoot,
        baseSha,
        objectFormat,
        this.limits,
        deadlineAt,
      );
      const headTree = await readTreeEntries(
        workspace,
        repositoryRoot,
        headSha,
        objectFormat,
        this.limits,
        deadlineAt,
      );
      const diffRecords = await readDiffRecords(
        workspace,
        repositoryRoot,
        baseSha,
        headSha,
        this.limits,
        deadlineAt,
      );
      const treeEntryCount =
        baseTree.allEntries.length + headTree.allEntries.length;
      if (treeEntryCount > this.limits.maxTreeEntries) {
        throw new SnapshotError(
          "LIMIT_EXCEEDED",
          "Base and head trees exceed the configured entry limit.",
        );
      }
      const changedPathCount = diffRecords.reduce(
        (count, record) => count + (record.code === "R" ? 2 : 1),
        0,
      );
      if (changedPathCount > this.limits.maxChangedPaths) {
        throw new SnapshotError(
          "LIMIT_EXCEEDED",
          "Changed paths exceed the configured snapshot limit.",
        );
      }
      const builtChanges = buildChanges(
        diffRecords,
        baseTree.entries,
        headTree.entries,
      );
      const oidBytes = objectFormat === "sha1" ? 20 : 32;
      let treeObjectUpperBound = 0;
      const blobSizes = new Map<string, number>();
      for (const entry of [...baseTree.allEntries, ...headTree.allEntries]) {
        treeObjectUpperBound += entry.pathBytes.byteLength + oidBytes + 8;
        if (entry.objectType === "blob") {
          if (entry.sizeBytes === undefined) {
            throw new SnapshotError(
              "GIT_FAILED",
              "Git tree blob has no recorded size.",
            );
          }
          const existingSize = blobSizes.get(entry.oid);
          if (existingSize !== undefined && existingSize !== entry.sizeBytes) {
            throw new SnapshotError(
              "GIT_FAILED",
              "The same Git blob has inconsistent sizes in pinned trees.",
            );
          }
          blobSizes.set(entry.oid, entry.sizeBytes);
        }
      }
      const baseCommitSize = await readObjectSize(
        workspace,
        repositoryRoot,
        baseSha,
        this.limits,
        deadlineAt,
      );
      const headCommitSize = await readObjectSize(
        workspace,
        repositoryRoot,
        headSha,
        this.limits,
        deadlineAt,
      );
      const estimatedObjectBytes =
        [...blobSizes.values()].reduce((total, size) => total + size, 0) +
        treeObjectUpperBound +
        baseCommitSize +
        headCommitSize;
      if (
        !Number.isSafeInteger(estimatedObjectBytes) ||
        estimatedObjectBytes > this.limits.maxSnapshotObjectBytes
      ) {
        throw new SnapshotError(
          "LIMIT_EXCEEDED",
          "Base and head Git objects exceed the configured snapshot byte limit.",
        );
      }
      const objectIds = new Set<string>([
        baseSha,
        headSha,
        baseTreeSha,
        headTreeSha,
      ]);
      for (const entry of [...baseTree.allEntries, ...headTree.allEntries]) {
        if (entry.objectType === "tree" || entry.objectType === "blob") {
          objectIds.add(entry.oid);
        }
      }
      const pack = await createObjectPack(
        workspace,
        repositoryRoot,
        objectIds,
        this.limits,
        deadlineAt,
      );
      const bareDir = path.join(workspace.rootDir, "snapshot.git");
      await createBareObjectStore(
        workspace,
        bareDir,
        objectFormat,
        pack,
        this.limits,
        deadlineAt,
      );
      const objectInventory = await readObjectInventory(
        workspace,
        bareDir,
        objectFormat,
        this.limits,
        deadlineAt,
      );
      if (
        objectInventory.objectCount !== objectIds.size ||
        objectInventory.rawBytes > estimatedObjectBytes
      ) {
        throw new SnapshotError(
          "GIT_FAILED",
          "Packed snapshot object inventory differs from the pinned trees.",
        );
      }
      const inspectedBlobs = selectBlobsForInspection(
        builtChanges,
        this.limits,
      );
      const inspectedBytes = await readBlobBatch(
        workspace,
        bareDir,
        inspectedBlobs.selected,
        this.limits,
        deadlineAt,
      );
      const descriptors = buildManifestChanges(
        builtChanges,
        inspectedBytes,
        inspectedBlobs.skippedOids,
        this.limits,
      );
      const limitations = coverageLimitations(descriptors);
      const snapshotId = randomUUID();
      const createdAtUtc = new Date().toISOString();
      const artifactReference = artifactReferenceFor(pack);
      const manifest: SnapshotManifest = {
        schemaVersion: "nr-git-snapshot/1",
        snapshotId,
        cycleId: context.cycleId,
        repoId: context.repoId,
        objectFormat,
        baseSha,
        headSha,
        mergeBaseSha: mergeBases[0] as string,
        ancestryPolicy: "BASE_IS_UNIQUE_MERGE_BASE_OF_HEAD",
        diffPolicy: {
          direction: "BASE_TREE_TO_HEAD_TREE",
          renameDetection: "git-diff-tree-M50%",
          copyDetection: false,
        },
        baseTreeSha,
        headTreeSha,
        createdAtUtc,
        binding: {
          taskSha256: hashCanonicalJson(context.task),
          acceptanceCriteriaSha256: hashCanonicalJson(
            context.acceptanceCriteria,
          ),
          ...(input.specSha256 === undefined
            ? {}
            : { specSha256: input.specSha256 }),
        },
        changes: descriptors,
        coverage: {
          complete: limitations.length === 0,
          limitations,
        },
        limits: this.limits,
        treeEntryCount,
        packedObjectCount: objectInventory.objectCount,
        snapshotObjectBytes: objectInventory.rawBytes,
        snapshotArtifact: { ...artifactReference, format: "git-pack/2" },
      };
      const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
      if (manifestBytes.byteLength > this.limits.maxManifestBytes) {
        throw new SnapshotError(
          "LIMIT_EXCEEDED",
          "Snapshot manifest exceeds the configured metadata limit.",
        );
      }
      const manifestHash = hashCanonicalJson(manifest);
      const persistedManifest = JSON.parse(
        JSON.stringify(manifest),
      ) as ProtocolJsonValue;
      const snapshotInput: SnapshotRecord = {
        snapshotId,
        cycleId: context.cycleId,
        objectFormat,
        baseSha,
        headSha,
        manifestHash,
        manifest: persistedManifest,
        createdAtUtc,
      };
      await this.store.recordSnapshotWithArtifact(snapshotInput, pack);
      return manifest;
    } catch (error) {
      try {
        this.store.applyCycleCommand(this.callerId, context.cycleId, {
          type: "ADVANCE",
          target: "FAILED",
          expectedVersion: context.cycle.stateVersion,
          idempotencyKey: snapshotFailureKey(
            context.cycleId,
            context.cycle.stateVersion,
          ),
          evidence: { failureCode: snapshotFailureCode(error) },
        });
      } catch (transitionError) {
        throw new SnapshotError(
          "GIT_FAILED",
          "Snapshot failed and the review cycle could not be marked FAILED.",
          new AggregateError([error, transitionError]),
        );
      }
      throw error;
    } finally {
      if (workspace !== undefined) {
        await removeSnapshotWorkspace(workspace);
      }
    }
  }

  async openSnapshot(
    cycleId: string,
    snapshotId: string,
    requestedDeadlineAt?: number,
  ): Promise<SnapshotReader> {
    if (
      requestedDeadlineAt !== undefined &&
      (!Number.isSafeInteger(requestedDeadlineAt) ||
        requestedDeadlineAt <= Date.now())
    ) {
      throw new SnapshotError(
        "LIMIT_EXCEEDED",
        "Snapshot reader deadline has expired.",
      );
    }
    const record = this.store
      .readSnapshots(cycleId)
      .find((snapshot) => snapshot.snapshotId === snapshotId);
    if (record === undefined) {
      throw new SnapshotError("NOT_FOUND", "Snapshot was not found.");
    }
    const manifest = parseSnapshotManifest(record);
    if (
      manifest.snapshotArtifact.sizeBytes >
        this.limits.maxSnapshotArtifactBytes ||
      manifest.snapshotObjectBytes > this.limits.maxSnapshotObjectBytes
    ) {
      throw new SnapshotError(
        "LIMIT_EXCEEDED",
        "Snapshot artifact exceeds the configured reader limits.",
      );
    }
    const pack = await this.store.readRawArtifact(manifest.snapshotArtifact);
    if (
      requestedDeadlineAt !== undefined &&
      requestedDeadlineAt <= Date.now()
    ) {
      throw new SnapshotError(
        "LIMIT_EXCEEDED",
        "Snapshot reader deadline has expired.",
      );
    }
    if (pack.byteLength !== manifest.snapshotArtifact.sizeBytes) {
      throw new SnapshotError(
        "CONTENT_UNAVAILABLE",
        "Stored snapshot object pack has an unexpected size.",
      );
    }
    const workspace = await createGitWorkspace();
    let closed = false;
    try {
      const now = Date.now();
      if (
        requestedDeadlineAt !== undefined &&
        (!Number.isSafeInteger(requestedDeadlineAt) ||
          requestedDeadlineAt <= now)
      ) {
        throw new SnapshotError(
          "LIMIT_EXCEEDED",
          "Snapshot reader deadline has expired.",
        );
      }
      const openDeadlineAt = Math.min(
        requestedDeadlineAt ?? now + this.limits.maxCreationTimeMs,
        now + this.limits.maxCreationTimeMs,
      );
      const bareDir = path.join(workspace.rootDir, "snapshot.git");
      await createBareObjectStore(
        workspace,
        bareDir,
        manifest.objectFormat,
        pack,
        this.limits,
        openDeadlineAt,
      );
      const objectInventory = await readObjectInventory(
        workspace,
        bareDir,
        manifest.objectFormat,
        this.limits,
        openDeadlineAt,
      );
      if (
        objectInventory.objectCount !== manifest.packedObjectCount ||
        objectInventory.rawBytes !== manifest.snapshotObjectBytes
      ) {
        throw new SnapshotError(
          "CONTENT_UNAVAILABLE",
          "Snapshot pack contents do not match the immutable manifest.",
        );
      }
      for (const oid of [
        manifest.baseSha,
        manifest.headSha,
        manifest.baseTreeSha,
        manifest.headTreeSha,
      ]) {
        const expectedType =
          oid === manifest.baseSha || oid === manifest.headSha
            ? "commit"
            : "tree";
        const actualType = decodeLine(
          await runGit(workspace, bareDir, ["cat-file", "-t", oid], {
            limits: this.limits,
            deadlineAt: openDeadlineAt,
            maxStdoutBytes: 64,
          }),
        );
        if (actualType !== expectedType) {
          throw new SnapshotError(
            "CONTENT_UNAVAILABLE",
            "Snapshot pack does not contain its pinned commits and trees.",
          );
        }
      }
      const changedBase = new Map<string, SnapshotFileDescriptor>();
      const changedHead = new Map<string, SnapshotFileDescriptor>();
      for (const change of manifest.changes) {
        if (change.base !== undefined) {
          changedBase.set(change.base.pathBytesBase64, change.base);
        }
        if (change.head !== undefined) {
          changedHead.set(change.head.pathBytesBase64, change.head);
        }
      }
      let snapshotTrees:
        | {
            readonly base: ReadonlyMap<string, SnapshotFileDescriptor>;
            readonly head: ReadonlyMap<string, SnapshotFileDescriptor>;
          }
        | undefined;

      async function readSnapshotTrees(deadlineAt?: number): Promise<{
        readonly base: ReadonlyMap<string, SnapshotFileDescriptor>;
        readonly head: ReadonlyMap<string, SnapshotFileDescriptor>;
      }> {
        if (closed) {
          throw new SnapshotError("CLOSED", "Snapshot reader is closed.");
        }
        if (snapshotTrees !== undefined) return snapshotTrees;
        const currentTime = Date.now();
        if (
          deadlineAt !== undefined &&
          (!Number.isSafeInteger(deadlineAt) || deadlineAt <= currentTime)
        ) {
          throw new SnapshotError(
            "LIMIT_EXCEEDED",
            "Snapshot tree read deadline has expired.",
          );
        }
        const treeDeadlineAt = Math.min(
          deadlineAt ?? currentTime + manifest.limits.maxCreationTimeMs,
          currentTime + manifest.limits.maxCreationTimeMs,
        );
        const baseTree = await readTreeEntries(
          workspace,
          bareDir,
          manifest.baseSha,
          manifest.objectFormat,
          manifest.limits,
          treeDeadlineAt,
        );
        const headTree = await readTreeEntries(
          workspace,
          bareDir,
          manifest.headSha,
          manifest.objectFormat,
          manifest.limits,
          treeDeadlineAt,
        );
        if (
          baseTree.allEntries.length + headTree.allEntries.length !==
          manifest.treeEntryCount
        ) {
          throw new SnapshotError(
            "CONTENT_UNAVAILABLE",
            "Pinned snapshot trees do not match the immutable manifest count.",
          );
        }
        snapshotTrees = {
          base: describeSnapshotTree(baseTree.entries, changedBase, manifest),
          head: describeSnapshotTree(headTree.entries, changedHead, manifest),
        };
        return snapshotTrees;
      }

      return {
        manifest,
        diff: manifest.changes,
        async listFiles(side, deadlineAt) {
          if (side !== "base" && side !== "head") {
            throw new SnapshotError(
              "INVALID_ARGUMENT",
              "Snapshot side must be base or head.",
            );
          }
          const trees = await readSnapshotTrees(deadlineAt);
          const entries = [...trees[side].values()];
          entries.sort((left, right) =>
            comparePathBytes(
              Buffer.from(left.pathBytesBase64, "base64"),
              Buffer.from(right.pathBytesBase64, "base64"),
            ),
          );
          return entries;
        },
        async readFile(filePath, side, requestedReadDeadlineAt) {
          if (closed)
            throw new SnapshotError("CLOSED", "Snapshot reader is closed.");
          if (side !== "base" && side !== "head") {
            throw new SnapshotError(
              "INVALID_ARGUMENT",
              "Snapshot side must be base or head.",
            );
          }
          validateReadPath(filePath);
          const currentTime = Date.now();
          if (
            requestedReadDeadlineAt !== undefined &&
            (!Number.isSafeInteger(requestedReadDeadlineAt) ||
              requestedReadDeadlineAt <= currentTime)
          ) {
            throw new SnapshotError(
              "LIMIT_EXCEEDED",
              "Snapshot file read deadline has expired.",
            );
          }
          const readDeadlineAt = Math.min(
            requestedReadDeadlineAt ??
              currentTime + manifest.limits.maxCreationTimeMs,
            currentTime + manifest.limits.maxCreationTimeMs,
          );
          const pathBytesBase64 = Buffer.from(filePath, "utf8").toString(
            "base64",
          );
          const descriptor = (await readSnapshotTrees(readDeadlineAt))[
            side
          ].get(pathBytesBase64);
          if (descriptor === undefined) {
            throw new SnapshotError(
              "NOT_FOUND",
              "Path is not present on the requested side of the snapshot diff.",
            );
          }
          if (descriptor.objectType !== "blob") {
            throw new SnapshotError(
              "CONTENT_UNAVAILABLE",
              "Submodule entries contain commit metadata, not file content.",
            );
          }
          if (
            descriptor.contentState === "TOO_LARGE" ||
            descriptor.contentState === "INSPECTION_LIMIT" ||
            descriptor.contentState === "PATH_ENCODING_UNSUPPORTED" ||
            descriptor.sizeBytes === undefined ||
            descriptor.sizeBytes > manifest.limits.maxBlobReadBytes
          ) {
            throw new SnapshotError(
              "CONTENT_UNAVAILABLE",
              "File content is outside the recorded snapshot read limits.",
            );
          }
          const bytes = await runGit(
            workspace,
            bareDir,
            ["cat-file", "blob", descriptor.oid],
            {
              limits: manifest.limits,
              deadlineAt: readDeadlineAt,
              maxStdoutBytes: descriptor.sizeBytes,
            },
          );
          if (bytes.byteLength !== descriptor.sizeBytes) {
            throw new SnapshotError(
              "CONTENT_UNAVAILABLE",
              "Stored Git blob differs from its manifest size.",
            );
          }
          return {
            path: descriptor.path,
            mode: descriptor.mode,
            oid: descriptor.oid,
            sizeBytes: descriptor.sizeBytes,
            contentState: descriptor.contentState,
            bytes,
          };
        },
        async close() {
          if (closed) return;
          closed = true;
          await removeSnapshotWorkspace(workspace);
        },
      };
    } catch (error) {
      await removeSnapshotWorkspace(workspace);
      throw error;
    }
  }
}

function buildChanges(
  records: readonly GitDiffRecord[],
  baseEntries: ReadonlyMap<string, GitTreeEntry>,
  headEntries: ReadonlyMap<string, GitTreeEntry>,
): BuiltChange[] {
  const changes: BuiltChange[] = [];
  for (const record of records) {
    const oldKey =
      record.oldPath === undefined ? undefined : pathBytesKey(record.oldPath);
    const newKey =
      record.newPath === undefined ? undefined : pathBytesKey(record.newPath);
    const baseEntry =
      oldKey === undefined ? undefined : baseEntries.get(oldKey);
    const headEntry =
      newKey === undefined ? undefined : headEntries.get(newKey);
    if (
      (record.oldPath !== undefined && baseEntry === undefined) ||
      (record.newPath !== undefined && headEntry === undefined)
    ) {
      throw new SnapshotError(
        "GIT_FAILED",
        "Git diff path could not be resolved in its exact commit tree.",
      );
    }
    const status: SnapshotChange["status"] =
      record.code === "A"
        ? "ADDED"
        : record.code === "D"
          ? "DELETED"
          : record.code === "R"
            ? "RENAMED"
            : record.code === "T"
              ? "TYPE_CHANGED"
              : "MODIFIED";
    const pathBytes = record.newPath ?? record.oldPath;
    if (pathBytes === undefined) {
      throw new SnapshotError("GIT_FAILED", "Git diff record has no path.");
    }
    changes.push({
      pathBytes: new Uint8Array(pathBytes),
      ...(record.code === "R" && record.oldPath !== undefined
        ? { oldPathBytes: new Uint8Array(record.oldPath) }
        : {}),
      status,
      ...(baseEntry === undefined ? {} : { baseEntry }),
      ...(headEntry === undefined ? {} : { headEntry }),
    });
  }
  changes.sort((left, right) => {
    const pathOrder = comparePathBytes(left.pathBytes, right.pathBytes);
    if (pathOrder !== 0) return pathOrder;
    return comparePathBytes(
      left.oldPathBytes ?? left.pathBytes,
      right.oldPathBytes ?? right.pathBytes,
    );
  });
  return changes;
}

function selectBlobsForInspection(
  changes: readonly BuiltChange[],
  limits: SnapshotLimits,
): {
  readonly selected: ReadonlyMap<string, number>;
  readonly skippedOids: ReadonlySet<string>;
} {
  const selected = new Map<string, number>();
  const skippedOids = new Set<string>();
  let availableBytes = limits.maxContentInspectionBytes;
  for (const change of changes) {
    for (const entry of [change.baseEntry, change.headEntry]) {
      if (
        entry === undefined ||
        entry.objectType !== "blob" ||
        entry.mode === "120000" ||
        !entry.pathUtf8Valid ||
        entry.sizeBytes === undefined ||
        entry.sizeBytes > limits.maxBlobReadBytes ||
        selected.has(entry.oid) ||
        skippedOids.has(entry.oid)
      ) {
        continue;
      }
      if (entry.sizeBytes > availableBytes) {
        skippedOids.add(entry.oid);
      } else {
        selected.set(entry.oid, entry.sizeBytes);
        availableBytes -= entry.sizeBytes;
      }
    }
  }
  return { selected, skippedOids };
}

function buildManifestChanges(
  changes: readonly BuiltChange[],
  inspected: ReadonlyMap<string, Uint8Array>,
  skippedOids: ReadonlySet<string>,
  limits: SnapshotLimits,
): SnapshotChange[] {
  return changes.map((change) => {
    const path = pathInfo(change.pathBytes);
    const oldPath =
      change.oldPathBytes === undefined
        ? undefined
        : pathInfo(change.oldPathBytes);
    const base =
      change.baseEntry === undefined
        ? undefined
        : buildFileDescriptor(change.baseEntry, inspected, skippedOids, limits);
    const head =
      change.headEntry === undefined
        ? undefined
        : buildFileDescriptor(change.headEntry, inspected, skippedOids, limits);
    return {
      status: change.status,
      path: path.path,
      pathBytesBase64: path.pathBytesBase64,
      ...(oldPath === undefined
        ? {}
        : {
            oldPath: oldPath.path,
            oldPathBytesBase64: oldPath.pathBytesBase64,
          }),
      ...(base === undefined ? {} : { base }),
      ...(head === undefined ? {} : { head }),
    };
  });
}

function buildFileDescriptor(
  entry: GitTreeEntry,
  inspected: ReadonlyMap<string, Uint8Array>,
  skippedOids: ReadonlySet<string>,
  limits: SnapshotLimits,
): SnapshotFileDescriptor {
  if (entry.objectType === "tree") {
    throw new SnapshotError(
      "GIT_FAILED",
      "A directory tree unexpectedly appeared as a changed file.",
    );
  }
  let contentState: SnapshotFileDescriptor["contentState"];
  if (!entry.pathUtf8Valid) {
    contentState = "PATH_ENCODING_UNSUPPORTED";
  } else if (entry.objectType === "commit") {
    contentState = "SUBMODULE_METADATA";
  } else if (
    entry.sizeBytes === undefined ||
    entry.sizeBytes > limits.maxBlobReadBytes
  ) {
    contentState = "TOO_LARGE";
  } else if (entry.mode === "120000") {
    contentState = "SYMLINK_METADATA";
  } else if (skippedOids.has(entry.oid)) {
    contentState = "INSPECTION_LIMIT";
  } else {
    const bytes = inspected.get(entry.oid);
    if (bytes === undefined) {
      throw new SnapshotError(
        "GIT_FAILED",
        "Changed blob was not inspected within the snapshot operation.",
      );
    }
    contentState = isLfsPointer(bytes)
      ? "LFS_POINTER"
      : bytes.includes(0)
        ? "BINARY"
        : "AVAILABLE";
  }
  const path = pathInfo(entry.pathBytes);
  return {
    path: path.path,
    pathBytesBase64: path.pathBytesBase64,
    mode: entry.mode,
    objectType: entry.objectType,
    oid: entry.oid,
    ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
    contentState,
    ...(contentState === "LFS_POINTER"
      ? { lfs: parseLfsPointer(inspected.get(entry.oid) as Uint8Array) }
      : {}),
  };
}

function describeSnapshotTree(
  entries: ReadonlyMap<string, GitTreeEntry>,
  changedDescriptors: ReadonlyMap<string, SnapshotFileDescriptor>,
  manifest: SnapshotManifest,
): ReadonlyMap<string, SnapshotFileDescriptor> {
  const result = new Map<string, SnapshotFileDescriptor>();
  for (const [pathBytesBase64, changed] of changedDescriptors) {
    const entry = entries.get(pathBytesBase64);
    if (
      entry === undefined ||
      changed.path !== entry.path ||
      changed.mode !== entry.mode ||
      changed.objectType !== entry.objectType ||
      changed.oid !== entry.oid ||
      changed.sizeBytes !== entry.sizeBytes
    ) {
      throw new SnapshotError(
        "CONTENT_UNAVAILABLE",
        "Changed-file metadata does not match its pinned Git tree entry.",
      );
    }
  }
  for (const [pathBytesBase64, entry] of entries) {
    if (entry.objectType === "tree") continue;
    const changed = changedDescriptors.get(pathBytesBase64);
    if (changed !== undefined) {
      result.set(pathBytesBase64, changed);
      continue;
    }
    const contentState: SnapshotFileDescriptor["contentState"] =
      !entry.pathUtf8Valid
        ? "PATH_ENCODING_UNSUPPORTED"
        : entry.objectType === "commit"
          ? "SUBMODULE_METADATA"
          : entry.sizeBytes === undefined ||
              entry.sizeBytes > manifest.limits.maxBlobReadBytes
            ? "TOO_LARGE"
            : entry.mode === "120000"
              ? "SYMLINK_METADATA"
              : "AVAILABLE";
    result.set(pathBytesBase64, {
      path: entry.path,
      pathBytesBase64,
      mode: entry.mode,
      objectType: entry.objectType,
      oid: entry.oid,
      ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
      contentState,
    });
  }
  return result;
}

function coverageLimitations(changes: readonly SnapshotChange[]): string[] {
  const limitations = new Set<string>();
  for (const change of changes) {
    for (const descriptor of [change.base, change.head]) {
      if (descriptor === undefined) continue;
      if (descriptor.contentState === "BINARY")
        limitations.add("BINARY_CONTENT");
      if (descriptor.contentState === "LFS_POINTER") {
        limitations.add("LFS_PAYLOAD_NOT_EMBEDDED");
      }
      if (descriptor.contentState === "TOO_LARGE")
        limitations.add("BLOB_READ_LIMIT");
      if (descriptor.contentState === "INSPECTION_LIMIT") {
        limitations.add("CONTENT_INSPECTION_LIMIT");
      }
      if (descriptor.contentState === "SUBMODULE_METADATA") {
        limitations.add("SUBMODULE_NOT_TRAVERSED");
      }
      if (descriptor.contentState === "PATH_ENCODING_UNSUPPORTED") {
        limitations.add("PATH_ENCODING_UNSUPPORTED");
      }
    }
    if (change.oldPathBytesBase64 !== undefined) {
      // The path encoding is also captured for a renamed file's original side.
      const oldPath = Buffer.from(change.oldPathBytesBase64, "base64");
      if (!isUtf8(oldPath)) limitations.add("PATH_ENCODING_UNSUPPORTED");
    }
  }
  return [...limitations].sort();
}

function isLfsPointer(bytes: Uint8Array): boolean {
  const parsed = parseLfsPointerOrUndefined(bytes);
  return parsed !== undefined;
}

function parseLfsPointer(bytes: Uint8Array): {
  oid: string;
  sizeBytes: number;
} {
  const parsed = parseLfsPointerOrUndefined(bytes);
  if (parsed === undefined) {
    throw new SnapshotError("GIT_FAILED", "LFS pointer parser lost its match.");
  }
  return parsed;
}

function parseLfsPointerOrUndefined(
  bytes: Uint8Array,
): { oid: string; sizeBytes: number } | undefined {
  if (bytes.byteLength > 1_024 || bytes.includes(0)) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const match =
    /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n(?:ext-[^\n]+\n)*oid sha256:([0-9a-f]{64})\nsize (0|[1-9][0-9]*)\n?$/.exec(
      text,
    );
  if (match === null) return undefined;
  const sizeBytes = Number(match[2]);
  if (!Number.isSafeInteger(sizeBytes)) return undefined;
  return { oid: match[1] as string, sizeBytes };
}

function parseSnapshotManifest(record: SnapshotRecord): SnapshotManifest {
  const value = record.manifest;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SnapshotError(
      "CONTENT_UNAVAILABLE",
      "Snapshot manifest is malformed.",
    );
  }
  const input = value as Record<string, unknown>;
  const artifactValue = input.snapshotArtifact;
  const objectFormat = input.objectFormat;
  const oidLength = objectFormat === "sha1" ? 40 : 64;
  if (
    input.schemaVersion !== "nr-git-snapshot/1" ||
    input.snapshotId !== record.snapshotId ||
    input.cycleId !== record.cycleId ||
    objectFormat !== record.objectFormat ||
    input.baseSha !== record.baseSha ||
    input.headSha !== record.headSha ||
    (objectFormat !== "sha1" && objectFormat !== "sha256") ||
    !isFullOid(input.baseSha, oidLength) ||
    !isFullOid(input.headSha, oidLength) ||
    !isFullOid(input.mergeBaseSha, oidLength) ||
    input.mergeBaseSha !== input.baseSha ||
    !isFullOid(input.baseTreeSha, oidLength) ||
    !isFullOid(input.headTreeSha, oidLength) ||
    input.ancestryPolicy !== "BASE_IS_UNIQUE_MERGE_BASE_OF_HEAD" ||
    !isDiffPolicy(input.diffPolicy) ||
    typeof input.repoId !== "string" ||
    !REPO_ID.test(input.repoId) ||
    typeof input.createdAtUtc !== "string" ||
    !input.createdAtUtc.endsWith("Z") ||
    !Number.isFinite(Date.parse(input.createdAtUtc)) ||
    !isBinding(input.binding) ||
    !Array.isArray(input.changes) ||
    typeof input.limits !== "object" ||
    input.limits === null ||
    typeof input.coverage !== "object" ||
    input.coverage === null ||
    typeof artifactValue !== "object" ||
    artifactValue === null ||
    Array.isArray(artifactValue)
  ) {
    throw new SnapshotError(
      "CONTENT_UNAVAILABLE",
      "Snapshot manifest is malformed.",
    );
  }
  if (!isSnapshotLimits(input.limits as Record<string, unknown>)) {
    throw new SnapshotError(
      "CONTENT_UNAVAILABLE",
      "Snapshot limits are malformed.",
    );
  }
  const limits = input.limits as SnapshotLimits;
  const coverage = input.coverage as Record<string, unknown>;
  if (
    typeof coverage.complete !== "boolean" ||
    !Array.isArray(coverage.limitations) ||
    coverage.limitations.some((item) => typeof item !== "string")
  ) {
    throw new SnapshotError(
      "CONTENT_UNAVAILABLE",
      "Snapshot coverage is malformed.",
    );
  }
  if (
    !Number.isSafeInteger(input.treeEntryCount) ||
    (input.treeEntryCount as number) < 0 ||
    (input.treeEntryCount as number) > limits.maxTreeEntries ||
    !Number.isSafeInteger(input.packedObjectCount) ||
    (input.packedObjectCount as number) <= 0 ||
    (input.packedObjectCount as number) >
      (input.treeEntryCount as number) + 4 ||
    !Number.isSafeInteger(input.snapshotObjectBytes) ||
    (input.snapshotObjectBytes as number) < 0 ||
    (input.snapshotObjectBytes as number) > limits.maxSnapshotObjectBytes ||
    input.changes.length > limits.maxChangedPaths ||
    input.changes.some((change) => !isSnapshotChange(change, oidLength))
  ) {
    throw new SnapshotError(
      "CONTENT_UNAVAILABLE",
      "Snapshot entries are malformed.",
    );
  }
  const manifestChanges = input.changes as SnapshotChange[];
  const expectedLimitations = coverageLimitations(manifestChanges);
  if (
    coverage.complete !== (expectedLimitations.length === 0) ||
    coverage.limitations.join("\0") !== expectedLimitations.join("\0")
  ) {
    throw new SnapshotError(
      "CONTENT_UNAVAILABLE",
      "Snapshot coverage does not match its content descriptors.",
    );
  }
  const artifact = artifactValue as Record<string, unknown>;
  const sha256 = artifact.sha256;
  const sizeBytes = artifact.sizeBytes;
  const relativePath = artifact.relativePath;
  if (
    artifact.format !== "git-pack/2" ||
    typeof sha256 !== "string" ||
    !SHA256.test(sha256) ||
    typeof sizeBytes !== "number" ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > limits.maxSnapshotArtifactBytes ||
    relativePath !== `artifacts/sha256/${sha256.slice(0, 2)}/${sha256}`
  ) {
    throw new SnapshotError(
      "CONTENT_UNAVAILABLE",
      "Snapshot artifact reference is malformed.",
    );
  }
  const changedPathCount = manifestChanges.reduce(
    (count, change) => count + (change.status === "RENAMED" ? 2 : 1),
    0,
  );
  if (
    changedPathCount > limits.maxChangedPaths ||
    new TextEncoder().encode(canonicalJson(value)).byteLength >
      limits.maxManifestBytes ||
    manifestChanges.some((change) =>
      [
        change.pathBytesBase64,
        change.oldPathBytesBase64,
        change.base?.pathBytesBase64,
        change.head?.pathBytesBase64,
      ].some(
        (encoded) =>
          encoded !== undefined &&
          Buffer.from(encoded, "base64").byteLength > limits.maxPathBytes,
      ),
    )
  ) {
    throw new SnapshotError(
      "CONTENT_UNAVAILABLE",
      "Snapshot manifest exceeds its recorded limits.",
    );
  }
  return value as unknown as SnapshotManifest;
}

function isFullOid(value: unknown, length: number): value is string {
  return (
    typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value)
  );
}

function isDiffPolicy(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const policy = value as Record<string, unknown>;
  return (
    policy.direction === "BASE_TREE_TO_HEAD_TREE" &&
    policy.renameDetection === "git-diff-tree-M50%" &&
    policy.copyDetection === false
  );
}

function isBinding(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const binding = value as Record<string, unknown>;
  return (
    typeof binding.taskSha256 === "string" &&
    SHA256.test(binding.taskSha256) &&
    typeof binding.acceptanceCriteriaSha256 === "string" &&
    SHA256.test(binding.acceptanceCriteriaSha256) &&
    (binding.specSha256 === undefined ||
      (typeof binding.specSha256 === "string" &&
        SHA256.test(binding.specSha256)))
  );
}

function isSnapshotLimits(value: Record<string, unknown>): boolean {
  const expectedKeys = Object.keys(defaultSnapshotLimits).sort();
  if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) {
    return false;
  }
  return Object.values(value).every(
    (item) =>
      typeof item === "number" && Number.isSafeInteger(item) && item > 0,
  );
}

function isSnapshotChange(value: unknown, oidLength: number): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const change = value as Record<string, unknown>;
  const allowedStatuses = [
    "ADDED",
    "MODIFIED",
    "DELETED",
    "RENAMED",
    "TYPE_CHANGED",
  ];
  const hasRenameMetadata =
    change.oldPath !== undefined || change.oldPathBytesBase64 !== undefined;
  if (
    !allowedStatuses.includes(String(change.status)) ||
    (change.status === "RENAMED") !== hasRenameMetadata ||
    (change.status === "RENAMED" &&
      (typeof change.oldPath !== "string" ||
        typeof change.oldPathBytesBase64 !== "string")) ||
    typeof change.path !== "string" ||
    !isCanonicalPath(change.path, change.pathBytesBase64) ||
    (change.oldPath !== undefined &&
      (typeof change.oldPath !== "string" ||
        !isCanonicalPath(change.oldPath, change.oldPathBytesBase64))) ||
    (change.oldPathBytesBase64 !== undefined &&
      !isCanonicalBase64(change.oldPathBytesBase64))
  ) {
    return false;
  }
  const base = change.base;
  const head = change.head;
  if (
    (base !== undefined && !isSnapshotFileDescriptor(base, oidLength)) ||
    (head !== undefined && !isSnapshotFileDescriptor(head, oidLength))
  ) {
    return false;
  }
  if (change.status === "ADDED") {
    return (
      base === undefined &&
      head !== undefined &&
      (head as SnapshotFileDescriptor).pathBytesBase64 ===
        change.pathBytesBase64
    );
  }
  if (change.status === "DELETED") {
    return (
      base !== undefined &&
      head === undefined &&
      (base as SnapshotFileDescriptor).pathBytesBase64 ===
        change.pathBytesBase64
    );
  }
  if (change.status === "RENAMED") {
    return (
      base !== undefined &&
      head !== undefined &&
      typeof change.oldPath === "string" &&
      typeof change.oldPathBytesBase64 === "string" &&
      (base as SnapshotFileDescriptor).pathBytesBase64 ===
        change.oldPathBytesBase64 &&
      (head as SnapshotFileDescriptor).pathBytesBase64 ===
        change.pathBytesBase64
    );
  }
  return (
    base !== undefined &&
    head !== undefined &&
    (base as SnapshotFileDescriptor).pathBytesBase64 ===
      change.pathBytesBase64 &&
    (head as SnapshotFileDescriptor).pathBytesBase64 === change.pathBytesBase64
  );
}

function isSnapshotFileDescriptor(
  value: unknown,
  oidLength: number,
): value is SnapshotFileDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const descriptor = value as Record<string, unknown>;
  const contentStates = [
    "AVAILABLE",
    "BINARY",
    "LFS_POINTER",
    "TOO_LARGE",
    "INSPECTION_LIMIT",
    "SYMLINK_METADATA",
    "SUBMODULE_METADATA",
    "PATH_ENCODING_UNSUPPORTED",
  ];
  if (
    typeof descriptor.path !== "string" ||
    !isCanonicalPath(descriptor.path, descriptor.pathBytesBase64) ||
    typeof descriptor.mode !== "string" ||
    !/^[0-7]{5,6}$/.test(descriptor.mode) ||
    (descriptor.objectType !== "blob" && descriptor.objectType !== "commit") ||
    !isFullOid(descriptor.oid, oidLength) ||
    !contentStates.includes(String(descriptor.contentState))
  ) {
    return false;
  }
  if (descriptor.objectType === "blob") {
    if (
      !Number.isSafeInteger(descriptor.sizeBytes) ||
      (descriptor.sizeBytes as number) < 0 ||
      descriptor.mode === "160000" ||
      descriptor.contentState === "SUBMODULE_METADATA"
    ) {
      return false;
    }
  } else if (
    descriptor.mode !== "160000" ||
    descriptor.sizeBytes !== undefined ||
    descriptor.contentState !== "SUBMODULE_METADATA"
  ) {
    return false;
  }
  if (descriptor.contentState === "LFS_POINTER") {
    const lfs = descriptor.lfs;
    const lfsRecord =
      typeof lfs === "object" && lfs !== null && !Array.isArray(lfs)
        ? (lfs as Record<string, unknown>)
        : undefined;
    const lfsOid = lfsRecord?.oid;
    const lfsSize = lfsRecord?.sizeBytes;
    if (
      lfsRecord === undefined ||
      typeof lfsOid !== "string" ||
      !SHA256.test(lfsOid) ||
      !Number.isSafeInteger(lfsSize) ||
      (lfsSize as number) < 0
    ) {
      return false;
    }
  } else if (descriptor.lfs !== undefined) {
    return false;
  }
  return true;
}

function isCanonicalBase64(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.from(value, "base64").toString("base64") === value
  );
}

function isCanonicalPath(pathValue: unknown, encodedPath: unknown): boolean {
  if (typeof pathValue !== "string" || !isCanonicalBase64(encodedPath)) {
    return false;
  }
  const bytes = Buffer.from(encodedPath, "base64");
  if (bytes.byteLength === 0 || bytes.includes(0) || bytes[0] === 0x2f) {
    return false;
  }
  return new TextDecoder("utf-8").decode(bytes) === pathValue;
}

function snapshotFailureKey(cycleId: string, stateVersion: number): string {
  return `snapshot-failure-${hashCanonicalJson({ cycleId, stateVersion }).slice(0, 32)}`;
}

function snapshotFailureCode(
  error: unknown,
):
  | "RESOURCE_EXHAUSTED"
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "BACKEND_UNAVAILABLE" {
  if (!(error instanceof SnapshotError)) return "BACKEND_UNAVAILABLE";
  if (error.code === "LIMIT_EXCEEDED") return "RESOURCE_EXHAUSTED";
  if (
    error.code === "INVALID_ARGUMENT" ||
    error.code === "REVISION_INVALID" ||
    error.code === "ANCESTRY_VIOLATION"
  ) {
    return "INVALID_ARGUMENT";
  }
  if (error.code === "NOT_FOUND") return "NOT_FOUND";
  return "BACKEND_UNAVAILABLE";
}

function validateReadPath(value: string): void {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value
      .split("/")
      .some((part) => part === ".." || part === "" || part === ".")
  ) {
    throw new SnapshotError(
      "INVALID_ARGUMENT",
      "Snapshot paths must be relative Git paths without traversal components.",
    );
  }
}

function resolveLimits(
  overrides: Partial<SnapshotLimits> | undefined,
): SnapshotLimits {
  const limits = { ...defaultSnapshotLimits, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new SnapshotError(
        "INVALID_ARGUMENT",
        `Snapshot limit ${name} must be a positive safe integer.`,
      );
    }
  }
  return Object.freeze(limits);
}

async function resolveRepositoryPaths(
  input: SnapshotServiceOptions["repositoryPaths"],
): Promise<ReadonlyMap<string, string>> {
  const entries: Array<[string, string]> =
    typeof (input as ReadonlyMap<string, string>)[Symbol.iterator] ===
    "function"
      ? Array.from(input as ReadonlyMap<string, string>)
      : Object.entries(input as Readonly<Record<string, string>>);
  const resolved = new Map<string, string>();
  for (const [repoId, configuredPath] of entries) {
    if (!REPO_ID.test(repoId) || typeof configuredPath !== "string") {
      throw new SnapshotError(
        "INVALID_ARGUMENT",
        "Repository allowlist entry is invalid.",
      );
    }
    try {
      if (!path.isAbsolute(configuredPath))
        throw new Error("Path is not absolute.");
      const stat = await lstat(configuredPath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Path is not a real directory.");
      }
      resolved.set(repoId, await realpath(configuredPath));
    } catch (error) {
      throw new SnapshotError(
        "REPOSITORY_UNAVAILABLE",
        "An allowlisted repository path is unavailable or unsafe.",
        error,
      );
    }
  }
  return resolved;
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
