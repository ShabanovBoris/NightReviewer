import type { ArtifactReference, SqliteStorage } from "../storage";

export interface SnapshotLimits {
  readonly maxChangedPaths: number;
  readonly maxTreeEntries: number;
  readonly maxBlobReadBytes: number;
  readonly maxContentInspectionBytes: number;
  readonly maxSnapshotObjectBytes: number;
  readonly maxTreeOutputBytes: number;
  readonly maxDiffOutputBytes: number;
  readonly maxPathBytes: number;
  readonly maxStderrBytes: number;
  readonly maxManifestBytes: number;
  readonly maxSnapshotArtifactBytes: number;
  readonly maxCreationTimeMs: number;
}

export const defaultSnapshotLimits: SnapshotLimits = Object.freeze({
  maxChangedPaths: 10_000,
  maxTreeEntries: 100_000,
  maxBlobReadBytes: 1_048_576,
  maxContentInspectionBytes: 16_777_216,
  maxSnapshotObjectBytes: 268_435_456,
  maxTreeOutputBytes: 67_108_864,
  maxDiffOutputBytes: 16_777_216,
  maxPathBytes: 4_096,
  maxStderrBytes: 65_536,
  maxManifestBytes: 8_388_608,
  maxSnapshotArtifactBytes: 134_217_728,
  maxCreationTimeMs: 120_000,
});

export type SnapshotChangeStatus =
  | "ADDED"
  | "MODIFIED"
  | "DELETED"
  | "RENAMED"
  | "TYPE_CHANGED";

export type SnapshotContentState =
  | "AVAILABLE"
  | "BINARY"
  | "LFS_POINTER"
  | "TOO_LARGE"
  | "INSPECTION_LIMIT"
  | "SYMLINK_METADATA"
  | "SUBMODULE_METADATA"
  | "PATH_ENCODING_UNSUPPORTED";

export interface SnapshotFileDescriptor {
  readonly path: string;
  readonly pathBytesBase64: string;
  readonly mode: string;
  readonly objectType: "blob" | "commit";
  readonly oid: string;
  readonly sizeBytes?: number;
  readonly contentState: SnapshotContentState;
  readonly lfs?: {
    readonly oid: string;
    readonly sizeBytes: number;
  };
}

export interface SnapshotChange {
  readonly status: SnapshotChangeStatus;
  /** Current path, or the deleted path for a deletion. */
  readonly path: string;
  readonly pathBytesBase64: string;
  readonly oldPath?: string;
  readonly oldPathBytesBase64?: string;
  readonly base?: SnapshotFileDescriptor;
  readonly head?: SnapshotFileDescriptor;
}

export interface SnapshotManifest {
  readonly schemaVersion: "nr-git-snapshot/1";
  readonly snapshotId: string;
  readonly cycleId: string;
  readonly repoId: string;
  readonly objectFormat: "sha1" | "sha256";
  readonly baseSha: string;
  readonly headSha: string;
  readonly mergeBaseSha: string;
  readonly ancestryPolicy: "BASE_IS_UNIQUE_MERGE_BASE_OF_HEAD";
  readonly diffPolicy: {
    readonly direction: "BASE_TREE_TO_HEAD_TREE";
    readonly renameDetection: "git-diff-tree-M50%";
    readonly copyDetection: false;
  };
  readonly baseTreeSha: string;
  readonly headTreeSha: string;
  readonly createdAtUtc: string;
  readonly binding: {
    readonly taskSha256: string;
    readonly acceptanceCriteriaSha256: string;
    readonly specSha256?: string;
  };
  readonly changes: readonly SnapshotChange[];
  readonly coverage: {
    readonly complete: boolean;
    readonly limitations: readonly string[];
  };
  readonly limits: SnapshotLimits;
  readonly treeEntryCount: number;
  readonly packedObjectCount: number;
  readonly snapshotObjectBytes: number;
  readonly snapshotArtifact: ArtifactReference & {
    readonly format: "git-pack/2";
  };
}

export interface CreateSnapshotInput {
  readonly cycleId: string;
  readonly specSha256?: string;
}

export interface SnapshotServiceOptions {
  readonly store: SqliteStorage;
  readonly callerId?: string;
  /** Trusted local source paths keyed only by protocol repoId. */
  readonly repositoryPaths:
    | ReadonlyMap<string, string>
    | Readonly<Record<string, string>>;
  readonly limits?: Partial<SnapshotLimits>;
}

export interface SnapshotReadResult {
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
  readonly contentState: SnapshotContentState;
  readonly bytes: Uint8Array;
}

export interface SnapshotReader {
  readonly manifest: SnapshotManifest;
  readonly diff: readonly SnapshotChange[];
  readFile(path: string, side: "base" | "head"): Promise<SnapshotReadResult>;
  close(): Promise<void>;
}

export interface SnapshotService {
  createSnapshot(input: CreateSnapshotInput): Promise<SnapshotManifest>;
  openSnapshot(cycleId: string, snapshotId: string): Promise<SnapshotReader>;
}
