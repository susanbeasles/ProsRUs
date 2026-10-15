import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { applyMigrations } from "./runtime-migrations.mjs";
process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
mkdirSync("artifacts", { recursive: true });
await build({
  entryPoints: ["scripts/core-operation-runtime-exports.ts"],
  outfile: "artifacts/core-archive-source-runtime.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
});
// This harness runs the archive in Node against Miniflare's R2 proxy. Node has
// no Workers FixedLengthStream; this test-only stand-in enforces the same exact
// length so promotion of a staged upload runs the production stream path.
globalThis.FixedLengthStream ??= class FixedLengthStream extends TransformStream {
  constructor(length) {
    let seen = 0;
    super({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > length) throw Error("STREAM_LENGTH_MISMATCH");
        controller.enqueue(chunk);
      },
      flush() {
        if (seen !== length) throw Error("STREAM_LENGTH_MISMATCH");
      },
    });
  }
};
// Miniflare's Node-side R2 proxy needs a known-length body; Workerd does not.
// Buffer stream bodies (small fixtures only) so the production stream path runs.
function nodeBucket(bucket) {
  return new Proxy(bucket, {
    get(target, property) {
      if (property !== "put") return Reflect.get(target, property).bind(target);
      return async (key, body, options) => {
        if (!(body instanceof ReadableStream)) return target.put(key, body, options);
        const bytes = new Uint8Array(await new Response(body).arrayBuffer());
        return target.put(key, bytes, options);
      };
    },
  });
}
const r = await import("../artifacts/core-archive-source-runtime.mjs"),
  cases = [
    "control",
    "head",
    "projection",
    "alias-lineage",
    "alias-projection",
    "branch",
    "legacy-insert",
  ];
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script:
      'export default {fetch(){return new Response("local archive-source fixture")}}',
    compatibilityDate: "2026-10-08",
    cf: false,
    d1Databases: Object.fromEntries(cases.map((name) => [name, name])),
    r2Buckets: ["BUCKET"],
  }),
);
let checks = 0;
const pass = (msg) => console.log(`PASS ${++checks}: ${msg}`);
async function snapshot(db) {
  const tables = (
    await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
      )
      .all()
  ).results;
  return Object.fromEntries(
    await Promise.all(
      tables.map(async (row) => [
        row.name,
        (await db.prepare(`SELECT * FROM "${row.name}"`).all()).results,
      ]),
    ),
  );
}
try {
  const archive = r.createPrimaryArchive(nodeBucket(await mf.getR2Bucket("BUCKET"))),
    origin = await r.preparationFixture();
  const uploads = r.createUploadIntake({
    archive,
    budget: r.createRecoveryIntakeBudget(),
    authority: {
      async authorize(context) {
        return {
          context,
          now: 1000,
          namespace: "recovery-original",
          expiresAt: 50000,
        };
      },
    },
  });
  const bytes = new TextEncoder().encode(
      "%PDF-1.7\nExact newly supplied old resume\n%%EOF\n",
    ),
    started = await uploads.begin(
      {
        requestKey: "new-original-upload",
        original: {
          fileName: "resume.pdf",
          mediaType: "application/pdf",
          sizeBytes: bytes.length,
          format: null,
          lastModified: null,
        },
      },
      r.primaryContext,
    );
  await uploads.putChunk(
    {
      uploadHandle: started.uploadHandle,
      ordinal: 0,
      requestKey: "new-original-chunk",
      body: new Blob([bytes]).stream(),
    },
    r.primaryContext,
  );
  await uploads.complete(started.uploadHandle, r.primaryContext);
  const originalInput = {
    requestKey: "save-new-original",
    lineageId: "lineage-original",
    entityId: "resume-original",
    kind: "resume",
    expectedParentIds: [],
    sourceVersionIds: [],
    branchRequested: false,
    uploadHandle: started.uploadHandle,
  };
  const originalFixture = { ...origin, archive, uploads },
    original = await r.prepareRecoveryPackage(originalInput, r.primaryContext, {
      ...originalFixture,
      signer: r.createRecoverySigner(originalFixture),
    });
  const manifest = original.versions[0],
    descriptor = manifest.artifacts[0];
  const guard = {
    format: "archived-original-source-v1",
    entityId: manifest.entityId,
    kind: manifest.kind,
    lineageId: manifest.lineageId,
    versionId: manifest.versionId,
    manifestDigest: await r.hashEnvelope("manifest", manifest),
    projectionBody: new TextDecoder().decode(
      r.canonicalizeEnvelope(manifest.recordSnapshot),
    ),
    original: {
      artifactIndex: 0,
      digest: descriptor.digest,
      sizeBytes: descriptor.sizeBytes,
      mediaType: descriptor.mediaType,
    },
    capture: {
      purpose: "profile-source",
      requestRootId: "root-original-upload",
      transactionId: manifest.transactionId,
      uploadHandle: started.uploadHandle,
      purposeDigest: "c".repeat(64),
    },
  };
  for (const name of cases) {
    const db = await mf.getD1Database(name);
    await applyMigrations(db);
    const store = r.createRecoveryStore(db, "owner");
    await store.commitPrepared(original);
    const request = r.archivedSourceRequest();
    request.read.archiveSources = [guard];
    request.currentEvidence.sourceArtifacts = [
      {
        entityId: guard.entityId,
        versionId: guard.versionId,
        permissionId: "fixture-current-source",
        permissionRevision: 1,
        expiresAt: 2000,
        ...guard.original,
        capture: { ...guard.capture },
      },
    ];
    const plan = r.planCoreOperation(request),
      context = { ...r.primaryContext, chain: await store.getChain() },
      fixture = await r.domainFixture(archive, plan, context);
    fixture.accepted.transactionId = `transaction-claim-${name}`;
    fixture.accepted.sources.push(manifest);
    const prepared = await r.prepareRecoveryPackage(fixture.input, context, {
      ...fixture,
      signer: r.createRecoverySigner(fixture),
    });
    if (name === "control") {
      await store.commitPrepared(prepared);
      assert.equal(
        (
          await db
            .prepare("SELECT count(*) n FROM records WHERE kind='artifact'")
            .first()
        ).n,
        0,
      );
      assert.equal(
        (
          await db
            .prepare("SELECT count(*) n FROM records WHERE kind='claim'")
            .first()
        ).n,
        1,
      );
      const review = structuredClone(request),
        row = await db
          .prepare("SELECT * FROM records WHERE kind='claim'")
          .first();
      review.operationId = "job-stack.claim.review.v1";
      review.input = {
        workspaceId: "workspace",
        requestKey: "review-new-original",
        body: {
          id: row.id,
          revision: 1,
          status: "source_supported",
          permitted: true,
        },
      };
      review.allocation.requestRootId = "root-review-original";
      review.allocation.records[0].auditEventId = "audit-review-original";
      review.currentEvidence.ownerInteraction = {
        id: "fixture-owner-review",
        revision: 1,
      };
      review.read.records[0] = {
        recordKind: "claim",
        entityId: row.id,
        state: "present",
        rawBody: row.body,
        revision: row.revision,
        updatedAt: row.updated_at,
      };
      review.read.bindings = [
        {
          recordKind: "claim",
          entityId: row.id,
          lineageId: "lineage-new-claim",
          versionId: prepared.result.versionId,
          heads: [prepared.result.versionId],
          revision: 1,
          sourceVersionIds: [manifest.versionId],
        },
      ];
      const reviewPlan = r.planCoreOperation(review),
        reviewContext = { ...context, chain: await store.getChain() },
        reviewFixture = await r.domainFixture(
          archive,
          reviewPlan,
          reviewContext,
        );
      reviewFixture.accepted.transactionId = "transaction-review-original";
      reviewFixture.accepted.versionId = "version-review-original";
      reviewFixture.accepted.domainPlan.candidateVersions = [
        { role: "claim", versionId: "version-review-original" },
      ];
      reviewFixture.accepted.parents.push(prepared.versions[0]);
      reviewFixture.accepted.sources.push(manifest, prepared.versions[0]);
      const reviewed = await r.prepareRecoveryPackage(
        reviewFixture.input,
        reviewContext,
        { ...reviewFixture, signer: r.createRecoverySigner(reviewFixture) },
      );
      await store.commitPrepared(reviewed);
      assert.equal(
        JSON.parse(
          (
            await db
              .prepare("SELECT body FROM records WHERE kind='claim'")
              .first()
          ).body,
        ).status,
        "source_supported",
      );
      assert.equal(
        (
          await db
            .prepare("SELECT count(*) n FROM records WHERE kind='artifact'")
            .first()
        ).n,
        0,
      );
      pass(
        "real bounded uploaded inert resume -> claim.add -> source_supported review uses exact original with no legacy artifact row (current proof is a labeled synthetic4I seam)",
      );
    } else {
      if (name === "head")
        await db
          .prepare("DELETE FROM recovery_heads WHERE lineage_id=?")
          .bind(manifest.lineageId)
          .run();
      if (name === "projection")
        await db
          .prepare(
            "UPDATE recovery_projections SET body='{}' WHERE entity_id=?",
          )
          .bind(manifest.entityId)
          .run();
      if (name === "alias-lineage")
        await db
          .prepare(
            "INSERT INTO recovery_lineages(owner,workspace_id,lineage_id,entity_id,kind) VALUES('owner','workspace','alias-lineage',?,'evidence')",
          )
          .bind(manifest.entityId)
          .run();
      if (name === "alias-projection")
        await db
          .prepare(
            "INSERT INTO recovery_projections(owner,workspace_id,kind,entity_id,lineage_id,version_id,body) VALUES('owner','workspace','evidence',?,?,?,'{}')",
          )
          .bind(manifest.entityId, manifest.lineageId, manifest.versionId)
          .run();
      if (name === "branch") {
        await db
          .prepare(
            "INSERT INTO recovery_lineages(owner,workspace_id,lineage_id,kind,entity_id) VALUES('owner','workspace','branch-lineage','artifact','branch-entity')",
          )
          .run();
        await db
          .prepare(
            "INSERT INTO recovery_versions SELECT owner,workspace_id,'branch-version','branch-lineage','artifact','branch-entity',transaction_id,epoch_id,sequence,schema_version,manifest_digest,manifest FROM recovery_versions WHERE version_id=?",
          )
          .bind(manifest.versionId)
          .run();
        await db
          .prepare(
            "INSERT INTO recovery_heads VALUES('owner','workspace',?,'branch-version')",
          )
          .bind(manifest.lineageId)
          .run();
      }
      if (name === "legacy-insert")
        await db
          .prepare(
            "INSERT INTO records(owner,kind,id,body,revision,updated_at) VALUES('owner','artifact',?,'{}',1,100)",
          )
          .bind(manifest.entityId)
          .run();
      const before = await snapshot(db);
      await assert.rejects(
        store.commitPrepared(prepared),
        (error) =>
          error instanceof r.DomainError &&
          error.code === "RECOVERY_DOMAIN_ARCHIVE_SOURCE_CONFLICT" &&
          error.status === 409,
      );
      assert.deepEqual(await snapshot(db), before);
      pass(
        `signed ${name} source race aborts every domain/recovery/result/outbox effect`,
      );
    }
  }
  const finalRequest = r.archivedSourceRequest();
  finalRequest.read.archiveSources = [guard];
  finalRequest.currentEvidence.sourceArtifacts = [
    {
      entityId: guard.entityId,
      versionId: guard.versionId,
      permissionId: "fixture-current-source",
      permissionRevision: 1,
      expiresAt: 2000,
      ...guard.original,
      capture: { ...guard.capture },
    },
  ];
  const finalPlan = r.planCoreOperation(finalRequest),
    db = await mf.getD1Database("head"),
    store = r.createRecoveryStore(db, "owner"),
    context = { ...r.primaryContext, chain: await store.getChain() };
  const fixture = await r.domainFixture(archive, finalPlan, context);
  fixture.accepted.transactionId = "transaction-original-negative";
  fixture.accepted.sources.push(manifest);
  const missingArchive = {
    ...archive,
    async getStream(object) {
      return object.key === descriptor.object.key
        ? null
        : archive.getStream(object);
    },
  };
  const beforeMissing = await snapshot(db);
  await assert.rejects(
    r.prepareRecoveryPackage(fixture.input, context, {
      ...fixture,
      archive: missingArchive,
      signer: r.createRecoverySigner({ ...fixture, archive: missingArchive }),
    }),
    /ARTIFACT|MISSING/,
  );
  assert.deepEqual(await snapshot(db), beforeMissing);
  pass(
    "missing required immutable original bytes deny before any domain D1 effects (missing-reader seam)",
  );
  await (
    await mf.getR2Bucket("BUCKET")
  ).put(
    `${descriptor.object.namespace}/${descriptor.object.key}`,
    "corrupt test original",
  );
  await assert.rejects(
    r.prepareRecoveryPackage(fixture.input, context, {
      ...fixture,
      signer: r.createRecoverySigner(fixture),
    }),
    /ARTIFACT|DIGEST|MISMATCH/,
  );
  assert.deepEqual(await snapshot(db), beforeMissing);
  pass("tampered actual R2 original bytes deny before any domain D1 effects");
  console.log(
    `${checks} archive-source real D1/R2 checks passed; provenance/current policy fixture-only, actual4I assembly pending.`,
  );
} finally {
  await mf.dispose();
}
