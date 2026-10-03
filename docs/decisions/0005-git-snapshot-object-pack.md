# ADR 0005 — Immutable Git object snapshots

- Status: implemented in NR-05 assignment D121; independent review and lead acceptance pending.
- Date: 2026-10-03.
- Scope: resolve review-cycle commits from configured local repositories, capture an immutable base-to-head diff, and retain exact Git objects for later reads.
- Authority: Lead assignment `NR-05-C1-D121-GIT-SNAPSHOTS-REVIEW-MANIFEST`.

## Context

NR-03 pins full base and head object IDs in each review cycle. A worktree and index can change after submission, and the source repository can be garbage-collected or removed. NR-04 already provides immutable `snapshots` rows, content-addressed artifacts, append-only events, backup, and restore; NR-05 must preserve that single persistence boundary.

## Decisions

### Repository and Git authority

- Resolve `repoId` only through an injected trusted local path allowlist. Canonicalize those paths when the service is created; reject a worktree whose Git directory or object directory escapes the allowlisted repository, object alternates, and graft files.
- Resolve the pinned full object IDs as commits in the declared object format. Require the base to be the unique merge base of head. Compare the exact base and head trees with Git rename detection at `-M50%`; do not run copy detection.
- Run Git only as argument arrays through `Bun.spawn`. Use an isolated environment, private temporary home and hook directory, disable hooks and lazy object fetch, and turn off external diff and text conversion. Do not consult the mutable worktree or index.
- Retain Git path bytes in base64 as well as a readable path string. A file path is never used as a filesystem path or Git argument when reading snapshot content.

### Retained object format

- Store an app-owned Git pack containing the exact base/head commits, their trees, and blobs reachable from those two trees. The pack does not include unrelated commit history. Its SHA-256 content-addressed artifact is registered in NR-04 `raw_artifacts`; the canonical manifest and artifact identity are recorded in the existing immutable `snapshots` row. No new registry or schema migration is introduced.
- On read, verify the artifact reference, import the pack into a private temporary bare repository, validate its object inventory, and read file blobs by full object ID. Symlink blobs are returned only as link-target metadata; submodule gitlinks are metadata only and are never traversed.
- Bind task and acceptance-criteria hashes, optional spec hash, exact commits and trees, merge-base policy, rename policy, stable changed paths, object counts, UTC creation time, artifact identity, and coverage limits in the manifest.

### Bounds and coverage

- Apply finite limits to changed paths, combined tree entries and output, path bytes, individually readable blobs, content inspection bytes, manifest bytes, compressed pack bytes, uncompressed object bytes, Git stderr, and snapshot creation time.
- Record binary content, oversized content, LFS pointers without fetched payloads, submodules, unsupported path encodings, and inspection-limit exclusions explicitly. Any such changed content gap makes coverage incomplete. No LFS fetch or submodule operation is performed.
- If a bound, ancestry rule, object check, or durable write fails during an active snapshot attempt, atomically advance the pinned cycle to `FAILED` before any reviewer scheduling and return a typed error. A call made for a cycle that is not in `SNAPSHOTTING` is rejected without changing that cycle. Temporary workspaces are removed; if artifact publication outlives a failed database commit, NR-04 reconciliation remains responsible for reporting the orphan.

## Consequences

- Reads and diff metadata remain bound to commits after source worktree/index mutation, source deletion, or source garbage collection.
- Readers retain exact tree and blob objects without carrying unrelated history. Commit parent references remain in the original commit objects, but ancestry proof and the review diff are captured in the manifest before source loss.
- Snapshots over configured object or artifact limits fail closed. Review approval remains blocked when the manifest records incomplete content coverage.

## Validation

Focused fixtures cover changed-path statuses, rename detection, binary/LFS/large files, symlink and submodule boundaries, option-like paths/revisions, worktree mutation, garbage collection, source removal, backup/restore, and exact object reads. Exact Bun 1.4.2 checks and reviewer evidence will be recorded in `docs/evidence/NR-05.json` and the PR comments.

## Rollback

Do not delete artifacts referenced by persisted snapshots. Revert the reviewed PR through a new change; the existing immutable snapshot rows and artifacts remain subject to NR-04 backup and reconciliation rules.
