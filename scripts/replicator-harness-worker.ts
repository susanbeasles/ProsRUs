// Local Workerd harness for the replicator acceptance tests. It composes the
// production replicator, checkpoint, retention, restore and status code over
// Miniflare D1/R2. Fault switches exist only here, never in src/.
import { deriveRecoveryStatus } from "../src/domain/backup";
import { DomainError } from "../src/domain/model";
import { runCheckpoint } from "../src/replicator/checkpoint";
import { loadReceiptCustody } from "../src/replicator/receipt-custody";
import { replicateJob, sweepOutbox, type ReplicatorDeps } from "../src/replicator/replicate";
import { restoreFromBackup, type RestoreMigration } from "../src/replicator/restore";
import { runRetention } from "../src/replicator/retention";
import { createBackupArchive, type BackupArchive } from "../src/storage/backup-archive";
import { createBackupLedger } from "../src/storage/backup-ledger";
import { createPrimaryArchive } from "../src/storage/primary-archive";
import { createRecoveryStore } from "../src/storage/recovery-store";
import { restoredVersionResolver } from "../src/storage/restored-objects";
import { verifyArtifact } from "../src/storage/recovery-streams";
import type { BlobDescriptor } from "../src/domain/recovery";
import type { RecoveryJobLease } from "../src/application/recovery-ports";

type Env = Record<string, unknown> & {
  DB: D1Database;
  ORIGINALS: R2Bucket;
  BACKUP: R2Bucket;
  OWNER_ID: string;
  RECEIPT_KEY: string;
};
type Options = { clockOffsetMs?: number; failCopies?: number; custody?: boolean };

async function compose(env: Env, options: Options): Promise<ReplicatorDeps> {
  let failures = options.failCopies ?? 0;
  const real = createBackupArchive(env.BACKUP);
  const backup: BackupArchive = {
    ...real,
    async putStream(key, body, size, sha256) {
      if (failures > 0) {
        failures -= 1;
        await body.cancel().catch(() => undefined);
        throw new DomainError("BACKUP_WRITE_FAILED", 503);
      }
      return real.putStream(key, body, size, sha256);
    },
  };
  return {
    store: createRecoveryStore(env.DB, env.OWNER_ID),
    ledger: createBackupLedger(env.DB, env.OWNER_ID),
    db: env.DB,
    primary: createPrimaryArchive(env.ORIGINALS),
    backup,
    custody: options.custody === false ? null : await loadReceiptCustody(env.RECEIPT_KEY),
    clock: () => Date.now() + (options.clockOffsetMs ?? 0),
    leaseOwner: `harness-${crypto.randomUUID()}`,
  };
}
function target(env: Env, name: string) {
  const db = env[`RESTORE_DB_${name}`] as D1Database | undefined;
  const originals = env[`RESTORE_ORIGINALS_${name}`] as R2Bucket | undefined;
  if (db === undefined || originals === undefined) throw new DomainError("UNKNOWN_RESTORE_TARGET", 404);
  return { db, originals };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    const body = (request.method === "POST" ? await request.json() : {}) as Record<string, unknown> & Options;
    try {
      const deps = await compose(env, body);
      if (path === "/sweep") return Response.json(await sweepOutbox(deps));
      if (path === "/checkpoint") return Response.json(await runCheckpoint(deps, body.kind as "daily" | "monthly"));
      if (path === "/retention") return Response.json(await runRetention(deps));
      if (path === "/status") {
        const now = deps.clock();
        const facts = await deps.ledger.statusFacts(String(body.workspaceId));
        return Response.json(facts === null ? { state: "unavailable" } : deriveRecoveryStatus(facts, now));
      }
      if (path === "/claim-only") {
        const [due] = await deps.ledger.dueJobs(deps.clock(), 1);
        if (due === undefined) return Response.json(null);
        return Response.json(await deps.store.claimJob(due.jobId, "crashed-worker", deps.clock(), 60_000));
      }
      if (path === "/resume-lease") {
        // A worker that held a lease which has since been taken over.
        return Response.json(await replicateJob(deps, body.lease as RecoveryJobLease));
      }
      if (path === "/restore") {
        const custody = await loadReceiptCustody(env.RECEIPT_KEY);
        return Response.json(
          await restoreFromBackup({
            backup: createBackupArchive(env.BACKUP),
            backupBucket: env.BACKUP,
            target: target(env, String(body.target)),
            ownerId: env.OWNER_ID,
            workspaceId: String(body.workspaceId),
            targetSequence: (body.targetSequence as string | null) ?? null,
            migrations: (body.migrations as RestoreMigration[] | undefined) ?? [],
            migrationLedger: "runtime_migrations",
            restoreId: String(body.restoreId),
            clock: deps.clock,
            trust: body.trust === true ? (custody?.verificationKey ?? null) : null,
          }),
        );
      }
      if (path === "/read-restored") {
        // Read a pinned original from the restored bucket through the alias and
        // verify its recovery digest, exactly as the product would.
        const restored = target(env, String(body.target));
        const archive = createPrimaryArchive(restored.originals, restoredVersionResolver(restored.db));
        await verifyArtifact(archive, body.descriptor as BlobDescriptor);
        return Response.json({ verified: true });
      }
      if (path === "/overwrite-backup") {
        await env.BACKUP.put(String(body.key), String(body.text));
        return Response.json({ ok: true });
      }
      if (path === "/delete-original") {
        await env.ORIGINALS.delete(String(body.key));
        return Response.json({ ok: true });
      }
      if (path === "/list") {
        const named: Record<string, R2Bucket | undefined> = { BACKUP: env.BACKUP, ORIGINALS: env.ORIGINALS, UPLOADS: env.UPLOADS as R2Bucket | undefined };
        const bucket = named[String(body.bucket)] ?? target(env, String(body.bucket)).originals;
        const keys: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await bucket.list({ prefix: String(body.prefix ?? ""), ...(cursor ? { cursor } : {}) });
          keys.push(...page.objects.map((object) => object.key));
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        return Response.json(keys);
      }
      return new Response(null, { status: 404 });
    } catch (error) {
      return Response.json(
        { error: error instanceof DomainError ? error.code : error instanceof Error ? error.message : "unknown" },
        { status: 500 },
      );
    }
  },
};
