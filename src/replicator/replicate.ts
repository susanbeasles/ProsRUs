import { createHash } from "node:crypto";
import type {
  ArchiveReader,
  RecoveryJobLease,
  RecoveryStore,
} from "../application/recovery-ports";
import {
  backupKeys,
  changeRecordSchema,
  type BackupObject,
  type ChangeRecord,
} from "../domain/backup";
import { demand, DomainError } from "../domain/model";
import {
  archiveInventorySchema,
  checkpointSchema,
  protectionReceiptSchema,
  type ArchiveObjectRef,
  type PreparedEnvelope,
  type ProtectionReceipt,
  type RecoveryJobResult,
} from "../domain/recovery";
import {
  canonicalizeEnvelope,
  hashEnvelope,
  parseEnvelopeJson,
  RECOVERY_CANONICALIZATION_VERSION,
  RECOVERY_HASH_ALGORITHM,
  RECOVERY_SCHEMA_VERSION,
} from "../domain/recovery-canonical";
import type { BackupArchive } from "../storage/backup-archive";
import { readSchemaIdentity, type BackupLedger, type CommittedTransaction } from "../storage/backup-ledger";
import { inspectArtifactStream, readArtifact } from "../storage/recovery-streams";
import type { ReceiptCustody } from "./receipt-custody";

export const REPLICA_NAMESPACE = "backup";
export const VERIFIER_ID = "job-stack-replicator";
const LEASE_MS = 5 * 60_000;
const STAGES: readonly RecoveryJobResult["stage"][] = ["primary_journal", "replicate", "verify", "receipt", "complete"];
const MAX_ATTEMPTS = 12;
const format = {
  schemaVersion: RECOVERY_SCHEMA_VERSION,
  canonicalizationVersion: RECOVERY_CANONICALIZATION_VERSION,
  hashAlgorithm: RECOVERY_HASH_ALGORITHM,
} as const;
/** Faults that more attempts cannot repair: the job is held for review. */
const QUARANTINE = new Set([
  "BACKUP_INTEGRITY_FAULT",
  "INTEGRITY_MISMATCH",
  "ARCHIVE_IDENTITY_MISMATCH",
  "ARCHIVE_OBJECT_MISSING",
  "BACKUP_OBJECT_UNPINNED",
  "CHANGE_RECORD_CONFLICT",
  "RECEIPT_CONFLICT",
  "RECOVERY_RECEIPT_COMMIT_MISMATCH",
]);
/** Waiting states that never exhaust the attempt budget. */
const WAITING = new Set(["awaiting_predecessor", "receipt_custody_unavailable"]);

export type ReplicatorDeps = Readonly<{
  store: RecoveryStore;
  ledger: BackupLedger;
  db: D1Database;
  primary: Pick<ArchiveReader, "get" | "getStream">;
  backup: BackupArchive;
  custody: ReceiptCustody | null;
  clock: () => number;
  leaseOwner: string;
}>;
export type JobOutcome = Readonly<{
  jobId: string;
  sequence: string | null;
  status: RecoveryJobResult["status"] | "not_claimed";
  stage: RecoveryJobResult["stage"] | null;
  errorCategory: string | null;
  objectsCreated: number;
  objectsMatched: number;
}>;
export type SweepReport = Readonly<{ processed: readonly JobOutcome[]; startedAt: number; finishedAt: number }>;

class StageFailure extends Error {
  constructor(
    readonly stage: RecoveryJobResult["stage"],
    readonly code: string,
  ) {
    super(code);
  }
}
function errorCode(error: unknown): string {
  if (error instanceof StageFailure) return error.code;
  if (error instanceof DomainError) return error.code;
  return "UNEXPECTED_REPLICATION_ERROR";
}
function category(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9_.:-]/g, "_").slice(0, 200);
}
function backoffMs(attempt: number): number {
  return Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempt, 7));
}
function unsigned<T extends { readonly signature: unknown }>(value: T): Omit<T, "signature"> {
  const { signature: omitted, ...payload } = value;
  void omitted;
  return payload;
}
function predecessor(value: string): string {
  return (BigInt(value) - 1n).toString();
}
function replicaRef(sha256: string): ArchiveObjectRef {
  return { provider: "replica", namespace: REPLICA_NAMESPACE, key: backupKeys.object(sha256), versionId: null };
}

/** One pass over due outbox jobs in commit order. Each job is claimed through
 * the store's fenced lease; every effect it causes is idempotent. */
export async function sweepOutbox(deps: ReplicatorDeps, limit = 25): Promise<SweepReport> {
  const startedAt = deps.clock();
  const processed: JobOutcome[] = [];
  for (const due of await deps.ledger.dueJobs(startedAt, limit)) {
    const lease = await deps.store.claimJob(due.jobId, deps.leaseOwner, deps.clock(), LEASE_MS);
    if (lease === null) {
      processed.push({ jobId: due.jobId, sequence: due.sequence, status: "not_claimed", stage: null, errorCategory: null, objectsCreated: 0, objectsMatched: 0 });
      continue;
    }
    processed.push(await replicateJob(deps, lease));
  }
  return { processed, startedAt, finishedAt: deps.clock() };
}

export async function replicateJob(deps: ReplicatorDeps, initial: RecoveryJobLease): Promise<JobOutcome> {
  let lease = initial;
  let stage: RecoveryJobResult["stage"] = lease.stage;
  let transaction: CommittedTransaction | null = null;
  const counts = { created: 0, matched: 0 };
  const renew = async () => {
    const renewed = await deps.store.renewJob(lease, deps.clock(), LEASE_MS);
    if (renewed === null) throw new StageFailure(stage, "STALE_FENCE");
    lease = renewed;
  };
  try {
    transaction = await deps.ledger.transaction(lease.transactionId);
    const prepared = await deps.store.getPrepared(lease.transactionId);
    demand(transaction !== null && prepared !== null, "RECOVERY_COMMIT_MISSING", 500);
    const workspaceId = prepared.workspace.workspaceId;

    stage = "primary_journal";
    const objects = await verifyPrimaryObjects(deps, prepared);

    stage = "replicate";
    if (transaction.sequence !== "1" && !(await deps.ledger.hasReceipt(transaction.epochId, predecessor(transaction.sequence))))
      throw new StageFailure(stage, "AWAITING_PREDECESSOR");
    for (const object of objects) {
      await renew();
      const outcome = await copyObject(deps, object);
      counts[outcome === "created" ? "created" : "matched"] += 1;
    }
    if ((await deps.ledger.recordObjects(lease, workspaceId, objects, deps.clock())) === "stale_fence")
      throw new StageFailure(stage, "STALE_FENCE");
    const changeKey = backupKeys.change(workspaceId, transaction.sequence, transaction.transactionDigest);
    await writeChangeRecord(deps, changeKey, transaction, prepared, objects);

    stage = "verify";
    for (const object of objects) {
      await renew();
      await deps.backup.verify(object.backupKey, object.sha256, object.sizeBytes);
    }
    await readChangeRecord(deps, changeKey, transaction, prepared, objects);

    stage = "receipt";
    if (deps.custody === null) throw new StageFailure(stage, "RECEIPT_CUSTODY_UNAVAILABLE");
    await renew();
    const receipt = await establishReceipt(deps, deps.custody, transaction, prepared, objects);
    const projected = await deps.store.projectProtection(lease, receipt, deps.clock());
    if (projected === "stale_fence") throw new StageFailure(stage, "STALE_FENCE");

    stage = "complete";
    const now = deps.clock();
    const finished = await deps.store.finishJob(
      lease,
      { jobId: lease.jobId, transactionId: lease.transactionId, fence: lease.fence, stage, status: "completed", attempt: lease.attempt, nextAttemptAt: null, errorCategory: null },
      now,
    );
    return outcome(lease, transaction, finished === "applied" ? "completed" : "stale_fence", stage, null, counts);
  } catch (error) {
    const code = errorCode(error);
    if (code === "STALE_FENCE") return outcome(lease, transaction, "stale_fence", stage, "stale_fence", counts);
    const label = category(code);
    const waiting = WAITING.has(label);
    const status: RecoveryJobResult["status"] = QUARANTINE.has(code)
      ? "quarantined"
      : !waiting && lease.attempt >= MAX_ATTEMPTS
        ? "dead_letter"
        : "retryable";
    const now = deps.clock();
    const nextAttemptAt =
      status !== "retryable"
        ? null
        : now + (label === "awaiting_predecessor" ? 30_000 : label === "receipt_custody_unavailable" ? 5 * 60_000 : backoffMs(lease.attempt));
    // Stages only advance: a re-run failing early keeps the furthest stage reached.
    const reached = STAGES.indexOf(stage) >= STAGES.indexOf(lease.stage) ? stage : lease.stage;
    const finished = await deps.store
      .finishJob(
        lease,
        { jobId: lease.jobId, transactionId: lease.transactionId, fence: lease.fence, stage: reached, status, attempt: lease.attempt, nextAttemptAt, errorCategory: label },
        now,
      )
      .catch(() => "stale_fence" as const);
    return outcome(lease, transaction, finished === "applied" ? status : "stale_fence", reached, label, counts);
  }
}

function outcome(
  lease: RecoveryJobLease,
  transaction: CommittedTransaction | null,
  status: JobOutcome["status"],
  stage: RecoveryJobResult["stage"],
  errorCategory: string | null,
  counts: { created: number; matched: number },
): JobOutcome {
  return { jobId: lease.jobId, sequence: transaction?.sequence ?? null, status, stage, errorCategory, objectsCreated: counts.created, objectsMatched: counts.matched };
}

/** Re-hash every primary object the committed envelope names, pinned to its
 * recorded physical identity. Returns one byte identity per physical object. */
async function verifyPrimaryObjects(deps: ReplicatorDeps, prepared: PreparedEnvelope): Promise<BackupObject[]> {
  const seen = new Map<string, BackupObject>();
  const identity = (object: ArchiveObjectRef) => JSON.stringify([object.namespace, object.key, object.versionId]);
  for (const descriptor of prepared.objects) {
    if (seen.has(identity(descriptor.object))) continue;
    demand(descriptor.object.versionId !== null, "BACKUP_OBJECT_UNPINNED", 500);
    const read = await readArtifact(deps.primary, descriptor);
    const inspected = await inspectArtifactStream(read.body, descriptor.sizeBytes);
    demand(inspected.digest === descriptor.digest, "INTEGRITY_MISMATCH", 500);
    seen.set(identity(descriptor.object), {
      object: descriptor.object,
      sha256: inspected.rawSha256,
      sizeBytes: inspected.sizeBytes,
      backupKey: backupKeys.object(inspected.rawSha256),
    });
  }
  const binding = prepared.packageBinding?.descriptor;
  if (binding !== undefined && !seen.has(identity(binding.object))) {
    const read = await deps.primary.get(binding.object);
    demand(read !== null, "ARCHIVE_OBJECT_MISSING", 500);
    demand(read.object.versionId === binding.object.versionId, "ARCHIVE_IDENTITY_MISMATCH", 500);
    demand(read.bytes.byteLength === binding.sizeBytes, "INTEGRITY_MISMATCH", 500);
    const parsed = parseEnvelopeJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(read.bytes));
    demand((await hashEnvelope(binding.hashPurpose, parsed)) === binding.digest, "INTEGRITY_MISMATCH", 500);
    const sha256 = createHash("sha256").update(read.bytes).digest("hex");
    seen.set(identity(binding.object), {
      object: binding.object,
      sha256,
      sizeBytes: read.bytes.byteLength,
      backupKey: backupKeys.object(sha256),
    });
  }
  return [...seen.values()];
}

async function copyObject(deps: ReplicatorDeps, object: BackupObject) {
  if (await deps.backup.exists(object.backupKey)) {
    await deps.backup.verify(object.backupKey, object.sha256, object.sizeBytes);
    return "matched_existing" as const;
  }
  const read = await deps.primary.getStream(object.object);
  demand(read !== null, "ARCHIVE_OBJECT_MISSING", 500);
  if (read.object.versionId !== object.object.versionId || read.sizeBytes !== object.sizeBytes) {
    await read.body.cancel().catch(() => undefined);
    throw new DomainError("ARCHIVE_IDENTITY_MISMATCH", 500);
  }
  return deps.backup.putStream(object.backupKey, read.body, object.sizeBytes, object.sha256);
}

function changeRecordFor(
  transaction: CommittedTransaction,
  prepared: PreparedEnvelope,
  objects: readonly BackupObject[],
  schemaFingerprint: string,
): ChangeRecord {
  return changeRecordSchema.parse({
    format: "recovery-change-v1",
    workspace: prepared.workspace,
    epochId: transaction.epochId,
    sequence: transaction.sequence,
    transactionId: transaction.transactionId,
    transactionDigest: transaction.transactionDigest,
    previousDigest: transaction.previousDigest,
    schemaFingerprint,
    committedAt: transaction.committedAt,
    envelope: JSON.parse(transaction.prepared) as unknown,
    objects,
  });
}
/** Same transaction, same envelope, same objects. The schema fingerprint may
 * legitimately differ when a retry observes a later additive migration. */
function sameChange(left: ChangeRecord, right: ChangeRecord): boolean {
  const comparable = (record: ChangeRecord) =>
    JSON.stringify([
      record.workspace,
      record.epochId,
      record.sequence,
      record.transactionId,
      record.transactionDigest,
      record.previousDigest,
      record.committedAt,
      new TextDecoder().decode(canonicalizeEnvelope(record.envelope)),
      [...record.objects].map((object) => JSON.stringify(object)).sort(),
    ]);
  return comparable(left) === comparable(right);
}
async function writeChangeRecord(
  deps: ReplicatorDeps,
  key: string,
  transaction: CommittedTransaction,
  prepared: PreparedEnvelope,
  objects: readonly BackupObject[],
): Promise<void> {
  if (await deps.backup.exists(key)) return readChangeRecord(deps, key, transaction, prepared, objects);
  const schema = await readSchemaIdentity(deps.db);
  const record = changeRecordFor(transaction, prepared, objects, schema.fingerprint);
  try {
    await deps.backup.putBytes(key, new TextEncoder().encode(JSON.stringify(record)), "application/json");
  } catch (error) {
    if (errorCode(error) !== "BACKUP_INTEGRITY_FAULT") throw error;
    // A concurrent writer won the create; accept it only if it is the same change.
    await readChangeRecord(deps, key, transaction, prepared, objects);
  }
}
async function readChangeRecord(
  deps: ReplicatorDeps,
  key: string,
  transaction: CommittedTransaction,
  prepared: PreparedEnvelope,
  objects: readonly BackupObject[],
): Promise<void> {
  const stored = await deps.backup.readBytes(key);
  if (stored === null) throw new DomainError("BACKUP_OBJECT_MISSING", 503);
  let parsed: ChangeRecord;
  try {
    parsed = changeRecordSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(stored.bytes)));
  } catch {
    throw new DomainError("CHANGE_RECORD_CONFLICT", 500);
  }
  demand(sameChange(parsed, changeRecordFor(transaction, prepared, objects, parsed.schemaFingerprint)), "CHANGE_RECORD_CONFLICT", 500);
}

/** One receipt per sequence: reuse a stored receipt for this exact commit, or
 * sign and create one. Primary and replica observations describe the same bytes. */
async function establishReceipt(
  deps: ReplicatorDeps,
  custody: ReceiptCustody,
  transaction: CommittedTransaction,
  prepared: PreparedEnvelope,
  objects: readonly BackupObject[],
): Promise<ProtectionReceipt> {
  const workspaceId = prepared.workspace.workspaceId;
  const key = backupKeys.receipt(workspaceId, transaction.sequence);
  const existing = await deps.backup.readBytes(key);
  if (existing !== null) return storedReceipt(existing.bytes, transaction, prepared);
  const now = deps.clock();
  const inventory = archiveInventorySchema.parse({
    ...format,
    workspace: prepared.workspace,
    epochId: transaction.epochId,
    throughSequence: transaction.sequence,
    transactionDigest: transaction.transactionDigest,
    objects: prepared.objects,
    versionIds: prepared.versions.map((version) => version.versionId),
    eventIds: prepared.events.map((event) => event.eventId),
    complete: true,
  });
  const inventoryDigest = await hashEnvelope("inventory", inventory);
  const payload = {
    ...format,
    purpose: "receipt" as const,
    workspace: prepared.workspace,
    epochId: transaction.epochId,
    sequence: transaction.sequence,
    transactionDigest: transaction.transactionDigest,
    inventoryDigest,
    checkpoint: checkpointSchema.parse({
      ...format,
      workspace: prepared.workspace,
      epochId: transaction.epochId,
      sequence: transaction.sequence,
      transactionDigest: transaction.transactionDigest,
      inventoryDigest,
      checkedAt: now,
    }),
    observations: objects.flatMap((object) => [
      { object: object.object, digest: object.sha256, sizeBytes: object.sizeBytes, verifiedAt: now },
      { object: replicaRef(object.sha256), digest: object.sha256, sizeBytes: object.sizeBytes, verifiedAt: now },
    ]),
    retentionEvidence: objects.map((object) => ({
      object: replicaRef(object.sha256),
      // The binding cannot observe bucket lock rules; Terraform tests prove them.
      mode: "unknown" as const,
      retainUntil: null,
      observedAt: now,
    })),
    verifierId: VERIFIER_ID,
    verifiedAt: now,
  };
  const signature = await custody.sign({ ...format, purpose: "receipt", digest: await hashEnvelope("receipt", payload) });
  const receipt = protectionReceiptSchema.parse({ ...payload, signature });
  try {
    await deps.backup.putBytes(key, canonicalizeEnvelope(receipt), "application/json");
  } catch (error) {
    if (errorCode(error) !== "BACKUP_INTEGRITY_FAULT") throw error;
    const raced = await deps.backup.readBytes(key);
    if (raced === null) throw error;
    return storedReceipt(raced.bytes, transaction, prepared);
  }
  return receipt;
}
async function storedReceipt(bytes: Uint8Array, transaction: CommittedTransaction, prepared: PreparedEnvelope): Promise<ProtectionReceipt> {
  let receipt: ProtectionReceipt;
  try {
    receipt = protectionReceiptSchema.parse(parseEnvelopeJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)));
  } catch {
    throw new DomainError("RECEIPT_CONFLICT", 500);
  }
  demand(
    receipt.sequence === transaction.sequence &&
      receipt.epochId === transaction.epochId &&
      receipt.transactionDigest === transaction.transactionDigest &&
      receipt.workspace.workspaceId === prepared.workspace.workspaceId &&
      receipt.transactionDigest === (await hashEnvelope("transaction", unsigned(prepared))),
    "RECEIPT_CONFLICT",
    500,
  );
  return receipt;
}
