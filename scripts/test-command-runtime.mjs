import assert from "node:assert/strict";
import { build } from "esbuild";
import { exportJWK, generateKeyPair } from "jose";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { applyMigrations } from "./runtime-migrations.mjs";

// Real Workerd composition: client -> private JobStack -> Coordinator DO -> D1/R2,
// with a clearly synthetic current-authority/signing service. No provider effects.
process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
async function bundle(contents) {
  return (await build({
    stdin: { contents, resolveDir: process.cwd() }, bundle: true, write: false,
    format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:*"],
  })).outputFiles[0].text;
}
const productScript = await bundle("export {default,JobStack,Coordinator} from './src/worker';");
const authorityScript = await bundle(`
  import {WorkerEntrypoint} from 'cloudflare:workers';
  import {syntheticControl} from './tests/fixtures/command-control';
  let control = null;
  const current = env => (control ??= syntheticControl({ privateJwk: JSON.parse(env.SIGNING_JWK) }));
  export class FixtureAuthority extends WorkerEntrypoint {
    async revalidate(value) { return current(this.env).authority.revalidate(value); }
    async signPreparation(value) { return current(this.env).authority.signPreparation(value); }
  }
  export default {async fetch(request, env) {
    const c = current(env), mode = new URL(request.url).pathname.slice(1);
    if (mode === 'calls') return Response.json({ calls: c.calls, violations: c.violations });
    if (!['valid', 'revoke-before-ack'].includes(mode)) return new Response(null, { status: 404 });
    c.reset();
    if (mode === 'revoke-before-ack') c.setDeny(({ stage }) => stage === 'before-ack');
    return new Response(null, { status: 204 });
  }};
`);
const clientScript = `export default {async fetch(request, env) {
  const path = new URL(request.url).pathname;
  try {
    if (path === '/marker') return Response.json(await env.PRODUCT.releaseMarker());
    if (path === '/retired') return Response.json(await env.PRODUCT.putUploadChunk({}));
    return Response.json(await env.PRODUCT.invokeCore(await request.json()));
  } catch (error) { return Response.json({ error: error.message }, { status: 403 }); }
}};`;

const keys = await generateKeyPair("ES256", { extractable: true });
const publicJwk = await exportJWK(keys.publicKey);
const trustRoot = JSON.stringify({
  format: "recovery-trust-root-v1", keyId: "synthetic-control", algorithm: "ES256",
  publicJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
});
const releasedMarker = JSON.stringify({ application: "prosrus", artifactSha256: "b".repeat(64), releaseTag: "v1.2.3",
  schema: "release-marker/v1", sourceCommit: "a".repeat(40) });
let externalEffects = 0;
const denyOutbound = () => { externalEffects++; throw Error("unexpected-outbound"); };
const common = { modules: true, compatibilityDate: "2026-10-08", compatibilityFlags: ["nodejs_compat"], cf: false };
const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false, host: "127.0.0.1", outboundService: denyOutbound,
  workers: [
    { ...common, name: "client", script: clientScript, serviceBindings: { PRODUCT: { name: "product", entrypoint: "JobStack" } } },
    { ...common, name: "product", script: productScript, d1Databases: { DB: "synthetic" }, r2Buckets: { ORIGINALS: "synthetic-originals", UPLOADS: "synthetic-uploads" },
      durableObjects: { COORDINATOR: { className: "Coordinator", useSQLite: true } },
      bindings: { RECOVERY_TRUST_ROOT: trustRoot },
      serviceBindings: { CONTROL_AUTHORITY: { name: "authority", entrypoint: "FixtureAuthority" }, ASSETS: denyOutbound } },
    // Same product bundle with the builder-injected RELEASE_MARKER present / malformed.
    { ...common, name: "released", script: productScript, bindings: { RELEASE_MARKER: releasedMarker } },
    { ...common, name: "malformed", script: productScript, bindings: { RELEASE_MARKER: releasedMarker.replace("{", "{ ") } },
    { ...common, name: "authority", script: authorityScript,
      bindings: { SIGNING_JWK: JSON.stringify(await exportJWK(keys.privateKey)) } },
  ],
}));
let checks = 0;
const pass = (message) => console.log(`PASS ${++checks}: ${message}`);
try {
  const db = await mf.getD1Database("DB", "product");
  await applyMigrations(db);
  const authority = await mf.getWorker("authority");
  const product = await mf.getWorker("product");
  const count = async (table) => (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n;
  const counts = async () => Object.fromEntries(await Promise.all(
    ["records", "recovery_transactions", "recovery_outbox", "recovery_request_results", "recovery_versions"]
      .map(async (t) => [t, await count(t)])));
  const calls = async () => (await authority.fetch("https://fixture.invalid/calls")).json();
  // Every segment must respect Control's stage order before the fixture resets.
  const mode = async (name) => {
    assert.deepEqual((await calls()).violations, [], "stage order before " + name);
    return authority.fetch("https://fixture.invalid/" + name);
  };
  let serial = 0;
  async function invoke(operationId, input, invocationId = `inv_${++serial}`) {
    const response = await mf.dispatchFetch("https://fixture.invalid/invoke", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contract: "job-stack.shared-auth.v1", invocationId, operationId,
        input: { workspaceId: "workspace_fixture", ...input } }),
    });
    return { status: response.status, body: await response.json() };
  }
  const capture = {
    company: "Example", role: "Staff Engineer", sourceUrl: "https://example.com/jobs/1",
    description: "Build reliable systems",
    terms: { employment: "full_time", baseUsd: 240000, hourlyUsd: null, remote: true, match401k: null, zeroPremium: null, affordableCare: null },
  };
  const CAPTURE = "job-stack.opportunity.capture.v1";

  // Release marker: default fetch route and RPC, everything else 404.
  const marker = await product.fetch("https://fixture.invalid/.well-known/release-marker");
  assert.equal(marker.status, 200);
  assert.equal(marker.headers.get("cache-control"), "no-store");
  assert.match(marker.headers.get("content-type"), /^application\/json/);
  assert.equal(marker.headers.get("set-cookie"), null);
  const markerBody = await marker.json();
  assert.deepEqual(Object.keys(markerBody).sort(), ["application", "artifactSha256", "releaseTag", "schema", "sourceCommit", "startedAt"]);
  assert.equal(markerBody.schema, "release-marker/v1");
  assert.equal(markerBody.releaseTag, "unreleased");
  assert.ok(!Number.isNaN(Date.parse(markerBody.startedAt)));
  for (const [path, method] of [["/.well-known/release-marker", "POST"], ["/", "GET"], ["/owner/job-stack", "GET"], ["/.well-known/release-marker/x", "GET"]])
    assert.equal((await product.fetch("https://fixture.invalid" + path, { method })).status, 404, path + method);
  assert.deepEqual(await (await mf.dispatchFetch("https://fixture.invalid/marker")).json(), markerBody);
  const released = await (await mf.getWorker("released")).fetch("https://fixture.invalid/.well-known/release-marker");
  assert.equal(released.status, 200);
  const releasedBody = await released.json();
  assert.deepEqual({ ...releasedBody, startedAt: undefined }, { ...JSON.parse(releasedMarker), startedAt: undefined });
  assert.ok(!Number.isNaN(Date.parse(releasedBody.startedAt)));
  const malformed = await (await mf.getWorker("malformed")).fetch("https://fixture.invalid/.well-known/release-marker");
  assert.equal(malformed.status, 503);
  assert.equal(malformed.headers.get("cache-control"), "no-store");
  assert.deepEqual(await malformed.json(), { error: "release-marker-invalid" });
  pass("release marker: placeholder when RELEASE_MARKER is absent, the binding when present, 503 when malformed; RPC matches; other paths 404");

  // Write -> versioned save visible through the read operations.
  await mode("valid");
  const saved = await invoke(CAPTURE, { requestKey: "capture-1", body: capture });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.revision, "1");
  assert.deepEqual((await calls()).calls, ["read", "read", "read", "read", "sign-preparation", "before-ack"]);
  assert.deepEqual(await counts(), { records: 1, recovery_transactions: 1, recovery_outbox: 1, recovery_request_results: 1, recovery_versions: 1 });
  const version = await invoke("job-stack.version.read.v1", { versionId: saved.body.save.versionId });
  assert.equal(version.status, 200);
  assert.equal(version.body.entityId, saved.body.entityId);
  const history = await invoke("job-stack.version.list.v1", { lineageId: version.body.lineageId, cursor: null });
  assert.deepEqual(history.body.items.map((v) => v.versionId), [saved.body.save.versionId]);
  assert.deepEqual((await invoke("job-stack.request.read.v1", { requestKey: "capture-1" })).body, { result: saved.body.save });
  assert.equal((await invoke("job-stack.protection.read.v1", { versionId: saved.body.save.versionId })).body.primarySave, "saved_primary");
  assert.equal((await invoke("job-stack.records.read.v1", { kind: "opportunity", entityId: saved.body.entityId })).body.record.history, "versioned");
  pass("capture commits one transaction + outbox job and is visible via job_stack_version/versions/request/protection/records");

  // Replay and conflict.
  await mode("valid");
  const replay = await invoke(CAPTURE, { requestKey: "capture-1", body: capture });
  assert.deepEqual(replay, saved);
  assert.deepEqual((await calls()).calls, ["read", "read", "before-ack"]);
  const conflict = await invoke(CAPTURE, { requestKey: "capture-1", body: { ...capture, role: "Different" } });
  assert.deepEqual(conflict, { status: 403, body: { error: "request-key-conflict" } });
  assert.equal(await count("recovery_transactions"), 1);
  pass("replayed request key returns the identical stored result; a changed meaning is request-key-conflict");

  // Before-ack revocation leaves no committed state.
  await mode("revoke-before-ack");
  const before = await counts();
  const revoked = await invoke(CAPTURE, { requestKey: "capture-2", body: { ...capture, sourceUrl: "https://example.com/jobs/2" } });
  assert.deepEqual(revoked, { status: 403, body: { error: "operation-denied" } });
  assert.deepEqual(await counts(), before);
  assert.equal((await db.prepare("SELECT state FROM command_requests WHERE request_key='capture-2'").first()).state, "pending");
  await mode("valid");
  const resumed = await invoke(CAPTURE, { requestKey: "capture-2", body: { ...capture, sourceUrl: "https://example.com/jobs/2" } });
  assert.equal(resumed.status, 200);
  assert.equal(await count("recovery_transactions"), before.recovery_transactions + 1);
  pass("before-ack revocation denies with no transaction, outbox, records or result; the retained root resumes later");

  // Owner-only and unavailable/external operations.
  await mode("valid");
  const settings = { discoveryEnabled: false, correspondenceEnabled: false, remindersEnabled: true, sendingEnabled: false,
    profileResolved: false, integrationVerified: false, sender: null, notificationEmail: null, calendarId: null,
    interviewWindows: [], approvedRecipients: [], boards: [], revision: 0 };
  const mcp = await invoke("job-stack.settings.update.v1", { requestKey: "settings-mcp", body: settings }, "mcp_settings");
  assert.deepEqual(mcp, { status: 403, body: { error: "operation-denied" } });
  assert.equal(await count("records"), 2);
  const owner = await invoke("job-stack.settings.update.v1", { requestKey: "settings-owner", body: settings });
  assert.equal(owner.status, 200);
  pass("owner-only settings update is denied for the MCP entrypoint and succeeds for the verified owner");

  await mode("valid");
  for (const [operationId, input] of [
    ["job-stack.packet.create.v1", { requestKey: "p", body: { opportunityId: saved.body.entityId, claimIds: ["c"] } }],
    ["job-stack.submission.record.v1", { requestKey: "s", body: { opportunityId: "o", packetId: "p", receipt: "r", submittedAt: 1, confirmed: true } }],
    ["job-stack.meeting.import.v1", { requestKey: "m", meetingId: "m", uploadHandle: "u", authorizationRef: "a", kind: "transcript", expectedParentIds: [], sourceVersionIds: [], branchRequested: false }],
    ["job-stack.profile.export.v1", { requestKey: "e", changeSetId: "c", format: "json" }],
  ])
    assert.deepEqual(await invoke(operationId, input), { status: 403, body: { error: "operation-unavailable" } }, operationId);
  for (const operationId of ["job-stack.reply.send.v1", "job-stack.interview.schedule.v1", "job-stack.mail.sync.v1", "job-stack.recovery.commit.v1"])
    assert.equal((await invoke(operationId, { requestKey: "x" })).status, 403, operationId);
  assert.deepEqual(await (await mf.dispatchFetch("https://fixture.invalid/retired")).json(), { error: "operation-unavailable" });
  assert.deepEqual((await calls()).calls, []);
  pass("unavailable catalog operations, external effects, the internal commit and retired methods deny before any authority call");

  assert.deepEqual((await calls()).violations, []);
  assert.equal(externalEffects, 0);
  assert.equal(await count("intents"), 0);
  console.log(`${checks} real Workerd command checks passed; Control stage order (read+ then one before-ack) respected; zero outbound/provider effects. Synthetic authority and signing key only.`);
} finally {
  await mf.dispose();
}
