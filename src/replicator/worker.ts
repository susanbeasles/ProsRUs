import { z } from "zod";
import { PROTECTION_THRESHOLDS } from "../domain/backup";
import { createBackupArchive } from "../storage/backup-archive";
import { createBackupLedger } from "../storage/backup-ledger";
import { createPrimaryArchive } from "../storage/primary-archive";
import { createRecoveryStore } from "../storage/recovery-store";
import { runCheckpoint } from "./checkpoint";
import { loadReceiptCustody } from "./receipt-custody";
import { sweepOutbox, type ReplicatorDeps } from "./replicate";
import { runRetention } from "./retention";

/** Bindings of `job-stack-<env>-replicator`. BACKUP is bound here and nowhere
 * else; the product Worker cannot reach it. */
export interface ReplicatorEnv {
  DB: D1Database;
  ORIGINALS: R2Bucket;
  BACKUP: R2Bucket;
  OWNER_ID: string;
  RECEIPT_SIGNING_KEY?: { get(): Promise<string> };
}

export const CRONS = Object.freeze({
  sweep: "*/5 * * * *",
  daily: "23 3 * * *",
  monthly: "53 3 1 * *",
});
const ownerSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

/** Counts and categories only: no identifiers, payloads or key material. */
function log(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ...fields }));
}

async function compose(env: ReplicatorEnv): Promise<ReplicatorDeps | null> {
  const owner = ownerSchema.safeParse(env.OWNER_ID);
  if (!owner.success) return null;
  let secret: string | null = null;
  try {
    secret = (await env.RECEIPT_SIGNING_KEY?.get()) ?? null;
  } catch {
    secret = null;
  }
  return {
    store: createRecoveryStore(env.DB, owner.data),
    ledger: createBackupLedger(env.DB, owner.data),
    db: env.DB,
    primary: createPrimaryArchive(env.ORIGINALS),
    backup: createBackupArchive(env.BACKUP),
    custody: await loadReceiptCustody(secret),
    clock: () => Date.now(),
    leaseOwner: `replicator-${crypto.randomUUID()}`,
  };
}

export async function runScheduled(cron: string, env: ReplicatorEnv): Promise<void> {
  const deps = await compose(env);
  if (deps === null) {
    log("replicator.unconfigured", { cron });
    return;
  }
  if (deps.custody === null) log("replicator.receipt_custody_unavailable", { cron });
  if (cron === CRONS.sweep) {
    const report = await sweepOutbox(deps);
    const tally: Record<string, number> = {};
    for (const job of report.processed) {
      const key = job.errorCategory ?? job.status;
      tally[key] = (tally[key] ?? 0) + 1;
    }
    log("replicator.sweep", { jobs: report.processed.length, outcomes: tally, ms: report.finishedAt - report.startedAt });
    // Catch-up: a missed or failed daily run must not leave the workspace without
    // a fresh verified checkpoint until the next 03:23.
    const latest = await deps.ledger.latestCheckpoint();
    if (latest === null || deps.clock() - latest.verifiedAt > PROTECTION_THRESHOLDS.checkpointFreshMs) {
      const checkpoint = await runCheckpoint(deps, "daily");
      log("replicator.checkpoint", { kind: checkpoint.kind, outcome: checkpoint.outcome, reason: checkpoint.reason, tables: checkpoint.tables, files: checkpoint.files });
    }
    return;
  }
  if (cron === CRONS.daily) {
    const checkpoint = await runCheckpoint(deps, "daily");
    log("replicator.checkpoint", { kind: checkpoint.kind, outcome: checkpoint.outcome, reason: checkpoint.reason, tables: checkpoint.tables, files: checkpoint.files });
    const retention = await runRetention(deps);
    log("replicator.retention", retention);
    return;
  }
  if (cron === CRONS.monthly) {
    const checkpoint = await runCheckpoint(deps, "monthly");
    log("replicator.checkpoint", { kind: checkpoint.kind, outcome: checkpoint.outcome, reason: checkpoint.reason, tables: checkpoint.tables, files: checkpoint.files });
    return;
  }
  log("replicator.unknown_cron", { cron });
}

export default {
  /** No route, no workers.dev subdomain: nothing is served. */
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
  scheduled(controller: ScheduledController, env: ReplicatorEnv, ctx: ExecutionContext): void {
    ctx.waitUntil(runScheduled(controller.cron, env));
  },
};
