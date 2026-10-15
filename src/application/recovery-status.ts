import { deriveRecoveryStatus, recoveryStatusSchema, type RecoveryStatus } from "../domain/backup";
import { createBackupLedger } from "../storage/backup-ledger";

/** `job_stack_recovery_status`: the latest verified recoverable point and the
 * replication lag, derived only from replicator evidence rows. A workspace with
 * no bound recovery chain has no evidence and is reported unavailable. */
export async function readRecoveryStatus(
  db: D1Database,
  ownerId: string,
  workspaceId: string,
  now: number,
): Promise<RecoveryStatus> {
  const facts = await createBackupLedger(db, ownerId).statusFacts(workspaceId);
  if (facts !== null) return deriveRecoveryStatus(facts, now);
  return recoveryStatusSchema.parse({
    format: "recovery-status-v1",
    workspaceId,
    state: "unavailable",
    head: null,
    latestVerified: null,
    latestCheckpoint: null,
    lag: { pendingTransactions: 0, oldestPendingAt: null, seconds: null },
    deadLetters: 0,
    observedAt: now,
  });
}
