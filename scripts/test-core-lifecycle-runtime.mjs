import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { applyMigrations } from "./runtime-migrations.mjs";
process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
mkdirSync("artifacts", { recursive: true });
await build({
  entryPoints: ["scripts/core-operation-runtime-exports.ts"],
  outfile: "artifacts/core-lifecycle-runtime.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
});
const r = await import("../artifacts/core-lifecycle-runtime.mjs");
const cases = ["before-baseline", "during-baseline", "lost-binding"];
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script:
      'export default {fetch(){return new Response("local lifecycle regression")}}',
    compatibilityDate: "2026-10-08",
    cf: false,
    d1Databases: Object.fromEntries(cases.map((name) => [name, name])),
    r2Buckets: ["BUCKET"],
  }),
);
let checks = 0;
const pass = (message) => console.log(`PASS ${++checks}: ${message}`);
try {
  for (const name of cases) {
    const db = await mf.getD1Database(name);
    await applyMigrations(db);
    const store = r.createRecoveryStore(db, "owner"),
      archive = r.createPrimaryArchive(await mf.getR2Bucket("BUCKET"));
    const manifests = new Map();
    let serial = 0;
    async function savePlan(plan) {
      const context = {
          ...r.primaryContext,
          chain: serial === 0 ? r.primaryContext.chain : await store.getChain(),
        },
        f = await r.domainFixture(archive, plan, context),
        label = `${name}-${++serial}`;
      f.accepted.transactionId = `transaction-${label}`;
      f.accepted.domainPlan.candidateVersions = plan.candidates.map((c) => ({
        role: c.role,
        versionId: `version-${label}-${c.role}`,
      }));
      f.accepted.versionId = f.accepted.domainPlan.candidateVersions.find(
        (c) => c.role === plan.resultRecord.candidateRole,
      ).versionId;
      const wanted = new Set();
      function visit(id) {
        if (wanted.has(id)) return;
        const m = manifests.get(id);
        assert(m, `missing ${id}`);
        wanted.add(id);
        for (const other of [...m.parentVersionIds, ...m.sourceVersionIds])
          visit(other);
      }
      for (const c of plan.candidates)
        for (const id of [...c.parentVersionIds, ...c.sourceVersionIds])
          visit(id);
      f.accepted.parents = [...wanted].map((id) => manifests.get(id));
      const prepared = await r.prepareRecoveryPackage(f.input, context, {
          ...f,
          signer: r.createRecoverySigner(f),
        }),
        save = await store.commitPrepared(prepared);
      for (const m of prepared.versions) manifests.set(m.versionId, m);
      return {
        prepared,
        result: {
          entityId: plan.resultRecord.entityId,
          revision: String(plan.resultRecord.revision),
          save,
        },
      };
    }
    const base = r.packetRequest(),
      opGuard = r.present("opportunity", "opportunity-1", r.opportunityBody),
      mailGuard = r.present("question", "mail-1", {
        providerThreadId: "mail-provider",
        recipient: "recruiter@example.com",
        subject: "Subject",
        preview: "Message",
        flags: [],
        status: "unassociated",
      });
    for (const g of [opGuard, mailGuard])
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
    await db
      .prepare(
        "INSERT INTO source_keys(owner,source_key,opportunity_id) VALUES(?,?,?)",
      )
      .bind("owner", r.opportunityBody.sourceUrl, "opportunity-1")
      .run();
    const opSlot = {
        role: "opportunity",
        recordKind: "opportunity",
        entityId: "opportunity-1",
        lineageId: "lineage-opportunity-1",
        auditEventId: "audit-op",
      },
      opBinding = {
        ...base.read.bindings.find((b) => b.recordKind === "opportunity"),
        versionId: null,
        heads: [],
      };
    const capture = {
      ...base,
      operationId: "job-stack.opportunity.capture.v1",
      input: {
        workspaceId: "workspace",
        requestKey: "capture-preserve",
        body: {
          company: r.opportunityBody.company,
          role: r.opportunityBody.role,
          sourceUrl: r.opportunityBody.sourceUrl,
          description: r.opportunityBody.description,
          terms: r.opportunityBody.terms,
        },
      },
      allocation: {
        ...base.allocation,
        requestRootId: "root-capture",
        records: [opSlot],
      },
      read: {
        records: [opGuard],
        bindings: [opBinding],
        collections: [],
        sourceKeys: [
          {
            sourceKey: r.opportunityBody.sourceUrl,
            opportunityId: "opportunity-1",
          },
        ],
      },
      currentEvidence: {
        checkedAt: 1000,
        ownerInteraction: null,
        claims: [],
        sourceArtifacts: [],
      },
    };
    let originalBinding = opBinding;
    if (name !== "lost-binding") {
      const seeded = await savePlan(
          r.planCoreOperation({
            ...capture,
            phase: "baseline-archive-v1",
            baseline: {
              requestKey: "capture-baseline",
              originals: [],
              migrations: [],
            },
          }),
        ),
        original = seeded.prepared.versions[0];
      originalBinding = {
        ...opBinding,
        versionId: original.versionId,
        heads: [original.versionId],
        sourceVersionIds: original.sourceVersionIds,
      };
      capture.read.bindings = [originalBinding];
    }
    async function moveSource() {
      return savePlan(r.planCoreOperation(capture));
    }
    const operation = r.parseDomainOperation({
      operationId: "job-stack.conversation.associate.v1",
      input: {
        workspaceId: "workspace",
        requestKey: "association-public",
        body: { opportunityId: "opportunity-1", questionId: "mail-1" },
      },
    });
    const allocation = {
      ...base.allocation,
      requestRootId: "root-association",
      records: [
        {
          role: "thread",
          recordKind: "thread",
          entityId: "thread-new",
          lineageId: "lineage-thread-new",
          auditEventId: "audit-thread",
        },
        {
          role: "question",
          recordKind: "question",
          entityId: "mail-1",
          lineageId: "lineage-mail-1",
          auditEventId: "audit-mail",
        },
      ],
    };
    const observation = {
      records: [
        opGuard,
        mailGuard,
        { recordKind: "thread", entityId: "thread-new", state: "absent" },
      ],
      bindings: [
        originalBinding,
        {
          recordKind: "question",
          entityId: "mail-1",
          lineageId: "lineage-mail-1",
          versionId: null,
          heads: [],
          revision: 1,
          sourceVersionIds: [],
        },
      ],
      collections: [],
      sourceKeys: [],
    };
    let root = {
        operation,
        inputDigest: r.coreInputDigest(operation),
        allocation,
        observation,
        baseline: null,
        main: null,
      },
      lost = false;
    const commits = [];
    async function observe() {
      const read = structuredClone(observation);
      for (const guard of read.records) {
        const row = await db
          .prepare(
            "SELECT * FROM records WHERE owner='owner' AND kind=? AND id=?",
          )
          .bind(guard.recordKind, guard.entityId)
          .first();
        if (row)
          Object.assign(guard, {
            state: "present",
            rawBody: row.body,
            revision: row.revision,
            updatedAt: row.updated_at,
          });
      }
      for (const binding of read.bindings) {
        const heads = (
          await db
            .prepare(
              "SELECT version_id FROM recovery_heads WHERE owner='owner' AND lineage_id=? ORDER BY version_id",
            )
            .bind(binding.lineageId)
            .all()
        ).results.map((h) => h.version_id);
        binding.versionId = heads.length === 1 ? heads[0] : null;
        binding.heads = heads;
        binding.sourceVersionIds =
          binding.versionId === null
            ? []
            : manifests.get(binding.versionId).sourceVersionIds;
      }
      return read;
    }
    const ports = {
      async authorize() {},
      async loadRoot() {
        return root;
      },
      async allocateRoot() {
        throw Error("unexpected allocation");
      },
      observe,
      async retainObservation(current, read) {
        root = { ...current, observation: read };
        return root;
      },
      async resolveBaselineInputs() {
        return {
          requestKey: "internal-association-baseline",
          originals: [],
          migrations: [],
        };
      },
      async bindCommittedBaseline(current, value, result) {
        const winner = await store.findRequest(
          value.plan.requestKey,
          value.digest,
        );
        assert.deepEqual(winner, result.save);
        const prepared = await store.getPrepared(winner.transactionId);
        assert(prepared?.domainEffects);
        assert.deepEqual(prepared.domainEffects.plan, value.plan);
        if (name === "lost-binding" && !lost) {
          lost = true;
          throw Error("LOST_BINDING_RESPONSE");
        }
        const bound = {
          ...current.observation,
          bindings: current.observation.bindings.map((b) => {
            if (b.versionId !== null) return b;
            const candidate = value.plan.candidates.find(
                (c) =>
                  c.snapshot.recordKind === b.recordKind &&
                  c.snapshot.entityId === b.entityId,
              ),
              version = prepared.domainEffects.candidateVersions.find(
                (v) => v.role === candidate.role,
              ),
              manifest = prepared.versions.find(
                (v) => v.versionId === version.versionId,
              );
            assert(manifest);
            return {
              ...b,
              versionId: manifest.versionId,
              heads: [manifest.versionId],
              sourceVersionIds: manifest.sourceVersionIds,
            };
          }),
        };
        return {
          observation: bound,
          candidateVersions: prepared.domainEffects.candidateVersions,
        };
      },
      async resolveCurrentEvidence() {
        return {
          checkedAt: 1000,
          ownerInteraction: null,
          claims: [],
          sourceArtifacts: [],
        };
      },
      async retainPlan(current, phase, value) {
        root = { ...current, [phase]: value };
        return root;
      },
      async findCommitted(_current, value) {
        const save = await store.findRequest(
          value.plan.requestKey,
          value.digest,
        );
        return save
          ? {
              entityId: value.plan.resultRecord.entityId,
              revision: String(value.plan.resultRecord.revision),
              save,
            }
          : null;
      },
      async commit(_current, value) {
        commits.push(value.plan.phase);
        const out = await savePlan(value.plan);
        if (
          name === "during-baseline" &&
          value.plan.phase === "baseline-archive-v1"
        )
          await moveSource();
        return out.result;
      },
    };
    if (name === "before-baseline") {
      const moved = await moveSource();
      assert.deepEqual(
        moved.prepared.versions[0].recordSnapshot,
        manifests.get(originalBinding.versionId).recordSnapshot,
      );
      const before = await db
        .prepare("SELECT count(*) n FROM recovery_transactions")
        .first();
      await assert.rejects(
        r.runCoreOperation(operation, ports),
        (e) =>
          e instanceof r.DomainError &&
          e.code === "DOMAIN_REQUEST_MEANING_CONFLICT" &&
          e.status === 409,
      );
      assert.equal(
        (
          await db
            .prepare("SELECT count(*) n FROM recovery_transactions")
            .first()
        ).n,
        before.n,
      );
      assert.deepEqual(commits, []);
      pass(
        "legitimate current source preserve/head move denies mixed baseline before any baseline/main effects",
      );
    } else if (name === "during-baseline") {
      await assert.rejects(
        r.runCoreOperation(operation, ports),
        (e) =>
          e instanceof r.DomainError &&
          e.code === "DOMAIN_REQUEST_MEANING_CONFLICT" &&
          e.status === 409,
      );
      assert.deepEqual(commits, ["baseline-archive-v1"]);
      assert.equal(
        (
          await db
            .prepare("SELECT count(*) n FROM records WHERE kind='thread'")
            .first()
        ).n,
        0,
      );
      assert.equal(await store.findRequest("association-public"), null);
      pass(
        "source movement after actual baseline denies main after complete current reread",
      );
    } else {
      await assert.rejects(
        r.runCoreOperation(operation, ports),
        /LOST_BINDING_RESPONSE/,
      );
      assert.equal(
        root.observation.bindings.every((b) => b.versionId === null),
        true,
      );
      const result = await r.runCoreOperation(operation, ports);
      assert.deepEqual(commits, ["baseline-archive-v1", "mutation"]);
      const actual = await store.getPrepared(result.save.transactionId),
        baseline = await store.getPrepared(
          (await store.findRequest("internal-association-baseline"))
            .transactionId,
        );
      assert.equal(baseline.versions.length, 2);
      for (const version of baseline.versions)
        assert(
          actual.versions
            .find((v) => v.kind === "conversation")
            .sourceVersionIds.includes(version.versionId),
        );
      const replay = await r.runCoreOperation(operation, {
        ...ports,
        async observe() {
          throw Error("stale read must not run");
        },
      });
      assert.deepEqual(replay, result);
      pass(
        "actual committed two-candidate baseline/D1 mapping reconciles lost binding response and early main replay without duplicate effects",
      );
    }
  }
  console.log(
    `${checks} real lifecycle D1/R2 regression checks passed; current authority/root retention fixtures remain synthetic4I seams.`,
  );
} finally {
  await mf.dispose();
}
