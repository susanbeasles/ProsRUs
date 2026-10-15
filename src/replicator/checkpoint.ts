import {
  backupKeys,
  checkpointId as checkpointIdFor,
  checkpointManifestSchema,
  checkpointPeriod,
  type CheckpointKind,
  type CheckpointManifest,
  type CheckpointTable,
} from "../domain/backup";
import { demand, DomainError } from "../domain/model";
import {
  RECOVERY_CANONICALIZATION_VERSION,
  RECOVERY_HASH_ALGORITHM,
  RECOVERY_SCHEMA_VERSION,
} from "../domain/recovery-canonical";
import { sha256Hex, type BackupArchive } from "../storage/backup-archive";
import {
  describeTable,
  readSchemaIdentity,
  type BackupLedger,
  type SchemaEntry,
} from "../storage/backup-ledger";
import type { ReceiptCustody } from "./receipt-custody";

/** One consistent read must fit comfortably in a Worker isolate. Larger
 * databases need a reviewed export path, never inconsistent pagination. */
export const MAX_CHECKPOINT_DATABASE_BYTES = 96 * 1024 * 1024;
/** Bytes of file objects re-hashed per checkpoint run. */
export const DEFAULT_VERIFY_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;
const CHECKPOINT_EXCLUDED = /^(sqlite_|_cf_)/;

export type CheckpointDeps = Readonly<{
  db: D1Database;
  ledger: BackupLedger;
  backup: BackupArchive;
  custody: ReceiptCustody | null;
  clock: () => number;
}>;
export type CheckpointReport = Readonly<{
  kind: CheckpointKind;
  checkpointId: string | null;
  outcome: "verified" | "skipped" | "failed";
  reason: string | null;
  sequence: string | null;
  tables: number;
  files: number;
  fileBytes: number;
  signed: boolean;
}>;

type Snapshot = Readonly<{
  position: { epochId: string; sequence: string; transactionDigest: string | null };
  workspaceId: string;
  ownerId: string;
  schema: Awaited<ReturnType<typeof readSchemaIdentity>>;
  ddl: readonly SchemaEntry[];
  tables: readonly Readonly<{ name: string; columns: readonly string[]; withoutRowid: boolean; ndjson: Uint8Array; rows: number }>[];
}>;

/** Encode one SQL value without loss, or refuse. */
function encodeValue(value: unknown): unknown {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number") {
    demand(Number.isFinite(value), "CHECKPOINT_UNENCODABLE_VALUE", 500);
    demand(!Number.isInteger(value) || Number.isSafeInteger(value), "CHECKPOINT_UNSAFE_INTEGER", 500);
    return value;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { $base64: btoa(binary) };
  }
  if (Array.isArray(value)) {
    // D1 surfaces BLOB columns as arrays of byte values.
    demand(value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255), "CHECKPOINT_UNENCODABLE_VALUE", 500);
    return encodeValue(new Uint8Array(value as number[]));
  }
  throw new DomainError("CHECKPOINT_UNENCODABLE_VALUE", 500);
}

/** Parent tables before children; ties and cycles keep schema order. */
function loadOrder(tables: readonly Readonly<{ name: string; references: readonly string[] }>[]): string[] {
  const remaining = new Map(tables.map((table) => [table.name, new Set(table.references.filter((parent) => parent !== table.name))]));
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].find(([, parents]) => [...parents].every((parent) => !remaining.has(parent)));
    const next = ready?.[0] ?? remaining.keys().next().value;
    if (next === undefined) break;
    ordered.push(next);
    remaining.delete(next);
  }
  return ordered;
}

async function takeSnapshot(db: D1Database): Promise<Snapshot> {
  const sizeProbe = await db.prepare("SELECT count(*) AS objects FROM sqlite_schema").all();
  demand((sizeProbe.meta.size_after ?? 0) <= MAX_CHECKPOINT_DATABASE_BYTES, "CHECKPOINT_TOO_LARGE", 507);
  const schema = await readSchemaIdentity(db);
  const tableNames = (
    await db
      .prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND sql IS NOT NULL ORDER BY name")
      .all<{ name: string; sql: string }>()
  ).results.filter((row) => !CHECKPOINT_EXCLUDED.test(row.name));
  const described = await Promise.all(
    tableNames.map(async (row) => ({
      name: row.name,
      withoutRowid: /\bWITHOUT\s+ROWID\b/i.test(row.sql),
      ...(await describeTable(db, row.name)),
    })),
  );
  const order = loadOrder(described);
  const tables = order.map((name) => {
    const table = described.find((candidate) => candidate.name === name);
    if (table === undefined) throw new DomainError("CHECKPOINT_TABLE_UNREADABLE", 500);
    return table;
  });
  const quote = (identifier: string) => `"${identifier}"`;
  // One batch is one SQLite transaction: every SELECT sees the same state.
  const results = await db.batch([
    db.prepare("SELECT c.owner,c.workspace_id,c.epoch_id,c.sequence,c.transaction_digest FROM recovery_chains AS c"),
    db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name"),
    ...tables.map((table) =>
      db.prepare(
        `SELECT ${table.columns.map(quote).join(",")} FROM ${quote(table.name)} ORDER BY ${
          table.withoutRowid ? table.primaryKey.map(quote).join(",") : "rowid"
        }`,
      ),
    ),
  ]);
  const chains = (results[0]?.results ?? []) as { owner: string; workspace_id: string; epoch_id: string; sequence: string; transaction_digest: string | null }[];
  demand(chains.length === 1, chains.length === 0 ? "WORKSPACE_UNINITIALIZED" : "CHECKPOINT_MULTIPLE_WORKSPACES", 409);
  const chain = chains[0];
  if (chain === undefined) throw new DomainError("WORKSPACE_UNINITIALIZED", 409);
  const inBatchSchema = (results[1]?.results ?? []) as { type: string; name: string; tbl_name: string; sql: string }[];
  const ddl = inBatchSchema
    .filter((row) => !CHECKPOINT_EXCLUDED.test(row.name) && ["table", "index", "trigger", "view"].includes(row.type))
    .map((row) => ({ type: row.type, name: row.name, tableName: row.tbl_name, sql: row.sql }));
  demand(
    ddl.filter((entry) => entry.type === "table").map((entry) => entry.name).sort().join(",") ===
      tables.map((table) => table.name).sort().join(","),
    "CHECKPOINT_SCHEMA_CHANGED",
    409,
  );
  const encoder = new TextEncoder();
  const encoded = tables.map((table, index) => {
    const rows = (results[index + 2]?.results ?? []) as Record<string, unknown>[];
    const lines = [JSON.stringify({ table: table.name, columns: table.columns })];
    for (const row of rows) lines.push(JSON.stringify(table.columns.map((column) => encodeValue(row[column]))));
    return {
      name: table.name,
      columns: table.columns,
      withoutRowid: table.withoutRowid,
      ndjson: encoder.encode(`${lines.join("\n")}\n`),
      rows: rows.length,
    };
  });
  return {
    position: { epochId: chain.epoch_id, sequence: chain.sequence, transactionDigest: chain.transaction_digest },
    workspaceId: chain.workspace_id,
    ownerId: chain.owner,
    schema,
    ddl,
    tables: encoded,
  };
}

/** Create (or finish verifying) the checkpoint for this period. Idempotent:
 * a period whose manifest already exists is verified, never rewritten. */
export async function runCheckpoint(
  deps: CheckpointDeps,
  kind: CheckpointKind,
  budgetBytes = DEFAULT_VERIFY_BUDGET_BYTES,
): Promise<CheckpointReport> {
  const empty = { tables: 0, files: 0, fileBytes: 0, signed: false };
  const workspace = await deps.ledger.workspace();
  if (workspace === null)
    return { kind, checkpointId: null, outcome: "skipped", reason: "workspace_uninitialized", sequence: null, ...empty };
  const now = deps.clock();
  const period = checkpointPeriod(kind, now);
  const id = checkpointIdFor(kind, period);
  const recorded = await deps.ledger.checkpoint(id);
  if (recorded !== null)
    return { kind, checkpointId: id, outcome: "skipped", reason: "already_verified", sequence: recorded.sequence, ...empty };
  const base = backupKeys.checkpointBase(kind, workspace.workspaceId, period);
  const manifestKey = backupKeys.checkpointManifest(base);
  try {
    let manifest: CheckpointManifest;
    let manifestSha256: string;
    let signed = false;
    const stored = await deps.backup.readBytes(manifestKey);
    if (stored !== null) {
      manifest = checkpointManifestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(stored.bytes)));
      demand(manifest.checkpointId === id && manifest.workspace.workspaceId === workspace.workspaceId, "CHECKPOINT_CONFLICT", 500);
      manifestSha256 = stored.sha256;
      signed = await deps.backup.exists(backupKeys.checkpointSignature(base));
    } else {
      const snapshot = await takeSnapshot(deps.db);
      const tables: CheckpointTable[] = [];
      for (const table of snapshot.tables) {
        const { sha256 } = await deps.backup.putBytes(
          backupKeys.checkpointTable(base, table.name, sha256Hex(table.ndjson)),
          table.ndjson,
          "application/x-ndjson",
        );
        tables.push({
          name: table.name,
          objectKey: backupKeys.checkpointTable(base, table.name, sha256),
          sha256,
          sizeBytes: table.ndjson.byteLength,
          rows: table.rows,
          columns: table.columns,
          withoutRowid: table.withoutRowid,
        });
      }
      const previous = await deps.ledger.latestCheckpoint(kind);
      manifest = checkpointManifestSchema.parse({
        schema: "recovery-checkpoint/v1",
        checkpointId: id,
        kind,
        workspace: { ownerId: snapshot.ownerId, workspaceId: snapshot.workspaceId },
        position: snapshot.position,
        schemaVersion: snapshot.schema.version,
        schemaFingerprint: snapshot.schema.fingerprint,
        ddl: snapshot.ddl,
        tables,
        files: await deps.ledger.filesThrough(snapshot.position.sequence),
        previousCheckpointId: previous?.checkpointId ?? null,
        createdAt: now,
      });
      const written = await deps.backup.putBytes(
        manifestKey,
        new TextEncoder().encode(JSON.stringify(manifest)),
        "application/json",
      );
      manifestSha256 = written.sha256;
      if (deps.custody !== null) {
        const signature = await deps.custody.sign({
          schemaVersion: RECOVERY_SCHEMA_VERSION,
          canonicalizationVersion: RECOVERY_CANONICALIZATION_VERSION,
          hashAlgorithm: RECOVERY_HASH_ALGORITHM,
          purpose: "checkpoint",
          digest: manifestSha256,
        });
        await deps.backup.putBytes(
          backupKeys.checkpointSignature(base),
          new TextEncoder().encode(JSON.stringify({ format: "recovery-checkpoint-signature-v1", manifestSha256, signature })),
          "application/json",
        );
        signed = true;
      }
    }
    // Verified means every table and file object was read back and re-hashed.
    for (const table of manifest.tables) await deps.backup.verify(table.objectKey, table.sha256, table.sizeBytes);
    let fileBytes = 0;
    for (const file of manifest.files) {
      fileBytes += file.sizeBytes;
      demand(fileBytes <= budgetBytes, "CHECKPOINT_VERIFY_BUDGET_EXCEEDED", 507);
      await deps.backup.verify(file.objectKey, file.sha256, file.sizeBytes);
    }
    const verifiedAt = Math.max(deps.clock(), manifest.createdAt);
    await deps.ledger.insertCheckpoint(manifest.workspace.workspaceId, {
      checkpointId: id,
      kind,
      epochId: manifest.position.epochId,
      sequence: manifest.position.sequence,
      transactionDigest: manifest.position.transactionDigest,
      manifestKey,
      manifestSha256,
      schemaFingerprint: manifest.schemaFingerprint,
      tableCount: manifest.tables.length,
      fileCount: manifest.files.length,
      fileBytes,
      createdAt: manifest.createdAt,
      verifiedAt,
    });
    return {
      kind,
      checkpointId: id,
      outcome: "verified",
      reason: null,
      sequence: manifest.position.sequence,
      tables: manifest.tables.length,
      files: manifest.files.length,
      fileBytes,
      signed,
    };
  } catch (error) {
    const reason = error instanceof DomainError ? error.code.toLowerCase() : "unexpected_checkpoint_error";
    return { kind, checkpointId: id, outcome: "failed", reason, sequence: null, ...empty };
  }
}

