import { z } from "zod";
import { parseTrustRoot } from "../application/commands/control-signer";
import { createBackupArchive } from "../storage/backup-archive";
import { restoreFromBackup } from "./restore";

/** Operator restore entry (ADR 0004). It is never a deployment target: an
 * operator runs it with `wrangler dev -c wrangler.restore.jsonc`, whose remote
 * bindings point at the backup bucket (read) and a NEW database and originals
 * bucket created through the root provisioning path. It answers only loopback
 * requests and only when RESTORE_MODE is explicitly `operator-local`. */
interface RestoreEnv {
  RESTORE_MODE?: string;
  OWNER_ID: string;
  BACKUP: R2Bucket;
  TARGET_DB: D1Database;
  TARGET_ORIGINALS: R2Bucket;
  /** Public recovery-trust-root-v1 of the replicator's receipt key. */
  RECEIPT_TRUST_ROOT?: string;
}
const requestSchema = z
  .object({
    workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    targetSequence: z.string().regex(/^(0|[1-9][0-9]{0,19})$/).nullable(),
    restoreId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    migrations: z
      .array(z.object({ name: z.string().regex(/^[0-9]{4}[A-Za-z0-9_.-]{0,96}$/), sql: z.array(z.string().max(200_000)).max(2000) }).strict())
      .max(500),
    requireSignedCheckpoint: z.boolean(),
  })
  .strict();

export default {
  async fetch(request: Request, env: RestoreEnv): Promise<Response> {
    const url = new URL(request.url);
    if (env.RESTORE_MODE !== "operator-local" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      return new Response(null, { status: 404 });
    if (request.method !== "POST" || url.pathname !== "/restore") return new Response(null, { status: 404 });
    const input = requestSchema.parse(await request.json());
    const trust = await parseTrustRoot(env.RECEIPT_TRUST_ROOT);
    if (input.requireSignedCheckpoint && trust === null)
      return Response.json({ error: "receipt-trust-root-required" }, { status: 400 });
    try {
      const report = await restoreFromBackup({
        backup: createBackupArchive(env.BACKUP),
        backupBucket: env.BACKUP,
        target: { db: env.TARGET_DB, originals: env.TARGET_ORIGINALS },
        ownerId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).parse(env.OWNER_ID),
        workspaceId: input.workspaceId,
        targetSequence: input.targetSequence,
        migrations: input.migrations,
        migrationLedger: "d1_migrations",
        restoreId: input.restoreId,
        clock: () => Date.now(),
        trust: input.requireSignedCheckpoint ? trust : null,
      });
      return Response.json(report);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "restore-failed";
      return Response.json({ error: code }, { status: 500 });
    }
  },
};
