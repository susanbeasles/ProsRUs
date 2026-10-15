import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { applyMigrations } from "./runtime-migrations.mjs";
process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
mkdirSync("artifacts", { recursive: true });
await build({
  entryPoints: ["scripts/core-operation-runtime-exports.ts"],
  outfile: "artifacts/core-operation-runtime.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
});
const r = await import("../artifacts/core-operation-runtime.mjs");
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script:
      'export default {fetch(){return new Response("local core-plan fixture")}}',
    compatibilityDate: "2026-10-08",
    cf: false,
    d1Databases: ["DB"],
    r2Buckets: ["BUCKET"],
  }),
);
let checks = 0;
const pass = (message) => console.log(`PASS ${++checks}: ${message}`);
try {
  const db = await mf.getD1Database("DB"),
    archive = r.createPrimaryArchive(await mf.getR2Bucket("BUCKET"));
  await applyMigrations(db);
  const request = r.packetRequest();
  request.read.records = request.read.records.map((g) =>
    g.state === "present"
      ? {
          ...g,
          revision: 7,
          rawBody:
            g.recordKind === "claim"
              ? '{ "id":"claim-1", "field":"experience", "text":"Built reliable \\u0073ervices", "status":"user_confirmed", "permitted":true, "sourceIds":[] }'
              : g.rawBody,
        }
      : g,
  );
  request.read.bindings = request.read.bindings.map((b) => ({
    ...b,
    versionId: null,
    heads: [],
    revision: 7,
  }));
  for (const g of request.read.records)
    if (g.state === "present")
      await db
        .prepare(
          "INSERT INTO records(owner,kind,id,body,revision,updated_at) VALUES(?,?,?,?,?,?)",
        )
        .bind(
          "owner",
          g.recordKind,
          g.entityId,
          g.rawBody,
          g.revision,
          g.updatedAt,
        )
        .run();
  const baselinePlan = r.planCoreOperation({
    ...request,
    phase: "baseline-archive-v1",
    baseline: {
      requestKey: "internal-packet-baseline",
      originals: [],
      migrations: [],
    },
  });
  const baselineFixture = await r.domainFixture(archive, baselinePlan);
  baselineFixture.accepted.transactionId = "transaction-baseline";
  const baselineSigner = r.createRecoverySigner(baselineFixture),
    baseline = await r.prepareRecoveryPackage(
      baselineFixture.input,
      baselineFixture.context,
      { ...baselineFixture, signer: baselineSigner },
    );
  const store = r.createRecoveryStore(db, "owner"),
    before = (await db.prepare("SELECT * FROM records ORDER BY kind,id").all())
      .results;
  await store.commitPrepared(baseline);
  assert.deepEqual(
    (await db.prepare("SELECT * FROM records ORDER BY kind,id").all()).results,
    before,
  );
  const claimBaseline = baseline.versions.find((v) => v.entityId === "claim-1"),
    opBaseline = baseline.versions.find((v) => v.entityId === "opportunity-1");
  assert(claimBaseline && opBaseline);
  assert.equal(claimBaseline.approval.state, "unverified");
  const raw = await archive.get(claimBaseline.artifacts[1].object);
  assert.equal(
    new TextDecoder().decode(raw.bytes),
    before.find((row) => row.kind === "claim").body,
  );
  pass(
    "one separately committed planner baseline preserves exact revision7/raw escapes and changes zero operational rows",
  );
  request.read.bindings = request.read.bindings.map((b) => {
    const v = baseline.versions.find((v) => v.entityId === b.entityId);
    assert(v);
    return {
      ...b,
      versionId: v.versionId,
      heads: [v.versionId],
      sourceVersionIds: v.sourceVersionIds,
    };
  });
  request.currentEvidence.claims[0].versionId = claimBaseline.versionId;
  request.currentEvidence.claims[0].revision = 7;
  const plan = r.planCoreOperation(request),
    digest = await r.domainRequestDigest(plan);
  const context = { ...r.primaryContext, chain: await store.getChain() },
    fixture = await r.domainFixture(archive, plan, context);
  fixture.accepted.transactionId = "transaction-main-first";
  fixture.accepted.parents.push(opBaseline);
  fixture.accepted.sources.push(claimBaseline, opBaseline);
  const signer = r.createRecoverySigner(fixture),
    first = await r.prepareRecoveryPackage(fixture.input, context, {
      ...fixture,
      signer,
    });
  // A real unrelated immutable archival save advances only the workspace chain.
  const generic = await r.preparationFixture();
  generic.archive = archive;
  const genericContext = { ...r.primaryContext, chain: await store.getChain() },
    genericInput = {
      ...r.primaryInput,
      requestKey: "request-unrelated",
      entityId: "unrelated",
      lineageId: "lineage-unrelated",
    };
  const genericAccepted = await generic.authority.accept(
    genericInput,
    genericContext,
  );
  Object.assign(genericAccepted, {
    input: genericInput,
    context: genericContext,
    currentChain: genericContext.chain,
    transactionId: "transaction-unrelated",
    versionId: "version-unrelated",
  });
  const genericSigner = r.createRecoverySigner(generic),
    unrelated = await r.prepareRecoveryPackage(genericInput, genericContext, {
      ...generic,
      signer: genericSigner,
    });
  await store.commitPrepared(unrelated);
  await assert.rejects(store.commitPrepared(first), /CHAIN_CONFLICT/);
  assert.equal(await store.findRequest(request.input.requestKey, digest), null);
  pass(
    "unrelated real chain movement rejects the first attempt without a public result or domain rows",
  );
  const retryContext = { ...context, chain: await store.getChain() };
  fixture.context = retryContext;
  Object.assign(fixture.accepted, {
    context: retryContext,
    currentChain: retryContext.chain,
    transactionId: "transaction-main-retry",
    versionId: "version-packet-retry",
  });
  fixture.accepted.domainPlan.candidateVersions =
    fixture.accepted.domainPlan.candidateVersions.map((v) => ({
      role: v.role,
      versionId: `version-${v.role}-retry`,
    }));
  const retry = await r.prepareRecoveryPackage(fixture.input, retryContext, {
    ...fixture,
    signer: r.createRecoverySigner(fixture),
  });
  assert.equal(retry.requestDigest, first.requestDigest);
  assert.deepEqual(retry.domainEffects.plan, first.domainEffects.plan);
  assert.notEqual(retry.transactionId, first.transactionId);
  const result = await store.commitPrepared(retry);
  assert.equal(
    (
      await db
        .prepare("SELECT revision FROM records WHERE kind='opportunity'")
        .first()
    ).revision,
    8,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT count(*) n FROM records WHERE kind='packet'")
        .first()
    ).n,
    1,
  );
  assert.equal((await db.prepare("SELECT count(*) n FROM audit").first()).n, 2);
  assert.equal(retry.versions.length, 2);
  pass(
    "the identical reviewed planner plan reprepares with new attempt IDs and atomically commits packet plus revision8 opportunity and both audits",
  );
  assert.deepEqual(await store.commitPrepared(first), result);
  assert.deepEqual(
    await store.findRequest(request.input.requestKey, digest),
    result,
  );
  assert(
    await store.readCommitted({
      workspace: request.allocation.workspace,
      transactionId: result.transactionId,
    }),
  );
  pass(
    "retained D1 winner is returned before stale initial-attempt checks after a lost response",
  );
  const changed = structuredClone(request);
  const guard = changed.read.records.find((g) => g.recordKind === "claim");
  guard.rawBody = guard.rawBody.replace("reliable", "different");
  const changedPlan = r.planCoreOperation(changed);
  await assert.rejects(
    store.findRequest(
      request.input.requestKey,
      await r.domainRequestDigest(changedPlan),
    ),
    /REQUEST_KEY_CONFLICT/,
  );
  pass(
    "changed source meaning under the old public key denies without another domain mutation",
  );
  console.log(
    `${checks} real planner/4P D1/R2 checks passed; zero providers/Control integration claimed.`,
  );
} finally {
  await mf.dispose();
}
