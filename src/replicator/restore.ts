import { createHash } from "node:crypto";
import { compactVerify } from "jose";
import { z } from "zod";
import {
  backupKeys,
  changeRecordSchema,
  checkpointManifestSchema,
  parseChangeKey,
  sha256Schema,
  type BackupObject,
  type CheckpointManifest,
} from "../domain/backup";
import { demand, DomainError } from "../domain/model";
import { preparedEnvelopeSchema, recoverySignatureSchema } from "../domain/recovery";
import {
  hashEnvelope,
  parseEnvelopeJson,
  RECOVERY_CANONICALIZATION_VERSION,
  RECOVERY_HASH_ALGORITHM,
  RECOVERY_SCHEMA_VERSION,
  type RecoveryVerificationKey,
} from "../domain/recovery-canonical";
import type { BackupArchive } from "../storage/backup-archive";
import { readSchemaIdentity } from "../storage/backup-ledger";
import { createRecoveryStore } from "../storage/recovery-store";
import { readStreamChunks } from "../storage/recovery-streams";

/** D1 binds at most 100 parameters per statement. */
const MAX_BOUND_PARAMETERS = 100;
const STATEMENTS_PER_BATCH = 50;

export type RestoreMigration = Readonly<{ name: string; sql: readonly string[] }>;
export type RestoreInput = Readonly<{
  backup: Pick<BackupArchive, "list" | "readBytes">;
  /** Raw read of backup objects for streaming file copies. */
  backupBucket: R2Bucket;
  target: Readonly<{ db: D1Database; originals: R2Bucket }>;
  ownerId: string;
  workspaceId: string;
  /** Restore through this sequence; null restores everything available. */
  targetSequence: string | null;
  /** Ordered migrations that may be needed to replay newer changes. */
  migrations: readonly RestoreMigration[];
  migrationLedger: "d1_migrations" | "runtime_migrations";
  restoreId: string;
  clock: () => number;
  /** When given, an unsigned or wrongly signed checkpoint is rejected. */
  trust: RecoveryVerificationKey | null;
}>;
export type RestoreReport = Readonly<{
  format: "recovery-restore-report-v1";
  restoreId: string;
  workspace: Readonly<{ ownerId: string; workspaceId: string }>;
  checkpoint: Readonly<{ checkpointId: string; sequence: string; signed: boolean }>;
  replayed: Readonly<{ count: number; through: string; commitTimes: readonly Readonly<{ sequence: string; original: number | null }>[] }>;
  restoredThrough: Readonly<{ sequence: string; transactionDigest: string | null }>;
  targetSequence: string | null;
  schema: Readonly<{ fingerprint: string; migrationsApplied: readonly string[] }>;
  files: Readonly<{ count: number; bytes: number }>;
  outcome: "complete" | "partial";
  stoppedAt: Readonly<{ sequence: string; reason: string }> | null;
  startedAt: number;
  completedAt: number;
}>;

const lessOrEqual = (left: string, right: string) => BigInt(left) <= BigInt(right);
function unsigned<T extends { readonly signature: unknown }>(value: T): Omit<T, "signature"> {
  const { signature: omitted, ...payload } = value;
  void omitted;
  return payload;
}
function decodeValue(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const encoded = z.object({ $base64: z.string() }).strict().parse(value).$base64;
    return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  }
  return value;
}

async function chooseCheckpoint(input: RestoreInput) {
  const candidates: { manifest: CheckpointManifest; signed: boolean }[] = [];
  for (const kind of ["daily", "monthly"] as const) {
    let cursor: string | null = null;
    do {
      const page = await input.backup.list(backupKeys.checkpointPrefix(kind, input.workspaceId), cursor);
      for (const object of page.objects) {
        if (!object.key.endsWith("/manifest.json")) continue;
        const stored = await input.backup.readBytes(object.key);
        if (stored === null) continue;
        const manifest = checkpointManifestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(stored.bytes)));
        if (manifest.workspace.workspaceId !== input.workspaceId || manifest.workspace.ownerId !== input.ownerId) continue;
        if (input.targetSequence !== null && !lessOrEqual(manifest.position.sequence, input.targetSequence)) continue;
        const signed = await verifyCheckpointSignature(input, object.key.replace(/manifest\.json$/, "manifest.sig"), stored.sha256);
        if (input.trust !== null && !signed) continue;
        candidates.push({ manifest, signed });
      }
      cursor = page.cursor;
    } while (cursor !== null);
  }
  candidates.sort(
    (left, right) =>
      Number(BigInt(right.manifest.position.sequence) - BigInt(left.manifest.position.sequence)) ||
      right.manifest.createdAt - left.manifest.createdAt,
  );
  const chosen = candidates[0];
  demand(chosen !== undefined, "NO_RESTORABLE_CHECKPOINT", 404);
  return chosen;
}
async function verifyCheckpointSignature(input: RestoreInput, key: string, manifestSha256: string): Promise<boolean> {
  if (input.trust === null) return false;
  const stored = await input.backup.readBytes(key);
  if (stored === null) return false;
  try {
    const parsed = z
      .object({ format: z.literal("recovery-checkpoint-signature-v1"), manifestSha256: sha256Schema, signature: recoverySignatureSchema })
      .strict()
      .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(stored.bytes)));
    if (parsed.manifestSha256 !== manifestSha256) return false;
    await verifyRecoverySignatureForDigest(parsed.signature, manifestSha256, input.trust);
    return true;
  } catch {
    return false;
  }
}
/** A checkpoint binding signs the SHA-256 of the exact manifest bytes. */
async function verifyRecoverySignatureForDigest(
  signature: z.infer<typeof recoverySignatureSchema>,
  digest: string,
  trust: RecoveryVerificationKey,
) {
  demand(signature.keyId === trust.keyId && signature.algorithm === trust.algorithm, "SIGNATURE_POLICY_MISMATCH");
  const verified = await compactVerify(signature.jws, trust.publicKey, { algorithms: [trust.algorithm] });
  demand(
    verified.protectedHeader.kid === trust.keyId && verified.protectedHeader.typ === "job-stack-recovery+jws",
    "SIGNATURE_POLICY_MISMATCH",
  );
  const binding = z
    .object({
      schemaVersion: z.literal(RECOVERY_SCHEMA_VERSION),
      canonicalizationVersion: z.literal(RECOVERY_CANONICALIZATION_VERSION),
      hashAlgorithm: z.literal(RECOVERY_HASH_ALGORITHM),
      purpose: z.literal("checkpoint"),
      digest: sha256Schema,
    })
    .strict()
    .parse(parseEnvelopeJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(verified.payload)));
  demand(binding.digest === digest, "SIGNATURE_POLICY_MISMATCH");
}

async function assertEmpty(db: D1Database) {
  const row = await db
    .prepare("SELECT count(*) AS objects FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
    .first<{ objects: number }>();
  demand(row?.objects === 0, "RESTORE_TARGET_NOT_EMPTY", 409);
}

async function loadCheckpoint(input: RestoreInput, manifest: CheckpointManifest) {
  const db = input.target.db;
  const quote = (identifier: string) => `"${identifier}"`;
  const tableDdl = manifest.ddl.filter((entry) => entry.type === "table");
  const ordered = [
    ...manifest.tables.map((table) => tableDdl.find((entry) => entry.name === table.name)),
    ...tableDdl.filter((entry) => !manifest.tables.some((table) => table.name === entry.name)),
  ];
  for (const entry of ordered) if (entry !== undefined) await db.prepare(entry.sql).run();
  for (const entry of manifest.ddl.filter((candidate) => candidate.type === "index")) await db.prepare(entry.sql).run();
  for (const table of manifest.tables) {
    const stored = await input.backup.readBytes(table.objectKey);
    demand(stored !== null, "BACKUP_OBJECT_MISSING", 503);
    demand(stored.sha256 === table.sha256 && stored.bytes.byteLength === table.sizeBytes, "BACKUP_INTEGRITY_FAULT", 500);
    const lines = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(stored.bytes).split("\n").filter((line) => line.length > 0);
    const header = z
      .object({ table: z.literal(table.name), columns: z.array(z.string()) })
      .strict()
      .parse(JSON.parse(lines[0] ?? "null"));
    demand(header.columns.join(",") === table.columns.join(","), "CHECKPOINT_COLUMNS_MISMATCH", 500);
    const rows = lines.slice(1).map((line) => z.array(z.unknown()).length(table.columns.length).parse(JSON.parse(line)).map(decodeValue));
    demand(rows.length === table.rows, "CHECKPOINT_ROW_COUNT_MISMATCH", 500);
    demand(table.columns.length <= MAX_BOUND_PARAMETERS, "CHECKPOINT_TABLE_TOO_WIDE", 500);
    const perStatement = Math.max(1, Math.floor(MAX_BOUND_PARAMETERS / table.columns.length));
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < rows.length; index += perStatement) {
      const chunk = rows.slice(index, index + perStatement);
      const placeholders = chunk.map(() => `(${table.columns.map(() => "?").join(",")})`).join(",");
      statements.push(
        db
          .prepare(`INSERT INTO ${quote(table.name)}(${table.columns.map(quote).join(",")}) VALUES ${placeholders}`)
          .bind(...chunk.flat()),
      );
    }
    for (let index = 0; index < statements.length; index += STATEMENTS_PER_BATCH)
      await db.batch(statements.slice(index, index + STATEMENTS_PER_BATCH));
    const loaded = await db.prepare(`SELECT count(*) AS rows FROM ${quote(table.name)}`).first<{ rows: number }>();
    demand(loaded?.rows === table.rows, "RESTORE_ROW_COUNT_MISMATCH", 500);
  }
  // Integrity triggers return only after the historical rows are in place.
  for (const entry of manifest.ddl.filter((candidate) => candidate.type === "trigger" || candidate.type === "view"))
    await db.prepare(entry.sql).run();
  const identity = await readSchemaIdentity(db);
  demand(identity.fingerprint === manifest.schemaFingerprint, "RESTORE_SCHEMA_MISMATCH", 500);
}

async function listChanges(input: RestoreInput, after: string) {
  const changes: { key: string; sequence: string; transactionDigest: string }[] = [];
  let cursor: string | null = null;
  do {
    const page = await input.backup.list(backupKeys.changePrefix(input.workspaceId), cursor);
    for (const object of page.objects) {
      const parsed = parseChangeKey(object.key);
      if (parsed === null || parsed.workspaceId !== input.workspaceId) continue;
      if (!lessOrEqual(parsed.sequence, after) && (input.targetSequence === null || lessOrEqual(parsed.sequence, input.targetSequence)))
        changes.push({ key: object.key, sequence: parsed.sequence, transactionDigest: parsed.transactionDigest });
    }
    cursor = page.cursor;
  } while (cursor !== null);
  return changes.sort((left, right) => Number(BigInt(left.sequence) - BigInt(right.sequence)));
}

async function appliedMigrations(input: RestoreInput): Promise<Set<string>> {
  const exists = await input.target.db
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?")
    .bind(input.migrationLedger)
    .first();
  if (exists === null) return new Set();
  const rows = await input.target.db.prepare(`SELECT name FROM "${input.migrationLedger}"`).all<{ name: string }>();
  return new Set(rows.results.map((row) => row.name));
}
/** Apply the next unapplied migrations, in order, until the schema matches. */
async function migrateTo(input: RestoreInput, fingerprint: string, applied: string[]): Promise<boolean> {
  const done = await appliedMigrations(input);
  for (const migration of input.migrations) {
    if ((await readSchemaIdentity(input.target.db)).fingerprint === fingerprint) return true;
    if (done.has(migration.name)) continue;
    await input.target.db.batch(migration.sql.map((statement) => input.target.db.prepare(statement)));
    if (input.migrationLedger === "runtime_migrations")
      await input.target.db.prepare("INSERT INTO runtime_migrations(name) VALUES(?)").bind(migration.name).run();
    else
      await input.target.db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(migration.name).run();
    done.add(migration.name);
    applied.push(migration.name);
  }
  return (await readSchemaIdentity(input.target.db)).fingerprint === fingerprint;
}

/** Copy one verified backup object to the new originals bucket and record the
 * alias from its pinned identity to the version the restore created. */
async function restoreObject(input: RestoreInput, object: BackupObject, now: number) {
  const storageKey = `${object.object.namespace}/${object.object.key}`;
  const existing = await input.target.db
    .prepare("SELECT sha256 FROM recovery_restored_objects WHERE storage_key=? AND original_version_id=?")
    .bind(storageKey, object.object.versionId)
    .first<{ sha256: string }>();
  if (existing !== null) {
    demand(existing.sha256 === object.sha256, "RESTORE_ALIAS_CONFLICT", 500);
    return 0;
  }
  const source = await input.backupBucket.get(object.backupKey);
  demand(source !== null, "BACKUP_OBJECT_MISSING", 503);
  demand(source.size === object.sizeBytes, "BACKUP_INTEGRITY_FAULT", 500);
  let written = await input.target.originals.head(storageKey);
  if (written === null) {
    written = await input.target.originals.put(storageKey, source.body, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: object.sha256,
      httpMetadata: { contentType: "application/octet-stream" },
    });
    if (written === null) written = await input.target.originals.head(storageKey);
  } else await source.body.cancel().catch(() => undefined);
  demand(written !== null, "RESTORE_WRITE_FAILED", 503);
  const readBack = await input.target.originals.get(storageKey);
  demand(readBack !== null && readBack.version === written.version, "RESTORE_WRITE_FAILED", 503);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of readStreamChunks(readBack.body)) {
    size += chunk.byteLength;
    hash.update(chunk);
  }
  demand(size === object.sizeBytes && hash.digest("hex") === object.sha256, "RESTORE_INTEGRITY_FAULT", 500);
  await input.target.db
    .prepare(
      "INSERT INTO recovery_restored_objects(storage_key,original_version_id,restored_version_id,sha256,size_bytes,restore_id,restored_at) VALUES(?,?,?,?,?,?,?)",
    )
    .bind(storageKey, object.object.versionId, written.version, object.sha256, object.sizeBytes, input.restoreId, now)
    .run();
  return object.sizeBytes;
}

/** Never in place: the target database must be empty. Restores the newest
 * verified checkpoint at or before the target, replays later changes through
 * the production commit path, then restores and re-hashes every file. */
export async function restoreFromBackup(input: RestoreInput): Promise<RestoreReport> {
  const startedAt = input.clock();
  await assertEmpty(input.target.db);
  const { manifest, signed } = await chooseCheckpoint(input);
  await loadCheckpoint(input, manifest);
  const store = createRecoveryStore(input.target.db, input.ownerId);
  const migrationsApplied: string[] = [];
  const replayedObjects: BackupObject[] = [];
  const commitTimes: { sequence: string; original: number | null }[] = [];
  let through = manifest.position.sequence;
  let throughDigest = manifest.position.transactionDigest;
  let stoppedAt: RestoreReport["stoppedAt"] = null;
  for (const change of await listChanges(input, manifest.position.sequence)) {
    const expected = (BigInt(through) + 1n).toString();
    if (change.sequence !== expected) {
      stoppedAt = { sequence: expected, reason: "change_gap" };
      break;
    }
    try {
      const stored = await input.backup.readBytes(change.key);
      demand(stored !== null, "BACKUP_OBJECT_MISSING", 503);
      const record = changeRecordSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(stored.bytes)));
      const envelope = preparedEnvelopeSchema.parse(parseEnvelopeJson(JSON.stringify(record.envelope)));
      demand(
        record.sequence === change.sequence &&
          record.transactionDigest === change.transactionDigest &&
          record.previousDigest === throughDigest &&
          (await hashEnvelope("transaction", unsigned(envelope))) === record.transactionDigest,
        "CHANGE_LINK_BROKEN",
        500,
      );
      if (!(await migrateTo(input, record.schemaFingerprint, migrationsApplied))) {
        stoppedAt = { sequence: change.sequence, reason: "schema_migration_required" };
        break;
      }
      await store.commitPrepared(envelope);
      replayedObjects.push(...record.objects);
      commitTimes.push({ sequence: record.sequence, original: record.committedAt });
      through = record.sequence;
      throughDigest = record.transactionDigest;
    } catch (error) {
      stoppedAt = {
        sequence: change.sequence,
        reason: error instanceof DomainError ? error.code.toLowerCase() : error instanceof Error ? "replay_rejected" : "replay_failed",
      };
      break;
    }
  }
  if (stoppedAt === null && input.targetSequence !== null && through !== input.targetSequence)
    stoppedAt = { sequence: (BigInt(through) + 1n).toString(), reason: "change_unavailable" };
  // Files: everything the restored history references, from the checkpoint's
  // byte-identity rows plus the objects of each replayed change.
  const checkpointObjects = (
    await input.target.db
      .prepare("SELECT storage_key,version_id,sha256,size_bytes,backup_key FROM recovery_backup_objects WHERE owner=? AND workspace_id=?")
      .bind(input.ownerId, input.workspaceId)
      .all<{ storage_key: string; version_id: string; sha256: string; size_bytes: number; backup_key: string }>()
  ).results.map((row) => {
    const slash = row.storage_key.indexOf("/");
    return {
      object: { provider: "primary" as const, namespace: row.storage_key.slice(0, slash), key: row.storage_key.slice(slash + 1), versionId: row.version_id },
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
      backupKey: row.backup_key,
    };
  });
  let files = 0;
  let bytes = 0;
  const now = input.clock();
  const seen = new Set<string>();
  for (const object of [...checkpointObjects, ...replayedObjects]) {
    const identity = JSON.stringify([object.object.namespace, object.object.key, object.object.versionId]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    bytes += await restoreObject(input, object, now);
    files += 1;
  }
  return {
    format: "recovery-restore-report-v1",
    restoreId: input.restoreId,
    workspace: { ownerId: input.ownerId, workspaceId: input.workspaceId },
    checkpoint: { checkpointId: manifest.checkpointId, sequence: manifest.position.sequence, signed },
    replayed: { count: commitTimes.length, through, commitTimes },
    restoredThrough: { sequence: through, transactionDigest: throughDigest },
    targetSequence: input.targetSequence,
    schema: { fingerprint: (await readSchemaIdentity(input.target.db)).fingerprint, migrationsApplied },
    files: { count: files, bytes },
    outcome: stoppedAt === null ? "complete" : "partial",
    stoppedAt,
    startedAt,
    completedAt: input.clock(),
  };
}
