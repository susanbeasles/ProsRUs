import { z } from "zod";
import { demand } from "./model";
import {
  archiveObjectRefSchema,
  recoveryJsonSchema,
  workspaceRefSchema,
} from "./recovery";

// Independent backup vocabulary (ADR 0004). Backup objects are addressed by the
// plain SHA-256 of their exact bytes so R2 can enforce the checksum on put;
// recovery digests stay inside the envelopes they already sign.

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
/** Twenty decimal digits keep lexical key order equal to numeric order. */
const sequence = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** SQL identifiers that are safe to double-quote and to use in object keys. */
export const tableNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const backupKey = z
  .string()
  .max(1000)
  .regex(/^(changes|receipts|checkpoints|objects)\/[A-Za-z0-9_./-]+$/)
  .refine((key) =>
    key.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  );

export const CHECKPOINT_KINDS = ["daily", "monthly"] as const;
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];
const DAY_MS = 86_400_000;
/** Retention windows from the owner decision; lifecycle rules expire one day later. */
export const RETENTION = Object.freeze({
  changesMs: 30 * DAY_MS,
  dailyCheckpointMs: 90 * DAY_MS,
  monthlyCheckpointMs: 365 * DAY_MS,
  objectLockMs: 365 * DAY_MS,
});
export const PROTECTION_THRESHOLDS = Object.freeze({
  checkpointFreshMs: 26 * 3_600_000,
  pendingGraceSeconds: 15 * 60,
});

export function paddedSequence(value: string): string {
  sequence.parse(value);
  return value.padStart(20, "0");
}

export const backupKeys = Object.freeze({
  changePrefix: (workspaceId: string) => `changes/${identifier.parse(workspaceId)}/`,
  change: (workspaceId: string, value: string, transactionDigest: string) =>
    `changes/${identifier.parse(workspaceId)}/${paddedSequence(value)}-${sha256Schema.parse(transactionDigest)}.json`,
  receipt: (workspaceId: string, value: string) =>
    `receipts/${identifier.parse(workspaceId)}/${paddedSequence(value)}.json`,
  checkpointPrefix: (kind: CheckpointKind, workspaceId: string) =>
    `checkpoints/${kind}/${identifier.parse(workspaceId)}/`,
  checkpointBase: (kind: CheckpointKind, workspaceId: string, period: string) =>
    `checkpoints/${kind}/${identifier.parse(workspaceId)}/${checkpointPeriodSchema(kind).parse(period)}/`,
  /** Content-addressed so residue from an interrupted run can never collide. */
  checkpointTable: (base: string, table: string, digest: string) =>
    `${base}tables/${tableNameSchema.parse(table)}-${sha256Schema.parse(digest)}.ndjson`,
  checkpointManifest: (base: string) => `${base}manifest.json`,
  checkpointSignature: (base: string) => `${base}manifest.sig`,
  object: (digest: string) =>
    `objects/sha256/${sha256Schema.parse(digest).slice(0, 2)}/${digest}`,
});

const changeKeyPattern =
  /^changes\/([A-Za-z0-9_-]{1,100})\/([0-9]{20})-([a-f0-9]{64})\.json$/;
export function parseChangeKey(key: string): Readonly<{
  workspaceId: string;
  sequence: string;
  transactionDigest: string;
}> | null {
  const match = changeKeyPattern.exec(key);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    workspaceId: match[1],
    sequence: match[2].replace(/^0+(?=.)/, ""),
    transactionDigest: match[3],
  };
}

function checkpointPeriodSchema(kind: CheckpointKind) {
  return kind === "daily"
    ? z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/)
    : z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/);
}
export function checkpointPeriod(kind: CheckpointKind, now: number): string {
  timestamp.parse(now);
  const iso = new Date(now).toISOString();
  return kind === "daily" ? iso.slice(0, 10) : iso.slice(0, 7);
}
export function checkpointId(kind: CheckpointKind, period: string): string {
  return `${kind}-${checkpointPeriodSchema(kind).parse(period)}`;
}

export const backupObjectSchema = z
  .object({
    object: archiveObjectRefSchema,
    sha256: sha256Schema,
    sizeBytes: count,
    backupKey,
  })
  .strict()
  .refine(
    (value) => value.backupKey === backupKeys.object(value.sha256),
    "BACKUP_OBJECT_KEY_MISMATCH",
  )
  .readonly();
export type BackupObject = z.infer<typeof backupObjectSchema>;

/** One committed transaction as replicated: the exact stored envelope plus the
 * byte identity of every primary object it names. */
export const changeRecordSchema = z
  .object({
    format: z.literal("recovery-change-v1"),
    workspace: workspaceRefSchema,
    epochId: identifier,
    sequence,
    transactionId: identifier,
    transactionDigest: sha256Schema,
    previousDigest: sha256Schema.nullable(),
    schemaFingerprint: sha256Schema,
    committedAt: timestamp.nullable(),
    envelope: recoveryJsonSchema,
    objects: z.array(backupObjectSchema).max(512).readonly(),
  })
  .strict()
  .refine(
    (record) => record.sequence !== "0" && (record.sequence === "1") === (record.previousDigest === null),
    "INVALID_CHANGE_LINK",
  )
  .readonly();
export type ChangeRecord = z.infer<typeof changeRecordSchema>;

const ddlEntrySchema = z
  .object({
    type: z.enum(["table", "index", "trigger", "view"]),
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/),
    tableName: tableNameSchema,
    sql: z.string().min(1).max(200_000),
  })
  .strict()
  .readonly();
export type DdlEntry = z.infer<typeof ddlEntrySchema>;
export const checkpointTableSchema = z
  .object({
    name: tableNameSchema,
    objectKey: backupKey,
    sha256: sha256Schema,
    sizeBytes: count,
    rows: count,
    columns: z.array(tableNameSchema).min(1).max(200).readonly(),
    withoutRowid: z.boolean(),
  })
  .strict()
  .readonly();
export type CheckpointTable = z.infer<typeof checkpointTableSchema>;
export const checkpointFileSchema = z
  .object({ sha256: sha256Schema, sizeBytes: count, objectKey: backupKey })
  .strict()
  .refine((file) => file.objectKey === backupKeys.object(file.sha256), "BACKUP_OBJECT_KEY_MISMATCH")
  .readonly();

/** `recovery-checkpoint/v1`. Tables are listed in foreign-key load order. */
export const checkpointManifestSchema = z
  .object({
    schema: z.literal("recovery-checkpoint/v1"),
    checkpointId: z.string().regex(/^(daily-[0-9]{4}-[0-9]{2}-[0-9]{2}|monthly-[0-9]{4}-[0-9]{2})$/),
    kind: z.enum(CHECKPOINT_KINDS),
    workspace: workspaceRefSchema,
    position: z
      .object({ epochId: identifier, sequence, transactionDigest: sha256Schema.nullable() })
      .strict()
      .readonly(),
    schemaVersion: z.string().regex(/^[0-9]{4}$/).nullable(),
    schemaFingerprint: sha256Schema,
    ddl: z.array(ddlEntrySchema).max(2000).readonly(),
    tables: z.array(checkpointTableSchema).min(1).max(500).readonly(),
    files: z.array(checkpointFileSchema).max(1_000_000).readonly(),
    previousCheckpointId: z.string().max(40).nullable(),
    createdAt: timestamp,
  })
  .strict()
  .refine(
    (manifest) =>
      manifest.checkpointId.startsWith(`${manifest.kind}-`) &&
      new Set(manifest.tables.map((table) => table.name)).size === manifest.tables.length &&
      new Set(manifest.files.map((file) => file.sha256)).size === manifest.files.length &&
      manifest.tables.every((table) =>
        manifest.ddl.some((entry) => entry.type === "table" && entry.name === table.name),
      ),
    "INVALID_CHECKPOINT_MANIFEST",
  )
  .readonly();
export type CheckpointManifest = z.infer<typeof checkpointManifestSchema>;

export const RECOVERY_STATES = [
  "protected",
  "protection_pending",
  "delayed",
  "degraded",
  "failed",
  "unavailable",
] as const;
export const recoveryStatusSchema = z
  .object({
    format: z.literal("recovery-status-v1"),
    workspaceId: identifier,
    state: z.enum(RECOVERY_STATES),
    head: z.object({ sequence, committedAt: timestamp.nullable() }).strict().readonly().nullable(),
    latestVerified: z
      .object({ sequence, transactionDigest: sha256Schema, verifiedAt: timestamp })
      .strict()
      .readonly()
      .nullable(),
    latestCheckpoint: z
      .object({
        checkpointId: z.string().max(40),
        kind: z.enum(CHECKPOINT_KINDS),
        position: z.object({ sequence }).strict().readonly(),
        verifiedAt: timestamp,
      })
      .strict()
      .readonly()
      .nullable(),
    lag: z
      .object({
        pendingTransactions: count,
        oldestPendingAt: timestamp.nullable(),
        seconds: count.nullable(),
      })
      .strict()
      .readonly(),
    deadLetters: count,
    observedAt: timestamp,
  })
  .strict()
  .refine(
    (status) =>
      status.state !== "protected" ||
      (status.latestCheckpoint !== null &&
        status.lag.pendingTransactions === 0 &&
        status.deadLetters === 0 &&
        (status.head?.sequence ?? "0") === (status.latestVerified?.sequence ?? "0")),
    "PROTECTED_WITHOUT_EVIDENCE",
  )
  .readonly();
export type RecoveryStatus = z.infer<typeof recoveryStatusSchema>;

export type RecoveryFacts = Readonly<{
  workspaceId: string;
  head: RecoveryStatus["head"];
  latestVerified: RecoveryStatus["latestVerified"];
  latestCheckpoint: RecoveryStatus["latestCheckpoint"];
  oldestPendingAt: number | null;
  deadLetters: number;
}>;

/** Pure status rule. Pending work is never reported as protected, and a
 * platform-level restore point is not an input at all. */
export function deriveRecoveryStatus(facts: RecoveryFacts, now: number): RecoveryStatus {
  timestamp.parse(now);
  const headSequence = BigInt(facts.head?.sequence ?? "0");
  const verifiedSequence = BigInt(facts.latestVerified?.sequence ?? "0");
  demand(verifiedSequence <= headSequence, "RECOVERY_VERIFIED_AHEAD_OF_HEAD", 500);
  const pending = headSequence - verifiedSequence;
  const oldestPendingAt = pending > 0n ? facts.oldestPendingAt : null;
  const seconds =
    oldestPendingAt === null ? null : Math.max(0, Math.floor((now - oldestPendingAt) / 1000));
  const checkpointFresh =
    facts.latestCheckpoint !== null &&
    facts.latestCheckpoint.verifiedAt <= now &&
    now - facts.latestCheckpoint.verifiedAt <= PROTECTION_THRESHOLDS.checkpointFreshMs;
  const state: RecoveryStatus["state"] =
    facts.deadLetters > 0
      ? "failed"
      : pending > 0n
        ? seconds !== null && seconds <= PROTECTION_THRESHOLDS.pendingGraceSeconds
          ? "protection_pending"
          : "delayed"
        : checkpointFresh
          ? "protected"
          : "degraded";
  return recoveryStatusSchema.parse({
    format: "recovery-status-v1",
    workspaceId: facts.workspaceId,
    state,
    head: facts.head,
    latestVerified: facts.latestVerified,
    latestCheckpoint: facts.latestCheckpoint,
    lag: {
      pendingTransactions: Number(pending > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : pending),
      oldestPendingAt,
      seconds,
    },
    deadLetters: facts.deadLetters,
    observedAt: now,
  });
}

export type RetentionCandidate = Readonly<{ key: string; sha256: string; uploadedAt: number }>;
export type RetentionPlan = Readonly<{
  delete: readonly string[];
  keptReferenced: number;
  keptLocked: number;
}>;

/** An object is deletable only when nothing retained references it AND its
 * lock has expired. Unparseable keys are always kept. */
export function planObjectRetention(
  input: Readonly<{
    objects: readonly RetentionCandidate[];
    referenced: ReadonlySet<string>;
    now: number;
  }>,
): RetentionPlan {
  timestamp.parse(input.now);
  const remove: string[] = [];
  let keptReferenced = 0;
  let keptLocked = 0;
  for (const object of input.objects) {
    if (
      !sha256Schema.safeParse(object.sha256).success ||
      object.key !== backupKeys.object(object.sha256)
    ) {
      keptReferenced += 1;
      continue;
    }
    if (input.referenced.has(object.sha256)) keptReferenced += 1;
    else if (object.uploadedAt + RETENTION.objectLockMs + DAY_MS > input.now) keptLocked += 1;
    else remove.push(object.key);
  }
  return { delete: remove, keptReferenced, keptLocked };
}

/** Which checkpoint and change records are still inside their retention window. */
export function retainedCheckpoint(kind: CheckpointKind, createdAt: number, now: number): boolean {
  const window = kind === "daily" ? RETENTION.dailyCheckpointMs : RETENTION.monthlyCheckpointMs;
  return now - createdAt <= window;
}
export function retainedChange(uploadedAt: number, now: number): boolean {
  return now - uploadedAt <= RETENTION.changesMs;
}
