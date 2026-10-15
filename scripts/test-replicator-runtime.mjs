import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { exportJWK, generateKeyPair } from "jose";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { applyMigrations, splitMigrationSql } from "./runtime-migrations.mjs";

// Acceptance for ADR 0004 in real local Workerd: real commands commit real
// transactions; the production replicator, checkpoint, restore, retention and
// status code run against the same D1/R2. Synthetic keys only; no network.
process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
const bundle = async (options) =>
  (await build({ bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    external: ["cloudflare:workers", "node:*"], ...options })).outputFiles[0].text;
const productScript = await bundle({ stdin: { contents: "export {default,JobStack,Coordinator} from './src/worker';", resolveDir: process.cwd() } });
const harnessScript = await bundle({ entryPoints: ["scripts/replicator-harness-worker.ts"] });
const authorityScript = await bundle({ stdin: { resolveDir: process.cwd(), contents: `
  import {WorkerEntrypoint} from 'cloudflare:workers';
  import {syntheticControl} from './tests/fixtures/command-control';
  let control = null;
  const current = env => (control ??= syntheticControl({ privateJwk: JSON.parse(env.SIGNING_JWK) }));
  export class FixtureAuthority extends WorkerEntrypoint {
    async revalidate(value) { return current(this.env).authority.revalidate(value); }
    async signPreparation(value) { return current(this.env).authority.signPreparation(value); }
  }
  export default {async fetch(request, env) { current(env).reset(); return new Response(null, { status: 204 }); }};
` } });
const clientScript = `export default {async fetch(request, env) {
  try {
    if (new URL(request.url).pathname === '/chunk')
      return Response.json(await env.PRODUCT.invokeCore(JSON.parse(request.headers.get('x-invocation')), request.body));
    return Response.json(await env.PRODUCT.invokeCore(await request.json()));
  } catch (error) { return Response.json({ error: error.message }, { status: 403 }); }
}};`;

const controlKeys = await generateKeyPair("ES256", { extractable: true });
const controlPublic = await exportJWK(controlKeys.publicKey);
const trustRoot = JSON.stringify({ format: "recovery-trust-root-v1", keyId: "synthetic-control", algorithm: "ES256",
  publicJwk: { kty: controlPublic.kty, crv: controlPublic.crv, x: controlPublic.x, y: controlPublic.y } });
const receiptKeys = await generateKeyPair("ES256", { extractable: true });
const receiptJwk = await exportJWK(receiptKeys.privateKey);
const receiptKey = JSON.stringify({ format: "recovery-signing-key-v1", keyId: "synthetic-replicator", algorithm: "ES256",
  privateJwk: { kty: receiptJwk.kty, crv: receiptJwk.crv, x: receiptJwk.x, y: receiptJwk.y, d: receiptJwk.d } });

const TARGETS = ["A", "B", "C", "D", "E"];
const common = { modules: true, compatibilityDate: "2026-10-08", compatibilityFlags: ["nodejs_compat"], cf: false };
const denyOutbound = () => { throw Error("unexpected-outbound"); };
const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false, host: "127.0.0.1", outboundService: denyOutbound,
  workers: [
    { ...common, name: "client", script: clientScript, serviceBindings: { PRODUCT: { name: "product", entrypoint: "JobStack" } } },
    { ...common, name: "product", script: productScript, d1Databases: { DB: "primary" }, r2Buckets: { ORIGINALS: "originals", UPLOADS: "uploads" },
      durableObjects: { COORDINATOR: { className: "Coordinator", useSQLite: true } }, bindings: { RECOVERY_TRUST_ROOT: trustRoot },
      serviceBindings: { CONTROL_AUTHORITY: { name: "authority", entrypoint: "FixtureAuthority" }, ASSETS: denyOutbound } },
    { ...common, name: "authority", script: authorityScript, bindings: { SIGNING_JWK: JSON.stringify(await exportJWK(controlKeys.privateKey)) } },
    { ...common, name: "replicator", script: harnessScript,
      d1Databases: { DB: "primary", ...Object.fromEntries(TARGETS.map((t) => [`RESTORE_DB_${t}`, `restore-${t}`])) },
      r2Buckets: { ORIGINALS: "originals", UPLOADS: "uploads", BACKUP: "backup", ...Object.fromEntries(TARGETS.map((t) => [`RESTORE_ORIGINALS_${t}`, `restore-originals-${t}`])) },
      bindings: { OWNER_ID: "owner_fixture", RECEIPT_KEY: receiptKey } },
  ],
}));

let checks = 0;
const pass = (message) => console.log(`PASS ${++checks}: ${message}`);
const WORKSPACE = "workspace_fixture";
const HOUR = 3_600_000, DAY = 24 * HOUR;
try {
  const db = await mf.getD1Database("DB", "product");
  await applyMigrations(db);
  const authority = await mf.getWorker("authority");
  const harness = await mf.getWorker("replicator");
  const call = async (path, body = {}) => {
    const response = await harness.fetch(`https://harness.invalid${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const value = await response.json();
    if (response.status !== 200) throw Object.assign(Error(value.error ?? `harness ${path} ${response.status}`), { code: value.error });
    return value;
  };
  let serial = 0;
  async function invoke(operationId, input) {
    await authority.fetch("https://fixture.invalid/reset");
    const response = await mf.dispatchFetch("https://fixture.invalid/invoke", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contract: "job-stack.shared-auth.v1", invocationId: `inv_${++serial}`, operationId, input: { workspaceId: WORKSPACE, ...input } }) });
    const body = await response.json();
    assert.equal(response.status, 200, `${operationId}: ${JSON.stringify(body)}`);
    return body;
  }
  async function chunk(input, bytes) {
    await authority.fetch("https://fixture.invalid/reset");
    const response = await mf.dispatchFetch("https://fixture.invalid/chunk", { method: "POST", body: bytes, headers: { "x-invocation":
      JSON.stringify({ contract: "job-stack.shared-auth.v1", invocationId: `inv_${++serial}`, operationId: "job-stack.upload.chunk.v1", input: { workspaceId: WORKSPACE, ...input } }) } });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  }
  const status = (clockOffsetMs = 0) => call("/status", { workspaceId: WORKSPACE, clockOffsetMs });
  const original = (size, name) => ({ sizeBytes: size, fileName: name, mediaType: "text/plain", format: null, lastModified: null });
  /** Begin, store one chunk, complete and save: a committed exact original. */
  async function uploadAndSave(tag, text) {
    const bytes = new TextEncoder().encode(text);
    const begun = await invoke("job-stack.upload.begin.v1", { requestKey: `begin-${tag}`, original: original(bytes.length, `${tag}.txt`), purpose: { kind: "profile-source" } });
    await chunk({ requestKey: `chunk-${tag}`, uploadHandle: begun.uploadHandle, ordinal: 0, sizeBytes: bytes.length, transportSha256: createHash("sha256").update(bytes).digest("hex") }, bytes);
    await invoke("job-stack.upload.complete.v1", { requestKey: `complete-${tag}`, uploadHandle: begun.uploadHandle });
    const saved = await invoke("job-stack.version.save.v1", { requestKey: `save-${tag}`, lineageId: `lineage-${tag}`, entityId: `entity-${tag}`, kind: "resume",
      expectedParentIds: [], sourceVersionIds: [], branchRequested: false, uploadHandle: begun.uploadHandle });
    return { saved, manifest: await invoke("job-stack.version.read.v1", { versionId: saved.versionId }) };
  }
  const capture = { company: "Example", role: "Staff Engineer", sourceUrl: "https://example.com/jobs/1", description: "Build reliable systems",
    terms: { employment: "full_time", baseUsd: 240000, hourlyUsd: null, remote: true, match401k: null, zeroPremium: null, affordableCare: null } };
  const keys = (bucket, prefix) => call("/list", { bucket, prefix });
  const rows = async (database, sql) => (await database.prepare(sql).all()).results;

  // --- Nothing committed: no evidence, so never "protected".
  assert.equal((await status()).state, "unavailable");
  pass("an uninitialized workspace reports unavailable, not protected");

  // --- tx1 and its replication; an early checkpoint two days ago (stale).
  const opportunity = await invoke("job-stack.opportunity.capture.v1", { requestKey: "capture-1", body: capture });
  let report = await status();
  assert.equal(report.state, "protection_pending");
  assert.equal(report.lag.pendingTransactions, 1);
  assert.equal(report.latestVerified, null);
  let sweep = await call("/sweep");
  assert.deepEqual(sweep.processed.map((job) => [job.sequence, job.status]), [["1", "completed"]]);
  const early = await call("/checkpoint", { kind: "daily", clockOffsetMs: -2 * DAY });
  assert.equal(early.outcome, "verified", JSON.stringify(early));
  assert.equal(early.sequence, "1");
  report = await status();
  assert.equal(report.lag.pendingTransactions, 0);
  assert.equal(report.state, "degraded", "verified history without a checkpoint inside 26h is not protected");
  pass("pending work is protection_pending; verified history with only a stale checkpoint is degraded, never protected");

  // --- tx2 (structured save), tx3 (uploaded original), plus an interrupted upload.
  await invoke("job-stack.version.save.v1", { requestKey: "save-structured", lineageId: "lineage-notes", entityId: "notes-1", kind: "resume",
    expectedParentIds: [], sourceVersionIds: [], branchRequested: false, content: { text: "Synthetic resume" } });
  const uploaded = await uploadAndSave("resume", "hello recovery");
  const interrupted = await invoke("job-stack.upload.begin.v1", { requestKey: "begin-interrupted", original: original(5, "never.txt"), purpose: { kind: "profile-source" } });
  await chunk({ requestKey: "chunk-interrupted", uploadHandle: interrupted.uploadHandle, ordinal: 0, sizeBytes: 5,
    transportSha256: createHash("sha256").update("never").digest("hex") }, new TextEncoder().encode("never"));

  // Interrupted replication: the first object copy fails; successors wait for their predecessor.
  sweep = await call("/sweep", { failCopies: 1 });
  assert.deepEqual(sweep.processed.map((job) => [job.sequence, job.status, job.errorCategory]), [
    ["2", "retryable", "backup_write_failed"], ["3", "retryable", "awaiting_predecessor"]]);
  assert.equal((await status()).state, "protection_pending");
  sweep = await call("/sweep", { clockOffsetMs: 2 * HOUR });
  assert.deepEqual(sweep.processed.map((job) => [job.sequence, job.status]), [["2", "completed"], ["3", "completed"]]);
  assert.equal((await rows(db, "SELECT count(*) AS n FROM recovery_protection_receipts"))[0].n, 3);
  assert.deepEqual((await rows(db, "SELECT DISTINCT json_extract(view,'$.replication') AS r FROM recovery_protection")).map((r) => r.r), ["verified_both"]);
  pass("an interrupted copy retries with backoff, ordering holds (N waits for N-1), and every version projects verified_both");

  const checkpoint = await call("/checkpoint", { kind: "daily" });
  assert.equal(checkpoint.outcome, "verified", JSON.stringify(checkpoint));
  assert.equal(checkpoint.sequence, "3");
  assert.ok(checkpoint.signed);
  report = await status();
  assert.equal(report.state, "protected");
  assert.equal(report.latestVerified.sequence, "3");
  assert.equal(report.latestCheckpoint.position.sequence, "3");
  assert.equal(report.state, "protected");
  assert.equal((await status(27 * HOUR)).state, "degraded", "protection expires when the checkpoint ages past 26h");
  const viaProduct = await invoke("job-stack.recovery.status.read.v1", {});
  assert.deepEqual({ ...viaProduct, observedAt: 0, lag: { ...viaProduct.lag } }, { ...report, observedAt: 0, lag: { ...report.lag } });
  pass("protected only when every committed transaction is verified and a verified checkpoint is under 26h old; job_stack_recovery_status returns the same through the product");

  // --- Duplicate delivery: crash after put (no custody), then a re-run.
  await invoke("job-stack.opportunity.capture.v1", { requestKey: "capture-4", body: { ...capture, role: "Principal Engineer", sourceUrl: "https://example.com/jobs/4" } });
  sweep = await call("/sweep", { custody: false });
  assert.deepEqual(sweep.processed.map((job) => [job.sequence, job.status, job.errorCategory]), [["4", "retryable", "receipt_custody_unavailable"]]);
  assert.equal((await status()).state, "protection_pending", "a copy without a receipt is still pending");
  sweep = await call("/sweep", { clockOffsetMs: HOUR });
  assert.deepEqual(sweep.processed.map((job) => [job.sequence, job.status, job.objectsCreated]), [["4", "completed", 0]]);
  assert.ok(sweep.processed[0].objectsMatched > 0);
  assert.equal((await keys("BACKUP", `receipts/${WORKSPACE}/`)).filter((k) => k.endsWith("00000000000000000004.json")).length, 1);
  assert.equal((await keys("BACKUP", `changes/${WORKSPACE}/00000000000000000004-`)).length, 1);
  // Lease takeover: a crashed worker's lease expires; the new owner finishes; the old lease is fenced out.
  await invoke("job-stack.opportunity.capture.v1", { requestKey: "capture-5", body: { ...capture, role: "Director", sourceUrl: "https://example.com/jobs/5" } });
  const stale = await call("/claim-only");
  assert.equal(stale.owner, "crashed-worker");
  assert.deepEqual((await call("/sweep")).processed, [], "a live lease is not stolen");
  sweep = await call("/sweep", { clockOffsetMs: 2 * 60_000 });
  assert.deepEqual(sweep.processed.map((job) => [job.sequence, job.status]), [["5", "completed"]]);
  const resumed = await call("/resume-lease", { lease: stale, clockOffsetMs: 3 * 60_000 });
  assert.equal(resumed.status, "stale_fence");
  assert.equal((await rows(db, "SELECT count(*) AS n FROM recovery_protection_receipts AS r JOIN recovery_transactions AS t USING(owner,workspace_id,transaction_id) WHERE t.sequence IN ('4','5')"))[0].n, 2);
  pass("duplicate delivery and lease takeover are idempotent: matched_existing copies, exactly one change and one receipt per sequence, stale lease fenced");

  // --- Deletion: lose a primary original, then restore everything into a NEW database and bucket.
  const blob = uploaded.manifest.artifacts[0];
  await call("/delete-original", { key: `${blob.object.namespace}/${blob.object.key}` });
  const restored = await call("/restore", { target: "A", workspaceId: WORKSPACE, targetSequence: null, restoreId: "restore-a", trust: true });
  assert.equal(restored.outcome, "complete", JSON.stringify(restored));
  assert.deepEqual([restored.checkpoint.checkpointId.startsWith("daily-"), restored.checkpoint.sequence, restored.checkpoint.signed], [true, "3", true]);
  assert.equal(restored.replayed.count, 2);
  assert.equal(restored.restoredThrough.sequence, "5");
  const restoredDb = await mf.getD1Database("RESTORE_DB_A", "replicator");
  for (const table of ["records", "source_keys", "recovery_chains", "recovery_versions", "recovery_heads", "recovery_projections", "recovery_request_results", "recovery_lineages", "recovery_events"])
    assert.deepEqual(await rows(restoredDb, `SELECT * FROM ${table} ORDER BY 1,2,3`), await rows(db, `SELECT * FROM ${table} ORDER BY 1,2,3`), table);
  assert.deepEqual(await rows(restoredDb, "SELECT transaction_id,sequence,transaction_digest,previous_digest FROM recovery_transactions ORDER BY length(sequence),sequence"),
    await rows(db, "SELECT transaction_id,sequence,transaction_digest,previous_digest FROM recovery_transactions ORDER BY length(sequence),sequence"));
  assert.deepEqual(await call("/read-restored", { target: "A", descriptor: blob }), { verified: true });
  assert.equal((await keys("A", `${blob.object.namespace}/uploads/`)).length, 0, "temporary upload sessions are never restored");
  assert.equal((await keys("ORIGINALS", `${blob.object.namespace}/uploads/`)).length, 0, "upload state never enters the retained originals bucket");
  assert.ok((await keys("UPLOADS", `${blob.object.namespace}/uploads/`)).some((key) => key.includes(interrupted.uploadHandle)), "the interrupted session stays in the uploads bucket");
  assert.ok(restored.files.count >= 2);
  pass("after deleting a primary file, restore rebuilds DB + files consistently in a new database: rows match, the pinned original verifies through its alias, no upload residue");

  // --- Point in time: restore to before tx3 from the earlier checkpoint.
  const pointInTime = await call("/restore", { target: "B", workspaceId: WORKSPACE, targetSequence: "2", restoreId: "restore-b", trust: true });
  assert.deepEqual([pointInTime.outcome, pointInTime.checkpoint.sequence, pointInTime.restoredThrough.sequence], ["complete", "1", "2"]);
  const pitDb = await mf.getD1Database("RESTORE_DB_B", "replicator");
  assert.equal((await rows(pitDb, "SELECT count(*) AS n FROM recovery_transactions"))[0].n, 2);
  assert.equal((await rows(pitDb, "SELECT count(*) AS n FROM recovery_versions WHERE lineage_id='lineage-resume'"))[0].n, 0);
  assert.deepEqual(await rows(pitDb, "SELECT * FROM records ORDER BY 1,2,3"), await rows(db, `SELECT * FROM records WHERE id='${opportunity.entityId}' ORDER BY 1,2,3`));
  pass("point-in-time restore replays exactly through the target sequence from the newest earlier checkpoint");

  // --- Failed migration.
  const good = { name: "0007_fixture_additive.sql", sql: splitMigrationSql("CREATE TABLE fixture_notes(id TEXT PRIMARY KEY, body TEXT NOT NULL);") };
  for (const statement of good.sql) await db.prepare(statement).run();
  await db.prepare("INSERT INTO runtime_migrations(name) VALUES(?)").bind(good.name).run();
  await invoke("job-stack.opportunity.capture.v1", { requestKey: "capture-6", body: { ...capture, role: "Architect", sourceUrl: "https://example.com/jobs/6" } });
  assert.deepEqual((await call("/sweep")).processed.map((job) => [job.sequence, job.status]), [["6", "completed"]]);
  // A migration that fails half way (its first statement applied, the second rejected).
  await db.prepare("CREATE TABLE fixture_half(id TEXT)").run();
  await assert.rejects(db.prepare("INSERT INTO fixture_missing(id) VALUES('x')").run());
  await invoke("job-stack.opportunity.capture.v1", { requestKey: "capture-7", body: { ...capture, role: "Fellow", sourceUrl: "https://example.com/jobs/7" } });
  assert.deepEqual((await call("/sweep")).processed.map((job) => [job.sequence, job.status]), [["7", "completed"]]);
  const migrated = await call("/restore", { target: "C", workspaceId: WORKSPACE, targetSequence: null, restoreId: "restore-c", trust: true, migrations: [good] });
  assert.equal(migrated.outcome, "partial");
  assert.deepEqual(migrated.schema.migrationsApplied, [good.name]);
  assert.deepEqual(migrated.restoredThrough.sequence, "6");
  assert.deepEqual(migrated.stoppedAt, { sequence: "7", reason: "schema_migration_required" });
  const migratedDb = await mf.getD1Database("RESTORE_DB_C", "replicator");
  assert.equal((await rows(migratedDb, "SELECT count(*) AS n FROM sqlite_schema WHERE name='fixture_half'"))[0].n, 0, "the half-applied migration is not restored");
  for (const statement of splitMigrationSql("CREATE TABLE fixture_half(id TEXT PRIMARY KEY); INSERT INTO fixture_half(id) VALUES('fixed');"))
    await migratedDb.prepare(statement).run();
  const withoutMigration = await call("/restore", { target: "D", workspaceId: WORKSPACE, targetSequence: null, restoreId: "restore-d", trust: true });
  assert.deepEqual([withoutMigration.outcome, withoutMigration.restoredThrough.sequence, withoutMigration.stoppedAt?.reason], ["partial", "5", "schema_migration_required"]);
  pass("after a failed migration, restore yields the consistent state at the last compatible change, applies only provided migrations, and the corrected migration then applies cleanly");

  // --- Integrity: a corrupted backup object is detected, never silently restored.
  const uploadedSha = createHash("sha256").update("hello recovery").digest("hex");
  const objectKey = `objects/sha256/${uploadedSha.slice(0, 2)}/${uploadedSha}`;
  assert.ok((await keys("BACKUP", "objects/sha256/")).includes(objectKey));
  await call("/overwrite-backup", { key: objectKey, text: "corrupted" });
  await assert.rejects(call("/restore", { target: "E", workspaceId: WORKSPACE, targetSequence: null, restoreId: "restore-e", trust: true }));
  const monthly = await call("/checkpoint", { kind: "monthly" });
  assert.deepEqual([monthly.outcome, monthly.reason], ["failed", "backup_integrity_fault"]);
  pass("a corrupted backup object fails restore and fails checkpoint verification");

  // --- Retention: referenced objects are kept forever; an orphan goes only after its lock.
  const orphanSha = createHash("sha256").update("orphan").digest("hex");
  await call("/overwrite-backup", { key: `objects/sha256/${orphanSha.slice(0, 2)}/${orphanSha}`, text: "orphan" });
  const early_ = await call("/retention");
  assert.deepEqual([early_.outcome, early_.deleted], ["applied", 0]);
  const late = await call("/retention", { clockOffsetMs: 400 * DAY });
  assert.deepEqual([late.outcome, late.deleted], ["applied", 1]);
  assert.ok(late.keptReferenced >= 2);
  pass("retention deletes only unreferenced objects whose lock has expired");

  // --- A lost primary file before replication quarantines the job and reports failed.
  const doomed = await uploadAndSave("doomed", "this file disappears");
  const doomedBlob = doomed.manifest.artifacts[0];
  await call("/delete-original", { key: `${doomedBlob.object.namespace}/${doomedBlob.object.key}` });
  sweep = await call("/sweep");
  assert.deepEqual(sweep.processed.map((job) => [job.status, job.errorCategory]), [["quarantined", "archive_object_missing"]]);
  report = await status();
  assert.equal(report.state, "failed");
  assert.equal(report.deadLetters, 1);
  assert.equal((await invoke("job-stack.recovery.status.read.v1", {})).state, "failed");
  pass("a primary object missing at replication quarantines the job and the status is failed");
  console.log(`replicator runtime: ${checks} checks passed`);
} finally {
  await mf.dispose();
}
