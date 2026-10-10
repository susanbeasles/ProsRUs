import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { applyMigrations } from "./runtime-migrations.mjs";
process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
mkdirSync("artifacts", { recursive: true });
await build({
  entryPoints: ["scripts/domain-runtime-exports.ts"],
  outfile: "artifacts/domain-runtime-exports.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
});
const r = await import("../artifacts/domain-runtime-exports.mjs");
const requested = process.argv.slice(2);
const selected = (name) => requested.length === 0 || requested.includes(name);
const names = [
  "original-absent",
  "original-positive",
  "original-missing",
  "normalization-sink",
  "tamper",
  "forged-observation",
  "packet",
  "offer",
  "attempt",
  "thread",
  "baseline",
  "rollback",
  "observation",
  "old",
  "guard-body",
  "guard-revision",
  "guard-time",
  "guard-source",
  "guard-insert",
  "guard-delete",
  "guard-update",
  "guard-key",
  "guard-control",
  "guard-question-null",
  "uncertain",
  "wrong",
  "future",
  "closure",
];
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script:
      'export default {fetch(){return new Response("local domain fixture")}}',
    compatibilityDate: "2026-10-08",
    cf: false,
    d1Databases: Object.fromEntries(names.map((name) => [name, name])),
    r2Buckets: ["BUCKET"],
  }),
);
let checks = 0;
async function check(name, run) {
  await run();
  console.log(`PASS ${++checks}: ${name}`);
}
async function snapshot(db) {
  const tables = (
    await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
      )
      .all()
  ).results;
  const result = {};
  for (const { name } of tables)
    result[name] = (await db.prepare(`SELECT * FROM "${name}"`).all()).results;
  return result;
}
async function unchanged(db, run, pattern) {
  const before = await snapshot(db);
  await assert.rejects(run, pattern);
  assert.deepEqual(await snapshot(db), before);
}
const bridge = (db, batch) =>
  new Proxy(db, {
    get(target, key) {
      if (key === "batch") return batch;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
try {
  const archive = r.createPrimaryArchive(await mf.getR2Bucket("BUCKET"));
  async function setup(
    name,
    plan = r.packetPlan(),
    context = r.primaryContext,
    { through = null, beforePrepare = null, memoryArchive = false } = {},
  ) {
    const db = await mf.getD1Database(name);
    await applyMigrations(db, { through });
    const copy = structuredClone(plan);
    copy.requestRootId = `root-${name}`;
    copy.requestKey = `request-${name}`;
    const fixture = await r.domainFixture(
      memoryArchive ? undefined : archive,
      r.parseDomainPlan(copy),
      context,
    );
    for (const guard of fixture.accepted.domainPlan.plan.readSet.records)
      if (guard.state === "present")
        await db
          .prepare(
            "INSERT INTO records(owner,kind,id,body,revision,updated_at) VALUES(?,?,?,?,?,?)",
          )
          .bind(
            "owner",
            guard.recordKind,
            guard.entityId,
            guard.rawBody,
            guard.revision,
            guard.updatedAt,
          )
          .run();
    for (const guard of fixture.accepted.domainPlan.plan.readSet.sourceKeys)
      if (guard.opportunityId !== null)
        await db
          .prepare("INSERT INTO source_keys VALUES(?,?,?)")
          .bind("owner", guard.sourceKey, guard.opportunityId)
          .run();
    if (beforePrepare) await beforePrepare(fixture);
    const signer = r.createRecoverySigner(fixture);
    const prepared = await r.prepareRecoveryPackage(
      fixture.input,
      fixture.context,
      { ...fixture, signer },
    );
    return {
      db,
      fixture,
      prepared,
      signer,
      store: r.createRecoveryStore(db, "owner"),
    };
  }
  for (const kind of ["packet", "offer", "attempt", "thread"])
    if (selected("positive"))
      await check(
        `${kind} and its companion commit full bodies/artifacts/history/audits`,
        async () => {
          const { db, store, prepared } = await setup(
            kind,
            kind === "packet" ? r.packetPlan() : r.companionPlan(kind),
          );
          const beforeCommit = Date.now();
          const saved = await store.commitPrepared(prepared);
          const committed = await store.readCommitted({
            workspace: prepared.workspace,
            transactionId: prepared.transactionId,
          });
          assert.deepEqual(committed.prepared, prepared);
          assert.deepEqual(committed.result, saved);
          assert.equal(committed.observation.precisionMs, 1);
          assert.ok(
            committed.observation.observedAt >= beforeCommit &&
              committed.observation.observedAt <= Date.now(),
          );
          for (const candidate of prepared.domainEffects.plan.candidates) {
            const row = await db
              .prepare(
                "SELECT body,revision,updated_at FROM records WHERE owner=? AND kind=? AND id=?",
              )
              .bind(
                "owner",
                candidate.snapshot.recordKind,
                candidate.snapshot.entityId,
              )
              .first();
            assert.deepEqual(JSON.parse(row.body), candidate.snapshot.body);
            assert.equal(row.revision, candidate.snapshot.revision);
            assert.equal(row.updated_at, candidate.snapshot.updatedAt);
          }
          for (const table of [
            "recovery_versions",
            "recovery_heads",
            "recovery_projections",
            "audit",
          ])
            assert.equal(
              (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first())
                .n,
              2,
            );
          for (const table of [
            "recovery_transactions",
            "recovery_request_results",
            "recovery_audit",
            "recovery_outbox",
            "recovery_commit_observations",
          ])
            assert.equal(
              (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first())
                .n,
              1,
            );
          assert.deepEqual(await store.commitPrepared(prepared), saved);
          assert.deepEqual(
            await store.findRequest(
              prepared.requestKey,
              prepared.requestDigest,
            ),
            saved,
          );
        },
      );
  if (selected("original-missing"))
    await check(
      "R2 missing original remains explicit and preserves only its raw artifact metadata",
      async () => {
        const { db, store, prepared } = await setup(
          "original-missing",
          r.artifactBaselinePlan(),
        );
        const before = (await snapshot(db)).records;
        await store.commitPrepared(prepared);
        assert.deepEqual((await snapshot(db)).records, before);
        assert.equal(
          prepared.versions[0].generationRecipe.parameters.originalArtifact,
          "missing",
        );
        assert.equal(prepared.versions[0].artifacts.length, 2);
        assert.equal(
          (await db.prepare("SELECT count(*) AS n FROM audit").first()).n,
          0,
        );
        assert.equal(
          (await db.prepare("SELECT count(*) AS n FROM source_keys").first()).n,
          0,
        );
      },
    );
  if (selected("original-positive"))
    await check(
      "R2 verified original bytes, candidate-local roles, source provenance and signed descriptors are bound",
      async () => {
        const db = await mf.getD1Database("original-positive");
        await applyMigrations(db);
        const store = r.createRecoveryStore(db, "owner"),
          fileFixture = await r.preparationFixture();
        const fileSigner = r.createRecoverySigner({ ...fileFixture, archive });
        const file = await r.prepareRecoveryPackage(
          { ...r.primaryInput, content: r.originalPdf },
          r.primaryContext,
          { ...fileFixture, archive, signer: fileSigner },
        );
        await store.commitPrepared(file);
        const source = file.versions[0],
          descriptor = source.artifacts[0];
        const plan = r.artifactBaselinePlan(),
          candidate = plan.candidates[0];
        candidate.sourceVersionIds = [source.versionId];
        candidate.artifacts.push({
          role: "original-file",
          source: {
            type: "committed",
            versionId: source.versionId,
            artifactIndex: 0,
          },
        });
        candidate.observation = {
          ...candidate.observation,
          originalArtifact: "observed",
          original: {
            artifactRole: "original-file",
            digest: descriptor.digest,
            sizeBytes: descriptor.sizeBytes,
            mediaType: descriptor.mediaType,
          },
        };
        const context = { ...r.primaryContext, chain: await store.getChain() };
        async function bound(value) {
          const f = await r.domainFixture(archive, value, context);
          f.accepted.sources.push(source);
          return f;
        }
        for (const field of [
          "role",
          "cross-candidate",
          "locator",
          "raw-role",
          "utf8",
          "descriptor",
          "size",
          "media",
        ]) {
          const altered = structuredClone(plan),
            c = altered.candidates[0];
          if (field === "role") c.observation.original.artifactRole = "absent";
          if (field === "cross-candidate")
            c.observation.original.artifactRole = "another-candidate-original";
          if (field === "locator")
            c.observation.originalLocator = "owner/artifacts/other.pdf";
          if (field === "raw-role")
            c.observation.original.artifactRole = "legacy-json";
          if (field === "utf8")
            c.artifacts[1].source = {
              type: "utf8",
              text: "fake",
              mediaType: "application/pdf",
            };
          if (field === "descriptor")
            c.observation.original.digest = "f".repeat(64);
          if (field === "size") c.observation.original.sizeBytes++;
          if (field === "media")
            c.observation.original.mediaType = "application/pdf";
          const f = await bound(altered);
          let calls = 0;
          const signer = r.createRecoverySigner({
            ...f,
            custody: {
              ...f.custody,
              async signPreparation(binding) {
                calls++;
                return f.custody.signPreparation(binding);
              },
            },
          });
          await unchanged(db, () =>
            r.prepareRecoveryPackage(f.input, f.context, { ...f, signer }),
          );
          assert.equal(calls, 0);
        }
        const rawSource = structuredClone(source);
        rawSource.recordSnapshot = {
          type: "domain_record",
          recordKind: "artifact",
        };
        const wrong = await bound(plan);
        wrong.accepted.sources.splice(0, 1, rawSource);
        await assert.rejects(
          () =>
            r.buildPrimaryPackage(
              wrong.accepted,
              { archive, trustRootIds: ["synthetic-primary"] },
              "persist",
            ),
          /DOMAIN_COMMITTED_ORIGINAL_REQUIRED/,
        );
        const f = await bound(r.parseDomainPlan(plan)),
          signer = r.createRecoverySigner(f);
        const guard = plan.readSet.records[0];
        await db
          .prepare("INSERT INTO records VALUES(?,?,?,?,?,?)")
          .bind(
            "owner",
            guard.recordKind,
            guard.entityId,
            guard.rawBody,
            guard.revision,
            guard.updatedAt,
          )
          .run();
        const prepared = await r.prepareRecoveryPackage(f.input, f.context, {
          ...f,
          signer,
        });
        await signer.verifyPreparation(prepared);
        for (const field of ["role", "descriptor", "locator", "state"]) {
          const altered = structuredClone(prepared),
            observation = altered.domainEffects.plan.candidates[0].observation;
          if (field === "role")
            observation.original.artifactRole = "legacy-json";
          if (field === "descriptor")
            observation.original.digest = "f".repeat(64);
          if (field === "locator")
            observation.originalLocator = "wrong-locator";
          if (field === "state") {
            observation.originalArtifact = "missing";
            delete observation.original;
          }
          await assert.rejects(() =>
            signer.signPreparation(r.unsignedPreparation(altered), f.context),
          );
          await unchanged(db, () => store.commitPrepared(altered));
        }
        const wrongDescriptor = structuredClone(prepared),
          wrongCandidate = wrongDescriptor.domainEffects.plan.candidates[0];
        wrongCandidate.observation.original.digest = "f".repeat(64);
        wrongDescriptor.domainEffects.planDigest = await r.domainPlanDigest(
          wrongDescriptor.domainEffects.plan,
        );
        wrongDescriptor.requestDigest = await r.domainRequestDigest(
          wrongDescriptor.domainEffects.plan,
        );
        wrongDescriptor.versions[0].generationRecipe.parameters =
          wrongCandidate.observation;
        wrongDescriptor.result.digest = await r.hashEnvelope(
          "manifest",
          wrongDescriptor.versions[0],
        );
        await unchanged(
          db,
          () => store.commitPrepared(wrongDescriptor),
          /DOMAIN_ORIGINAL_DESCRIPTOR_MISMATCH/,
        );
        const before = (await snapshot(db)).records;
        await store.commitPrepared(prepared);
        assert.deepEqual((await snapshot(db)).records, before);
        const original = prepared.versions[0].artifacts[2];
        assert.deepEqual(
          (await archive.get(original.object)).bytes,
          r.originalPdf,
        );
        assert.deepEqual(original, descriptor);
        assert.equal(
          prepared.versions[0].generationRecipe.parameters.original
            .artifactRole,
          "original-file",
        );
        assert.equal(
          (await db.prepare("SELECT count(*) AS n FROM audit").first()).n,
          0,
        );
        assert.equal(
          (await db.prepare("SELECT count(*) AS n FROM source_keys").first()).n,
          0,
        );
      },
    );
  if (selected("original-absent"))
    await check(
      "R2 observed original cannot commit only snapshot/raw-row JSON",
      async () => {
        const plan = r.artifactBaselinePlan();
        plan.candidates[0].observation.originalArtifact = "observed";
        await assert.rejects(async () => {
          const { store, prepared } = await setup("original-absent", plan);
          await store.commitPrepared(prepared);
        });
      },
    );
  if (selected("normalization-sink"))
    await check(
      "R1 prepared sink rejects normalization before D1 effects; exact companion control succeeds",
      async () => {
        const { db, store, prepared } = await setup("normalization-sink");
        const altered = structuredClone(prepared);
        altered.domainEffects.plan.candidates[1].snapshot.body.sourceUrl =
          " https://example.com/job ";
        await unchanged(db, () => store.commitPrepared(altered));
        await store.commitPrepared(prepared);
        assert.equal(
          JSON.parse(
            (
              await db
                .prepare("SELECT body FROM records WHERE kind='opportunity'")
                .first()
            ).body,
          ).sourceUrl,
          "https://example.com/job",
        );
      },
    );
  if (selected("tamper"))
    await check(
      "tampered non-primary content, artifact, audit, source-key, CAS, result and digest deny before D1 batch",
      async () => {
        const { db, prepared } = await setup("tamper");
        let batches = 0;
        const guarded = r.createRecoveryStore(
          bridge(db, async (statements) => {
            batches++;
            return db.batch(statements);
          }),
          "owner",
        );
        for (const field of [
          "body",
          "artifact",
          "audit",
          "source-key",
          "predicate",
          "result",
          "digest",
        ]) {
          const altered = structuredClone(prepared),
            effects = altered.domainEffects;
          if (field === "body") altered.versions[1].recordSnapshot.revision++;
          if (field === "artifact")
            altered.versions[0].artifacts[1].digest = "e".repeat(64);
          if (field === "audit") effects.plan.audit[0].eventId = "other-audit";
          if (field === "source-key")
            effects.plan.sourceKeys.push({
              sourceKey: "https://example.com/other",
              opportunityId: "opportunity-1",
              mode: "insert",
            });
          if (field === "predicate")
            effects.plan.readSet.records[1].rawBody =
              effects.plan.readSet.records[1].rawBody.replace(
                "Prepare packet",
                "Other meaning",
              );
          if (field === "result") effects.plan.resultRecord.revision++;
          if (field === "digest") effects.planDigest = "f".repeat(64);
          await unchanged(
            db,
            () => guarded.commitPrepared(altered),
            /DOMAIN_|INVALID_PREPARED_ENVELOPE/,
          );
        }
        assert.equal(batches, 0);
        await guarded.commitPrepared(prepared);
        assert.equal(batches, 1);
      },
    );
  if (selected("baseline"))
    await check(
      "baseline archives exact raw serialization separately with zero operational writes",
      async () => {
        const raw =
          ' { "text" : "Built reli\\u0061ble services", "field":"experience", "id":"claim-1", "status":"user_confirmed", "permitted":true, "sourceIds":[] }\n';
        const { db, store, prepared } = await setup(
          "baseline",
          r.baselinePlan(raw),
        );
        const old = (await db.prepare("SELECT * FROM records").all()).results;
        await store.commitPrepared(prepared);
        assert.deepEqual(
          (await db.prepare("SELECT * FROM records").all()).results,
          old,
        );
        for (const table of ["audit", "source_keys"])
          assert.equal(
            (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n,
            0,
          );
        const version = prepared.versions[0];
        assert.equal(version.createdAt, 1000);
        assert.equal(
          version.recordSnapshot.body.text,
          "Built reliable services",
        );
        assert.equal(version.recordSnapshot.revision, 7);
        assert.equal(version.recordSnapshot.updatedAt, 90);
        assert.equal(version.approval.state, "unverified");
        assert.equal(
          new TextDecoder().decode(
            (await archive.get(version.artifacts[1].object)).bytes,
          ),
          raw,
        );
        assert.notEqual(
          version.artifacts[0].digest,
          version.artifacts[1].digest,
        );
        assert.equal(
          prepared.domainEffects.plan.candidates[0].observation
            .originalArtifact,
          "not_applicable",
        );
      },
    );
  if (selected("rollback"))
    await check(
      "every enlarged batch statement boundary rolls back all legacy/recovery tables and chain",
      async () => {
        const { db, prepared } = await setup("rollback");
        await db
          .prepare(
            "CREATE TABLE domain_test_failure(value INTEGER CHECK(value=1))",
          )
          .run();
        let size = 0;
        const capture = bridge(db, async (statements) => {
          size = statements.length;
          throw Error("CAPTURE_BATCH");
        });
        await assert.rejects(
          () =>
            r.createRecoveryStore(capture, "owner").commitPrepared(prepared),
          /CAPTURE_BATCH/,
        );
        assert.ok(size >= 20);
        for (let i = 0; i <= size; i++) {
          const failing = bridge(db, (statements) =>
            db.batch([
              ...statements.slice(0, i),
              db.prepare("INSERT INTO domain_test_failure VALUES(0)"),
              ...statements.slice(i),
            ]),
          );
          await unchanged(
            db,
            () =>
              r.createRecoveryStore(failing, "owner").commitPrepared(prepared),
            /CHECK constraint failed/,
          );
        }
        console.log(
          `Evidence: ${size + 1} real-D1 enlarged-batch rollback boundaries; exact all-table snapshots unchanged`,
        );
      },
    );
  if (selected("guards"))
    for (const scenario of [
      "body",
      "revision",
      "time",
      "source",
      "insert",
      "delete",
      "update",
      "key",
      "control",
    ])
      await check(
        `transactional exact readset/collection/source-key guard: ${scenario}`,
        async () => {
          const plan = structuredClone(r.packetPlan());
          plan.readSet.collections = [
            { kind: "all_claims", memberIds: ["claim-1"] },
          ];
          plan.readSet.sourceKeys = [
            { sourceKey: "https://example.com/job", opportunityId: null },
          ];
          plan.sourceKeys = [
            {
              sourceKey: "https://example.com/job",
              opportunityId: "opportunity-1",
              mode: "insert",
            },
          ];
          const { db, store, prepared } = await setup(
            `guard-${scenario}`,
            r.parseDomainPlan(plan),
          );
          if (scenario === "body")
            await db
              .prepare(
                "UPDATE records SET body=json_set(body,'$.nextAction','changed') WHERE kind='opportunity'",
              )
              .run();
          if (scenario === "revision")
            await db
              .prepare(
                "UPDATE records SET revision=revision+1 WHERE kind='opportunity'",
              )
              .run();
          if (scenario === "time")
            await db
              .prepare(
                "UPDATE records SET updated_at=updated_at+1 WHERE kind='opportunity'",
              )
              .run();
          if (scenario === "source")
            await db
              .prepare(
                "UPDATE records SET body=json_set(body,'$.permitted',json('false')) WHERE kind='claim'",
              )
              .run();
          if (scenario === "insert")
            await db
              .prepare(
                "INSERT INTO records SELECT owner,kind,'claim-new',json_set(body,'$.id','claim-new'),revision,updated_at FROM records WHERE kind='claim'",
              )
              .run();
          if (scenario === "delete")
            await db.prepare("DELETE FROM records WHERE kind='claim'").run();
          if (scenario === "update")
            await db
              .prepare(
                "UPDATE records SET revision=revision+1,body=json_set(body,'$.text','new source') WHERE kind='claim'",
              )
              .run();
          if (scenario === "key")
            await db
              .prepare(
                "INSERT INTO source_keys VALUES('owner','https://example.com/job','competitor')",
              )
              .run();
          if (scenario === "control") {
            await store.commitPrepared(prepared);
            assert.deepEqual(
              await db.prepare("SELECT * FROM source_keys").first(),
              {
                owner: "owner",
                source_key: "https://example.com/job",
                opportunity_id: "opportunity-1",
              },
            );
          } else
            await unchanged(
              db,
              () => store.commitPrepared(prepared),
              /RECOVERY_DOMAIN_CONFLICT/,
            );
        },
      );
  if (selected("question-guard"))
    await check(
      "an inserted unresolved profile question with missing status cannot evade the complete predicate",
      async () => {
        const plan = structuredClone(r.packetPlan());
        plan.readSet.collections = [
          { kind: "unresolved_profile_conflicts", memberIds: [] },
        ];
        const { db, store, prepared } = await setup(
          "guard-question-null",
          r.parseDomainPlan(plan),
        );
        await db
          .prepare(
            "INSERT INTO records VALUES('owner','question','new-question','{\"type\":\"profile_conflict\"}',1,100)",
          )
          .run();
        await unchanged(
          db,
          () => store.commitPrepared(prepared),
          /RECOVERY_DOMAIN_CONFLICT/,
        );
      },
    );
  if (selected("uncertain"))
    await check(
      "a real successful batch with lost response reconciles before stale business guards",
      async () => {
        const { db, prepared } = await setup("uncertain");
        const uncertain = bridge(db, async (statements) => {
          await db.batch(statements);
          throw Error("LOST_SUCCESSFUL_RESPONSE");
        });
        const store = r.createRecoveryStore(uncertain, "owner");
        const result = await store.commitPrepared(prepared);
        assert.deepEqual(result, prepared.result);
        assert.deepEqual(await store.commitPrepared(prepared), result);
        assert.equal(
          (await db.prepare("SELECT COUNT(*) AS n FROM audit").first()).n,
          2,
        );
        const other = structuredClone(prepared);
        other.requestDigest = "0".repeat(64);
        await unchanged(
          db,
          () => store.commitPrepared(other),
          /IDEMPOTENCY_CONFLICT/,
        );
        await unchanged(
          db,
          () =>
            store.readCommitted({
              workspace: { ownerId: "other", workspaceId: "workspace" },
              transactionId: prepared.transactionId,
            }),
          /RECOVERY_OWNER_MISMATCH/,
        );
        assert.equal(
          await store.readCommitted({
            workspace: { ownerId: "owner", workspaceId: "other" },
            transactionId: prepared.transactionId,
          }),
          null,
        );
      },
    );
  if (selected("observation"))
    await check(
      "same-second millisecond prepare/commit has honest SQL observation and immutable identity",
      async () => {
        const context = structuredClone(r.primaryContext);
        const { db, store, prepared } = await setup(
          "observation",
          r.packetPlan(),
          context,
          {
            memoryArchive: true,
            beforePrepare: async (fixture) => {
              let now = Date.now();
              while (now % 1000 > 100 || now % 1000 === 0) {
                await new Promise((resolve) => setTimeout(resolve, 5));
                now = Date.now();
              }
              context.serverTime = now;
              context.actor.expiresAt = now + 100000;
              context.grant.expiresAt = now + 100000;
              fixture.accepted.now = now;
            },
          },
        );
        await store.commitPrepared(prepared);
        const saved = await store.readCommitted({
          workspace: prepared.workspace,
          transactionId: prepared.transactionId,
        });
        assert.ok(prepared.createdAt % 1000 !== 0);
        assert.ok(
          saved.observation.observedAt >= prepared.createdAt &&
            saved.observation.observedAt <= Date.now(),
        );
        assert.equal(
          Math.floor(saved.observation.observedAt / 1000),
          Math.floor(prepared.createdAt / 1000),
          "Actual preparation/commit completes in one second",
        );
        for (const sql of [
          "UPDATE recovery_commit_observations SET observed_at_ms=observed_at_ms+1",
          "DELETE FROM recovery_commit_observations",
          "INSERT OR REPLACE INTO recovery_commit_observations SELECT * FROM recovery_commit_observations",
        ])
          await unchanged(
            db,
            () => db.prepare(sql).run(),
            /RECOVERY_HISTORY_IMMUTABLE/,
          );
        console.log(
          `Evidence: prepared=${prepared.createdAt}, SQL observation=${saved.observation.observedAt}, precisionMs=1`,
        );
      },
    );
  if (selected("forged-observation"))
    await check(
      "forged SQL time or transaction/result/workspace identity aborts the entire domain batch",
      async () => {
        const { db, prepared } = await setup("forged-observation");
        const unsigned = r.unsignedPreparation(prepared),
          preparationDigest = await r.hashEnvelope("preparation", unsigned),
          transactionDigest = await r.hashEnvelope("transaction", unsigned);
        for (const field of ["time", "transaction", "result", "workspace"]) {
          const forged = bridge(db, (statements) => {
            const replacement = db
              .prepare(
                `INSERT INTO recovery_commit_observations(owner,workspace_id,transaction_id,observed_at_ms,clock,precision_ms,preparation_digest,transaction_digest,result_digest) VALUES(?,?,?,${field === "time" ? "0" : "CAST(ROUND(unixepoch('subsec')*1000) AS INTEGER)"},'d1-unixepoch-subsec-v1',1,?,?,?)`,
              )
              .bind(
                "owner",
                field === "workspace"
                  ? "other"
                  : prepared.workspace.workspaceId,
                prepared.transactionId,
                preparationDigest,
                field === "transaction" ? "f".repeat(64) : transactionDigest,
                field === "result" ? "f".repeat(64) : prepared.result.digest,
              );
            return db.batch([
              ...statements.slice(0, -4),
              replacement,
              ...statements.slice(-3),
            ]);
          });
          await unchanged(
            db,
            () =>
              r.createRecoveryStore(forged, "owner").commitPrepared(prepared),
            /RECOVERY_COMMIT_OBSERVATION_CONFLICT/,
          );
        }
      },
    );
  if (selected("future"))
    await check(
      "future preparation time aborts observation and all companion effects",
      async () => {
        const now = Date.now() + 60000,
          context = structuredClone(r.primaryContext);
        context.serverTime = now;
        context.actor.expiresAt = now + 100000;
        context.grant.expiresAt = now + 100000;
        const { db, store, prepared } = await setup(
          "future",
          r.packetPlan(),
          context,
        );
        await unchanged(
          db,
          () => store.commitPrepared(prepared),
          /RECOVERY_COMMIT_OBSERVATION_CONFLICT/,
        );
      },
    );

  if (selected("closure"))
    await check(
      "separate committed baseline supplies complete exact source/artifact closure to one later mutation batch",
      async () => {
        const {
          db,
          store,
          prepared: baseline,
        } = await setup("closure", r.baselinePlan());
        await store.commitPrepared(baseline);
        const source = baseline.versions[0];
        await db
          .prepare("INSERT INTO records VALUES(?,?,?,?,?,?)")
          .bind(
            "owner",
            "opportunity",
            "opportunity-1",
            JSON.stringify(r.opportunityBody),
            1,
            100,
          )
          .run();
        const plan = structuredClone(r.packetPlan());
        plan.requestRootId = "root-closure-main";
        plan.requestKey = "request-closure-main";
        const claim = plan.readSet.records.find(
          (r) => r.recordKind === "claim",
        );
        claim.revision = 7;
        claim.updatedAt = 90;
        plan.candidates[0].sourceVersionIds = [source.versionId];
        plan.candidates[0].artifacts.push({
          role: "original-baseline-json",
          source: {
            type: "committed",
            versionId: source.versionId,
            artifactIndex: 1,
          },
        });
        const context = { ...r.primaryContext, chain: await store.getChain() };
        const fixture = await r.domainFixture(
          archive,
          r.parseDomainPlan(plan),
          context,
        );
        fixture.accepted.sources.push(source);
        const signer = r.createRecoverySigner(fixture);
        const prepared = await r.prepareRecoveryPackage(
          fixture.input,
          context,
          { ...fixture, signer },
        );
        const core = await r.readBoundPrimaryPackage(
          archive,
          r.unsignedPreparation(prepared),
        );
        assert.deepEqual(core.sources, [source]);
        assert.equal(core.manifests.length, 3);
        assert.deepEqual(
          prepared.versions[0].artifacts[2],
          source.artifacts[1],
        );
        const tampered = structuredClone(prepared),
          physical = JSON.stringify(tampered.versions[0].artifacts[2].object);
        for (const candidate of tampered.versions)
          for (const artifact of candidate.artifacts)
            if (JSON.stringify(artifact.object) === physical)
              artifact.digest = "e".repeat(64);
        for (const artifact of tampered.objects)
          if (JSON.stringify(artifact.object) === physical)
            artifact.digest = "e".repeat(64);
        tampered.result.digest = await r.hashEnvelope(
          "manifest",
          tampered.versions[0],
        );
        await unchanged(
          db,
          () => store.commitPrepared(tampered),
          /DOMAIN_COMMITTED_ARTIFACT_MISMATCH/,
        );
        fixture.accepted.sources.pop();
        await assert.rejects(
          () =>
            r.buildPrimaryPackage(
              fixture.accepted,
              { archive, trustRootIds: ["synthetic-primary"] },
              "read",
            ),
          /RECOVERY_MANIFEST_CLOSURE_MISMATCH/,
        );
        fixture.accepted.sources.push(source);
        const before = await snapshot(db);
        await store.commitPrepared(prepared);
        assert.equal(
          (
            await db
              .prepare("SELECT revision FROM records WHERE kind='claim'")
              .first()
          ).revision,
          7,
        );
        assert.equal(
          (
            await db
              .prepare("SELECT COUNT(*) AS n FROM recovery_transactions")
              .first()
          ).n,
          2,
        );
        assert.equal(
          (await db.prepare("SELECT COUNT(*) AS n FROM audit").first()).n,
          2,
        );
        assert.equal(before.recovery_transactions.length, 1);
      },
    );
  if (selected("old"))
    await check(
      "old committed history has explicit unavailable observation after additive migration",
      async () => {
        const db = await mf.getD1Database("old");
        await applyMigrations(db, { through: "0002_recovery.sql" });
        const fixture = await r.preparationFixture();
        const prepared = await r.prepareRecoveryPackage(
          r.primaryInput,
          r.primaryContext,
          fixture,
        );
        const unsigned = r.unsignedPreparation(prepared);
        const transactionDigest = await r.hashEnvelope("transaction", unsigned);
        // Historical fixture seed uses only the original schema. There was no observation
        // column/table at the time represented; the additive migration must invent none.
        await db.batch([
          db
            .prepare("INSERT INTO recovery_workspaces VALUES(?,?)")
            .bind("owner", "workspace"),
          db
            .prepare("INSERT INTO recovery_chains VALUES(?,?,?,'0',NULL)")
            .bind("owner", "workspace", "epoch"),
          db
            .prepare(
              "INSERT INTO recovery_transactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .bind(
              "owner",
              "workspace",
              prepared.transactionId,
              "epoch",
              "1",
              "0",
              null,
              transactionDigest,
              1,
              prepared.requestKey,
              prepared.requestDigest,
              JSON.stringify(prepared),
            ),
        ]);
        await db
          .prepare("INSERT INTO recovery_request_results VALUES(?,?,?,?,?,?,?)")
          .bind(
            "owner",
            "workspace",
            prepared.requestKey,
            1,
            prepared.requestDigest,
            prepared.transactionId,
            JSON.stringify(prepared.result),
          )
          .run();
        await applyMigrations(db, { after: "0002_recovery.sql" });
        const store = r.createRecoveryStore(db, "owner");
        const read = await store.readCommitted({
          workspace: prepared.workspace,
          transactionId: prepared.transactionId,
        });
        assert.equal(read.observation, null);
        assert.deepEqual(read.prepared, prepared);
        assert.deepEqual(read.result, prepared.result);
        await unchanged(
          db,
          () =>
            db
              .prepare(
                "INSERT INTO recovery_commit_observations(owner,workspace_id,transaction_id,clock,precision_ms,preparation_digest,transaction_digest,result_digest) VALUES(?,?,?,'d1-unixepoch-subsec-v1',1,?,?,?)",
              )
              .bind(
                "owner",
                "workspace",
                prepared.transactionId,
                "a".repeat(64),
                transactionDigest,
                prepared.result.digest,
              )
              .run(),
          /RECOVERY_COMMIT_OBSERVATION_CONFLICT/,
        );
      },
    );
  console.log(
    `Domain runtime checks: ${checks} passed; provider factories/send/calendar/capture/publication/processing calls: 0 (no provider assembly imported)`,
  );
} finally {
  await mf.dispose();
}
