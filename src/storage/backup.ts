import { Database } from "bun:sqlite";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../protocol";
import { invalidArgument, needsReconciliation, StorageError } from "./errors";
import {
  DATABASE_FILE_NAME,
  ensureEmptyOwnedDirectory,
  ensurePrivateChildDirectory,
  MANIFEST_FILE_NAME,
  makeUtcTimestamp,
  persistArtifactFile,
  readVerifiedArtifact,
  sha256Hex,
  writeAtomicFile,
} from "./files";
import type { ArtifactReference, BackupManifest } from "./types";

interface RawArtifactRow {
  sha256: string;
  relative_path: string;
  byte_size: number;
}

export async function createBackupAt(
  rootDir: string,
  db: Database,
  destinationDir: string,
  schemaVersion: number,
): Promise<BackupManifest> {
  const destination = await ensureEmptyOwnedDirectory(destinationDir);

  db.exec("BEGIN");
  let databaseBytes: Uint8Array;
  let artifactRows: RawArtifactRow[];
  try {
    const currentSchema = db.query("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    if (Number(currentSchema?.user_version ?? -1) !== schemaVersion) {
      throw new StorageError(
        "CONFLICT",
        "Schema changed while preparing the consistent backup.",
      );
    }
    artifactRows = hasTable(db, "raw_artifacts")
      ? (db
          .query(
            `SELECT sha256, relative_path, byte_size FROM raw_artifacts ORDER BY relative_path`,
          )
          .all() as RawArtifactRow[])
      : [];
    databaseBytes = db.serialize();
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }

  await writeAtomicFile(destination, DATABASE_FILE_NAME, databaseBytes);
  const databasePath = path.join(destination, DATABASE_FILE_NAME);
  const portableDatabase = new Database(databasePath);
  try {
    const journalMode = portableDatabase
      .query("PRAGMA journal_mode = DELETE")
      .get() as { journal_mode?: string } | undefined;
    if (String(journalMode?.journal_mode ?? "").toLowerCase() !== "delete") {
      throw new StorageError(
        "IO_ERROR",
        "Backup database could not be normalized for portable read-only access.",
      );
    }
  } finally {
    portableDatabase.close(true);
  }
  databaseBytes = new Uint8Array(await Bun.file(databasePath).arrayBuffer());
  const databaseRef: BackupManifest["database"] = {
    fileName: DATABASE_FILE_NAME,
    relativePath: DATABASE_FILE_NAME,
    sha256: sha256Hex(databaseBytes),
    sizeBytes: databaseBytes.byteLength,
  };
  const artifactReferences: ArtifactReference[] = [];
  for (const row of artifactRows) {
    const sourceReference: ArtifactReference = {
      sha256: row.sha256,
      relativePath: row.relative_path,
      sizeBytes: row.byte_size,
    };
    const bytes = await readVerifiedArtifact(rootDir, sourceReference);
    const copied = await persistArtifactFile(destination, bytes);
    if (
      copied.sha256 !== sourceReference.sha256 ||
      copied.sizeBytes !== sourceReference.sizeBytes ||
      copied.relativePath !== sourceReference.relativePath
    ) {
      throw needsReconciliation(
        "Backup artifact copy changed its content identity.",
      );
    }
    artifactReferences.push(copied);
  }

  const manifest: BackupManifest = {
    formatVersion: 1,
    schemaVersion,
    database: databaseRef,
    artifacts: artifactReferences,
  };
  await writeAtomicFile(
    destination,
    MANIFEST_FILE_NAME,
    Buffer.from(canonicalJson(manifest), "utf8"),
  );
  await verifyBackupAt(destination, manifest);
  return manifest;
}

export async function createMigrationBackup(
  rootDir: string,
  db: Database,
  fromVersion: number,
  toVersion: number,
): Promise<string> {
  const parent = await ensurePrivateChildDirectory(
    rootDir,
    "migration-backups",
  );
  const compactUtc = makeUtcTimestamp().replace(/[-:.]/g, "").replace("Z", "Z");
  const name = `schema-${fromVersion}-to-${toVersion}-${compactUtc}`;
  const destination = `${parent}/${name}`;
  await createBackupAt(rootDir, db, destination, fromVersion);
  return destination;
}

export async function verifyBackupAt(
  backupDir: string,
  expectedManifest?: BackupManifest,
): Promise<BackupManifest> {
  const root = path.resolve(backupDir);
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw needsReconciliation("Backup root must be a real directory.");
    }
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw needsReconciliation("Backup root is missing or unreadable.");
  }
  const manifestPath = `${root}/${MANIFEST_FILE_NAME}`;
  let rawManifest: Uint8Array;
  try {
    const info = await lstat(manifestPath);
    if (info.isSymbolicLink() || !info.isFile())
      throw invalidArgument("Backup manifest is not a regular file.");
    rawManifest = new Uint8Array(await Bun.file(manifestPath).arrayBuffer());
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw needsReconciliation("Backup manifest is missing or unreadable.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawManifest));
  } catch {
    throw needsReconciliation("Backup manifest is not valid JSON.");
  }
  const manifest = parseBackupManifest(parsed);
  if (
    expectedManifest !== undefined &&
    canonicalJson(expectedManifest) !== canonicalJson(manifest)
  ) {
    throw needsReconciliation("Backup manifest changed after creation.");
  }
  if (canonicalJson(manifest) !== new TextDecoder().decode(rawManifest)) {
    throw needsReconciliation(
      "Backup manifest is not in deterministic canonical form.",
    );
  }

  const databasePath = `${root}/${DATABASE_FILE_NAME}`;
  try {
    const info = await lstat(databasePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw needsReconciliation("Backup database must be a regular file.");
    }
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw needsReconciliation("Backup database is missing or unreadable.");
  }
  const databaseBytes = new Uint8Array(
    await Bun.file(databasePath).arrayBuffer(),
  );
  if (
    databaseBytes.byteLength !== manifest.database.sizeBytes ||
    sha256Hex(databaseBytes) !== manifest.database.sha256
  ) {
    throw needsReconciliation(
      "Backup database hash or size does not match the manifest.",
    );
  }

  const db = new Database(databasePath, { readonly: true, create: false });
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const integrity = db.query("PRAGMA integrity_check").get() as
      | { integrity_check?: string }
      | undefined;
    if (integrity?.integrity_check !== "ok") {
      throw needsReconciliation(
        "Backup database failed SQLite integrity_check.",
      );
    }
    const currentSchema = db.query("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    if (Number(currentSchema?.user_version ?? -1) !== manifest.schemaVersion) {
      throw needsReconciliation(
        "Backup schema version does not match the manifest.",
      );
    }
    const foreignKeyProblems = db.query("PRAGMA foreign_key_check").all();
    if (foreignKeyProblems.length > 0) {
      throw needsReconciliation(
        "Backup database contains invalid foreign-key references.",
      );
    }
    const databaseArtifacts = hasTable(db, "raw_artifacts")
      ? (db
          .query(
            `SELECT sha256, relative_path, byte_size FROM raw_artifacts ORDER BY relative_path`,
          )
          .all() as RawArtifactRow[])
      : [];
    if (databaseArtifacts.length !== manifest.artifacts.length) {
      throw needsReconciliation(
        "Backup artifact manifest does not cover every database reference.",
      );
    }
    for (const [index, row] of databaseArtifacts.entries()) {
      const listed = manifest.artifacts[index];
      if (
        listed === undefined ||
        listed.sha256 !== row.sha256 ||
        listed.relativePath !== row.relative_path ||
        listed.sizeBytes !== row.byte_size
      ) {
        throw needsReconciliation(
          "Backup artifact list differs from database references.",
        );
      }
      await readVerifiedArtifact(root, listed);
    }
  } finally {
    db.close(true);
  }
  return manifest;
}

export function parseBackupManifest(value: unknown): BackupManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw needsReconciliation("Backup manifest must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.formatVersion !== 1 ||
    !Number.isSafeInteger(record.schemaVersion) ||
    typeof record.database !== "object" ||
    record.database === null ||
    Array.isArray(record.database) ||
    !Array.isArray(record.artifacts)
  ) {
    throw needsReconciliation("Backup manifest fields are malformed.");
  }
  const database = record.database as Record<string, unknown>;
  if (database.fileName !== DATABASE_FILE_NAME) {
    throw needsReconciliation("Backup manifest database file name is invalid.");
  }
  const parsedDatabase = parseArtifactReference(database);
  if (parsedDatabase.relativePath !== DATABASE_FILE_NAME) {
    throw needsReconciliation(
      "Backup database path must be the fixed owned file.",
    );
  }
  const artifacts = record.artifacts.map(parseArtifactReference);
  const sorted = [...artifacts].sort((left, right) =>
    compareOrdinal(left.relativePath, right.relativePath),
  );
  if (
    artifacts.some(
      (artifact, index) =>
        artifact.relativePath !== sorted[index]?.relativePath,
    )
  ) {
    throw needsReconciliation(
      "Backup artifacts are not deterministically sorted.",
    );
  }
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    if (seen.has(artifact.relativePath)) {
      throw needsReconciliation(
        "Backup manifest contains duplicate artifact paths.",
      );
    }
    seen.add(artifact.relativePath);
  }
  return {
    formatVersion: 1,
    schemaVersion: record.schemaVersion as number,
    database: { ...parsedDatabase, fileName: DATABASE_FILE_NAME },
    artifacts,
  };
}

function parseArtifactReference(value: unknown): ArtifactReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw needsReconciliation("Backup artifact entry must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.sha256) ||
    typeof record.relativePath !== "string" ||
    typeof record.sizeBytes !== "number" ||
    !Number.isSafeInteger(record.sizeBytes) ||
    record.sizeBytes < 0
  ) {
    throw needsReconciliation(
      "Backup artifact entry has invalid hash, path, or size.",
    );
  }
  if (
    record.relativePath.startsWith("/") ||
    record.relativePath.split("/").some((part) => part === ".." || part === "")
  ) {
    throw needsReconciliation(
      "Backup artifact entry path is not a safe owned relative path.",
    );
  }
  return {
    sha256: record.sha256,
    relativePath: record.relativePath,
    sizeBytes: record.sizeBytes,
  };
}

function hasTable(db: Database, tableName: string): boolean {
  return (
    db
      .query(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(tableName) != null
  );
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
