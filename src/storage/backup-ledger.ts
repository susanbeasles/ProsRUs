import { createHash } from "node:crypto";
import { z } from "zod";
import { demand, DomainError } from "../domain/model";
import {
  backupObjectSchema,
  CHECKPOINT_KINDS,
  sha256Schema,
  tableNameSchema,
  type BackupObject,
  type CheckpointKind,
  type RecoveryFacts,
} from "../domain/backup";
import type { RecoveryJobLease } from "../application/recovery-ports";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const sequence = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** TEXT sequences compare numerically by length first, then lexically. */
const sequenceAtMost = (column: string) =>
  `(length(${column})<length(?) OR (length(${column})=length(?) AND ${column}<=?))`;
const leasePredicate =
  "owner=? AND workspace_id=? AND job_id=? AND transaction_id=? AND state='running' AND fence=? AND lease_owner=? AND attempt=? AND lease_expires_at>?";
/** Tables that belong to the platform or migration tooling, not the product schema. */
const SCHEMA_EXCLUDED = /^(sqlite_|_cf_|d1_migrations$|runtime_migrations$)/;

export type CommittedTransaction = Readonly<{
  transactionId: string;
  epochId: string;
  sequence: string;
  transactionDigest: string;
  previousDigest: string | null;
  prepared: string;
  committedAt: number | null;
}>;
export type DueJob = Readonly<{ jobId: string; sequence: string }>;
export type CheckpointRow = Readonly<{
  checkpointId: string;
  kind: CheckpointKind;
  epochId: string;
  sequence: string;
  transactionDigest: string | null;
  manifestKey: string;
  manifestSha256: string;
  schemaFingerprint: string;
  tableCount: number;
  fileCount: number;
  fileBytes: number;
  createdAt: number;
  verifiedAt: number;
}>;
export type SchemaEntry = Readonly<{ type: string; name: string; tableName: string; sql: string }>;
export type SchemaIdentity = Readonly<{
  fingerprint: string;
  version: string | null;
  entries: readonly SchemaEntry[];
}>;

const schemaRow = z.object({
  type: z.enum(["table", "index", "trigger", "view"]),
  name: z.string(),
  tbl_name: z.string(),
  sql: z.string(),
});
export async function readSchemaIdentity(db: D1Database): Promise<SchemaIdentity> {
  const rows = (
    await db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND type IN ('table','index','trigger','view') ORDER BY type,name",
      )
      .all()
  ).results.map((raw) => schemaRow.parse(raw));
  const entries = rows
    .filter((row) => !SCHEMA_EXCLUDED.test(row.name) && !SCHEMA_EXCLUDED.test(row.tbl_name))
    .map((row) => ({ type: row.type, name: row.name, tableName: row.tbl_name, sql: row.sql }));
  const hash = createHash("sha256");
  for (const entry of entries)
    hash.update(JSON.stringify([entry.type, entry.name, entry.tableName, entry.sql])).update("\n");
  let version: string | null = null;
  if (rows.some((row) => row.type === "table" && row.name === "d1_migrations")) {
    const latest = await db
      .prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1")
      .first<{ name: string }>();
    version = latest?.name.match(/^([0-9]{4})/)?.[1] ?? null;
  }
  return { fingerprint: hash.digest("hex"), version, entries };
}

/** Replicator-side D1 port. Reads are scoped to one owner; the only writes are
 * append-only backup-object and checkpoint evidence, fenced by the outbox lease
 * where a lease exists. */
export function createBackupLedger(db: D1Database, owner: string) {
  identifier.parse(owner);
  const query = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);

  async function workspace() {
    const raw = await query(
      "SELECT workspace_id,epoch_id,sequence,transaction_digest FROM recovery_chains WHERE owner=?",
      owner,
    ).first();
    if (raw === null) return null;
    const row = z
      .object({
        workspace_id: identifier,
        epoch_id: identifier,
        sequence,
        transaction_digest: sha256Schema.nullable(),
      })
      .parse(raw);
    return {
      workspaceId: row.workspace_id,
      epochId: row.epoch_id,
      sequence: row.sequence,
      transactionDigest: row.transaction_digest,
    };
  }

  const transactionRow = z.object({
    transaction_id: identifier,
    epoch_id: identifier,
    sequence,
    transaction_digest: sha256Schema,
    previous_digest: sha256Schema.nullable(),
    prepared: z.string(),
    observed_at_ms: time.nullable(),
  });
  const transactionSelect =
    "SELECT t.transaction_id,t.epoch_id,t.sequence,t.transaction_digest,t.previous_digest,t.prepared,o.observed_at_ms FROM recovery_transactions AS t LEFT JOIN recovery_commit_observations AS o ON o.owner=t.owner AND o.workspace_id=t.workspace_id AND o.transaction_id=t.transaction_id";
  function toTransaction(raw: unknown): CommittedTransaction {
    const row = transactionRow.parse(raw);
    return {
      transactionId: row.transaction_id,
      epochId: row.epoch_id,
      sequence: row.sequence,
      transactionDigest: row.transaction_digest,
      previousDigest: row.previous_digest,
      prepared: row.prepared,
      committedAt: row.observed_at_ms,
    };
  }

  return {
    workspace,
    async transaction(transactionId: string): Promise<CommittedTransaction | null> {
      const raw = await query(
        `${transactionSelect} WHERE t.owner=? AND t.transaction_id=?`,
        owner,
        identifier.parse(transactionId),
      ).first();
      return raw === null ? null : toTransaction(raw);
    },
    /** True when transaction `sequence` of `epochId` already has a protection receipt. */
    async hasReceipt(epochId: string, value: string): Promise<boolean> {
      const raw = await query(
        "SELECT 1 AS present FROM recovery_protection_receipts AS r JOIN recovery_transactions AS t ON t.owner=r.owner AND t.workspace_id=r.workspace_id AND t.transaction_id=r.transaction_id WHERE t.owner=? AND t.epoch_id=? AND t.sequence=? LIMIT 1",
        owner,
        identifier.parse(epochId),
        sequence.parse(value),
      ).first();
      return raw !== null;
    },
    /** Due jobs in commit order, so a predecessor is offered before its successor. */
    async dueJobs(now: number, limit: number): Promise<readonly DueJob[]> {
      time.parse(now);
      return (
        await query(
          "SELECT o.job_id,t.sequence FROM recovery_outbox AS o JOIN recovery_transactions AS t ON t.owner=o.owner AND t.workspace_id=o.workspace_id AND t.transaction_id=o.transaction_id WHERE o.owner=? AND o.next_attempt_at<=? AND (o.state IN ('pending','retryable') OR (o.state='running' AND o.lease_expires_at<=?)) ORDER BY length(t.sequence),t.sequence LIMIT ?",
          owner,
          now,
          now,
          z.number().int().min(1).max(100).parse(limit),
        ).all()
      ).results.map((raw) => {
        const row = z.object({ job_id: identifier, sequence }).parse(raw);
        return { jobId: row.job_id, sequence: row.sequence };
      });
    },
    /** Append byte identities under the current lease. An identity already
     * recorded with different bytes is an integrity fault, never overwritten. */
    async recordObjects(
      lease: RecoveryJobLease,
      workspaceId: string,
      objects: readonly BackupObject[],
      now: number,
    ): Promise<"applied" | "stale_fence"> {
      const rows = objects.map((object) => backupObjectSchema.parse(object));
      for (const row of rows) demand(row.object.versionId !== null, "BACKUP_OBJECT_UNPINNED", 500);
      const lease_ = [
        owner,
        workspaceId,
        lease.jobId,
        lease.transactionId,
        lease.fence,
        lease.owner,
        lease.attempt,
        now,
      ];
      const statements = rows.map((row) =>
        query(
          `INSERT INTO recovery_backup_objects(owner,workspace_id,storage_key,version_id,sha256,size_bytes,backup_key,transaction_id) SELECT ?,?,?,?,?,?,?,? FROM recovery_outbox WHERE ${leasePredicate} AND NOT EXISTS(SELECT 1 FROM recovery_backup_objects WHERE owner=? AND workspace_id=? AND storage_key=? AND version_id=?)`,
          owner,
          workspaceId,
          `${row.object.namespace}/${row.object.key}`,
          row.object.versionId,
          row.sha256,
          row.sizeBytes,
          row.backupKey,
          lease.transactionId,
          ...lease_,
          owner,
          workspaceId,
          `${row.object.namespace}/${row.object.key}`,
          row.object.versionId,
        ),
      );
      statements.push(
        query(`SELECT 1 AS held FROM recovery_outbox WHERE ${leasePredicate}`, ...lease_),
      );
      const results = await db.batch(statements);
      if ((results.at(-1)?.results.length ?? 0) !== 1) return "stale_fence";
      for (const row of rows) {
        const stored = await query(
          "SELECT sha256,size_bytes FROM recovery_backup_objects WHERE owner=? AND workspace_id=? AND storage_key=? AND version_id=?",
          owner,
          workspaceId,
          `${row.object.namespace}/${row.object.key}`,
          row.object.versionId,
        ).first<{ sha256: string; size_bytes: number }>();
        demand(
          stored !== null && stored.sha256 === row.sha256 && stored.size_bytes === row.sizeBytes,
          "BACKUP_INTEGRITY_FAULT",
          500,
        );
      }
      return "applied";
    },
    /** Distinct file objects referenced by committed transactions up to `value`. */
    async filesThrough(value: string) {
      sequence.parse(value);
      return (
        await query(
          `SELECT DISTINCT b.sha256,b.size_bytes,b.backup_key FROM recovery_backup_objects AS b JOIN recovery_transactions AS t ON t.owner=b.owner AND t.workspace_id=b.workspace_id AND t.transaction_id=b.transaction_id WHERE b.owner=? AND ${sequenceAtMost("t.sequence")} ORDER BY b.sha256`,
          owner,
          value,
          value,
          value,
        ).all()
      ).results.map((raw) => {
        const row = z
          .object({ sha256: sha256Schema, size_bytes: time, backup_key: z.string() })
          .parse(raw);
        return { sha256: row.sha256, sizeBytes: row.size_bytes, objectKey: row.backup_key };
      });
    },
    /** Every digest the current recovery history still references. */
    async referencedDigests(): Promise<Set<string>> {
      const rows = (
        await query("SELECT DISTINCT sha256 FROM recovery_backup_objects WHERE owner=?", owner).all()
      ).results.map((raw) => z.object({ sha256: sha256Schema }).parse(raw).sha256);
      return new Set(rows);
    },
    async checkpoint(checkpointId: string): Promise<CheckpointRow | null> {
      const raw = await query(
        "SELECT * FROM recovery_checkpoints WHERE owner=? AND checkpoint_id=?",
        owner,
        checkpointId,
      ).first();
      return raw === null ? null : toCheckpoint(raw);
    },
    async latestCheckpoint(kind: CheckpointKind | null = null): Promise<CheckpointRow | null> {
      const raw =
        kind === null
          ? await query(
              "SELECT * FROM recovery_checkpoints WHERE owner=? ORDER BY verified_at DESC,checkpoint_id DESC LIMIT 1",
              owner,
            ).first()
          : await query(
              "SELECT * FROM recovery_checkpoints WHERE owner=? AND kind=? ORDER BY verified_at DESC,checkpoint_id DESC LIMIT 1",
              owner,
              z.enum(CHECKPOINT_KINDS).parse(kind),
            ).first();
      return raw === null ? null : toCheckpoint(raw);
    },
    async insertCheckpoint(workspaceId: string, row: CheckpointRow): Promise<void> {
      await query(
        "INSERT INTO recovery_checkpoints(owner,workspace_id,checkpoint_id,kind,epoch_id,sequence,transaction_digest,manifest_key,manifest_sha256,schema_fingerprint,table_count,file_count,file_bytes,created_at,verified_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM recovery_checkpoints WHERE owner=? AND workspace_id=? AND checkpoint_id=?)",
        owner,
        workspaceId,
        row.checkpointId,
        row.kind,
        row.epochId,
        row.sequence,
        row.transactionDigest,
        row.manifestKey,
        row.manifestSha256,
        row.schemaFingerprint,
        row.tableCount,
        row.fileCount,
        row.fileBytes,
        row.createdAt,
        row.verifiedAt,
        owner,
        workspaceId,
        row.checkpointId,
      ).run();
      const stored = await query(
        "SELECT manifest_sha256 FROM recovery_checkpoints WHERE owner=? AND workspace_id=? AND checkpoint_id=?",
        owner,
        workspaceId,
        row.checkpointId,
      ).first<{ manifest_sha256: string }>();
      demand(stored?.manifest_sha256 === row.manifestSha256, "CHECKPOINT_CONFLICT", 409);
    },
    /** Every fact the status rule needs, read from evidence rows only. */
    async statusFacts(workspaceId: string): Promise<RecoveryFacts | null> {
      const bound = await workspace();
      if (bound === null || bound.workspaceId !== workspaceId) return null;
      const [head, verified, pending, dead, latest] = await db.batch([
        query(
          `${transactionSelect} WHERE t.owner=? AND t.workspace_id=? AND t.epoch_id=? AND t.sequence=?`,
          owner,
          workspaceId,
          bound.epochId,
          bound.sequence,
        ),
        query(
          "SELECT t.sequence,t.transaction_digest,json_extract(r.receipt,'$.verifiedAt') AS verified_at FROM recovery_protection_receipts AS r JOIN recovery_transactions AS t ON t.owner=r.owner AND t.workspace_id=r.workspace_id AND t.transaction_id=r.transaction_id WHERE r.owner=? AND r.workspace_id=? AND t.epoch_id=? ORDER BY length(t.sequence) DESC,t.sequence DESC,verified_at DESC LIMIT 1",
          owner,
          workspaceId,
          bound.epochId,
        ),
        query(
          // Lag runs from the trusted D1 commit observation, not caller-supplied time.
          "SELECT min(coalesce(o.observed_at_ms,x.created_at)) AS oldest FROM recovery_outbox AS x LEFT JOIN recovery_commit_observations AS o ON o.owner=x.owner AND o.workspace_id=x.workspace_id AND o.transaction_id=x.transaction_id WHERE x.owner=? AND x.workspace_id=? AND x.state IN ('pending','running','retryable')",
          owner,
          workspaceId,
        ),
        query(
          "SELECT count(*) AS dead FROM recovery_outbox WHERE owner=? AND workspace_id=? AND state IN ('dead_letter','quarantined')",
          owner,
          workspaceId,
        ),
        query(
          "SELECT checkpoint_id,kind,sequence,verified_at FROM recovery_checkpoints WHERE owner=? AND workspace_id=? ORDER BY verified_at DESC,checkpoint_id DESC LIMIT 1",
          owner,
          workspaceId,
        ),
      ]);
      const headRow = head?.results[0];
      const verifiedRow = z
        .object({ sequence, transaction_digest: sha256Schema, verified_at: time })
        .optional()
        .parse(verified?.results[0]);
      const oldest = z.object({ oldest: time.nullable() }).parse(pending?.results[0]).oldest;
      const deadLetters = z.object({ dead: time }).parse(dead?.results[0]).dead;
      const checkpointRow = z
        .object({
          checkpoint_id: z.string(),
          kind: z.enum(CHECKPOINT_KINDS),
          sequence,
          verified_at: time,
        })
        .optional()
        .parse(latest?.results[0]);
      const headTransaction = headRow === undefined ? null : toTransaction(headRow);
      return {
        workspaceId,
        head:
          headTransaction === null
            ? null
            : { sequence: headTransaction.sequence, committedAt: headTransaction.committedAt },
        latestVerified:
          verifiedRow === undefined
            ? null
            : {
                sequence: verifiedRow.sequence,
                transactionDigest: verifiedRow.transaction_digest,
                verifiedAt: verifiedRow.verified_at,
              },
        latestCheckpoint:
          checkpointRow === undefined
            ? null
            : {
                checkpointId: checkpointRow.checkpoint_id,
                kind: checkpointRow.kind,
                position: { sequence: checkpointRow.sequence },
                verifiedAt: checkpointRow.verified_at,
              },
        oldestPendingAt: oldest,
        deadLetters,
      };
    },
  };
}
export type BackupLedger = ReturnType<typeof createBackupLedger>;

function toCheckpoint(raw: unknown): CheckpointRow {
  const row = z
    .object({
      checkpoint_id: z.string(),
      kind: z.enum(CHECKPOINT_KINDS),
      epoch_id: identifier,
      sequence,
      transaction_digest: sha256Schema.nullable(),
      manifest_key: z.string(),
      manifest_sha256: sha256Schema,
      schema_fingerprint: sha256Schema,
      table_count: time,
      file_count: time,
      file_bytes: time,
      created_at: time,
      verified_at: time,
    })
    .passthrough()
    .parse(raw);
  return {
    checkpointId: row.checkpoint_id,
    kind: row.kind,
    epochId: row.epoch_id,
    sequence: row.sequence,
    transactionDigest: row.transaction_digest,
    manifestKey: row.manifest_key,
    manifestSha256: row.manifest_sha256,
    schemaFingerprint: row.schema_fingerprint,
    tableCount: row.table_count,
    fileCount: row.file_count,
    fileBytes: row.file_bytes,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  };
}

/** Column and ordering facts for one table, read through table-valued pragmas. */
export async function describeTable(
  db: D1Database,
  table: string,
): Promise<Readonly<{ columns: readonly string[]; primaryKey: readonly string[]; references: readonly string[] }>> {
  tableNameSchema.parse(table);
  const columns = (
    await db.prepare("SELECT name,pk FROM pragma_table_info(?) ORDER BY cid").bind(table).all()
  ).results.map((raw) => z.object({ name: tableNameSchema, pk: z.number().int() }).parse(raw));
  if (columns.length === 0) throw new DomainError("CHECKPOINT_TABLE_UNREADABLE", 500);
  const references = (
    await db.prepare('SELECT DISTINCT "table" AS parent FROM pragma_foreign_key_list(?)').bind(table).all()
  ).results.map((raw) => z.object({ parent: tableNameSchema }).parse(raw).parent);
  return {
    columns: columns.map((column) => column.name),
    primaryKey: columns
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name),
    references,
  };
}
