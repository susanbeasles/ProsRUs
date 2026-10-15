import {
  backupKeys,
  changeRecordSchema,
  checkpointManifestSchema,
  CHECKPOINT_KINDS,
  parseChangeKey,
  planObjectRetention,
  retainedChange,
  retainedCheckpoint,
  type RetentionCandidate,
} from "../domain/backup";
import { DomainError } from "../domain/model";
import type { BackupArchive } from "../storage/backup-archive";
import type { BackupLedger } from "../storage/backup-ledger";

/** Upper bound on deletions per run, so a planning defect cannot sweep the bucket. */
export const MAX_DELETES_PER_RUN = 1000;

export type RetentionDeps = Readonly<{ ledger: BackupLedger; backup: BackupArchive; clock: () => number }>;
export type RetentionReport = Readonly<{
  outcome: "applied" | "skipped" | "failed";
  reason: string | null;
  examined: number;
  deleted: number;
  keptReferenced: number;
  keptLocked: number;
}>;

/** Object garbage collection. Lifecycle rules expire changes, receipts and
 * checkpoints; objects have none and leave only through this pass, when no
 * retained checkpoint, retained change or current original references them and
 * their lock has expired. The bucket lock still rejects any premature delete. */
export async function runRetention(deps: RetentionDeps): Promise<RetentionReport> {
  const none = { examined: 0, deleted: 0, keptReferenced: 0, keptLocked: 0 };
  try {
    const workspace = await deps.ledger.workspace();
    if (workspace === null) return { outcome: "skipped", reason: "workspace_uninitialized", ...none };
    const now = deps.clock();
    const referenced = await deps.ledger.referencedDigests();
    // Committed history with no recorded byte identities means replication has
    // not caught up, or the ledger read is wrong. Either way: delete nothing.
    if (workspace.sequence !== "0" && referenced.size === 0)
      return { outcome: "skipped", reason: "reference_set_empty", ...none };
    for (const kind of CHECKPOINT_KINDS) {
      let cursor: string | null = null;
      do {
        const page = await deps.backup.list(backupKeys.checkpointPrefix(kind, workspace.workspaceId), cursor);
        for (const object of page.objects) {
          if (!object.key.endsWith("/manifest.json") || !retainedCheckpoint(kind, object.uploadedAt, now)) continue;
          const stored = await deps.backup.readBytes(object.key);
          if (stored === null) continue;
          const manifest = checkpointManifestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(stored.bytes)));
          for (const file of manifest.files) referenced.add(file.sha256);
        }
        cursor = page.cursor;
      } while (cursor !== null);
    }
    let cursor: string | null = null;
    do {
      const page = await deps.backup.list(backupKeys.changePrefix(workspace.workspaceId), cursor);
      for (const object of page.objects) {
        if (parseChangeKey(object.key) === null || !retainedChange(object.uploadedAt, now)) continue;
        const stored = await deps.backup.readBytes(object.key);
        if (stored === null) continue;
        const record = changeRecordSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(stored.bytes)));
        for (const file of record.objects) referenced.add(file.sha256);
      }
      cursor = page.cursor;
    } while (cursor !== null);
    const candidates: RetentionCandidate[] = [];
    cursor = null;
    do {
      const page = await deps.backup.list("objects/sha256/", cursor);
      for (const object of page.objects)
        candidates.push({ key: object.key, sha256: object.key.slice(object.key.lastIndexOf("/") + 1), uploadedAt: object.uploadedAt });
      cursor = page.cursor;
    } while (cursor !== null);
    const plan = planObjectRetention({ objects: candidates, referenced, now });
    let deleted = 0;
    for (const key of plan.delete.slice(0, MAX_DELETES_PER_RUN)) {
      await deps.backup.remove(key);
      deleted += 1;
    }
    return {
      outcome: "applied",
      reason: plan.delete.length > MAX_DELETES_PER_RUN ? "delete_limit_reached" : null,
      examined: candidates.length,
      deleted,
      keptReferenced: plan.keptReferenced,
      keptLocked: plan.keptLocked,
    };
  } catch (error) {
    return { outcome: "failed", reason: error instanceof DomainError ? error.code.toLowerCase() : "unexpected_retention_error", ...none };
  }
}
