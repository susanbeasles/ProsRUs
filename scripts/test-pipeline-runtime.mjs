process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { applyMigrations } from "./runtime-migrations.mjs";
const bundled = await build({
  stdin: {
    contents:
      "export {createRecordReads} from './src/application/record-reads'; export {planAuditedImport} from './src/application/audited-legacy-import'; export {seedAuditedLegacy} from './src/storage/audited-legacy-seed'; export {pipelineFixture} from './tests/fixtures/pipeline-inputs';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
await mkdir("artifacts/pipeline", { recursive: true });
const artifact = path.resolve(
  "artifacts/pipeline/runtime-" + Date.now() + ".mjs",
);
await writeFile(artifact, bundled.outputFiles[0].text);
const {
  createRecordReads,
  planAuditedImport,
  seedAuditedLegacy,
  pipelineFixture,
} = await import(pathToFileURL(artifact));
const receipts = [];
function instrument(db, before = async () => {}, alter = (x) => x) {
  const queries = [];
  return {
    queries,
    db: {
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          bind(...args) {
            const bound = statement.bind(...args);
            return {
              async first(...xs) {
                queries.push(sql);
                return bound.first(...xs);
              },
              async all() {
                queries.push(sql);
                if (sql.includes("pipeline-page-selection")) await before();
                return alter(await bound.all(), sql);
              },
            };
          },
        };
      },
    },
  };
}
const denied = (error) => error?.code === "operation-denied";
test("synthetic bounded pipeline reader and statement-snapshot admission", async (t) => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script:
        "export default {fetch(){return new Response('synthetic only',{status:404})}}",
      compatibilityDate: "2026-10-06",
      d1Databases: ["DB"],
    }),
  );
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  await applyMigrations(db);
  const group = process.env.PIPELINE_GROUP ?? 'all';
  assert.ok(['all','1','1-tail','2','3'].includes(group));
  let caseNumber=0, stopped=false, fixtureVersions=0;
  async function checked(name,run) {
    caseNumber++;
    if(stopped || (group==='all' ? false : group==='1' ? caseNumber>9 : group==='1-tail' ? caseNumber<2 || caseNumber>9 : group==='2' ? caseNumber<=9 || caseNumber>18 : caseNumber<=18))return;
    await t.test(name,async()=>{try {await run();} catch(error){stopped=true;throw error;}});
  }

  async function fixture(name, empty = false, count = 154, large = false) {
    const f = pipelineFixture(name, empty, count, large);
    const plan = planAuditedImport(
      {
        sources: f.sources,
        workspace: f.workspace,
        seriesId: f.profile.seriesId,
        observedAt: 100,
      },
      f.profile,
    );
    await seedAuditedLegacy(
      {
        mode: "local-miniflare",
        db,
        currentWorkspace: async () => f.workspace,
        readOriginalCopy: async (name) =>
          f.sources.find((s) => s.name === name).bytes,
      },
      plan,
      f.profile,
    );
    return {
      ...f,
      plan,
      read(transport = db) {
        return createRecordReads(
          transport,
          f.workspace.ownerId,
          f.workspace.workspaceId,
          f.profile,
        );
      },
      input: {
        workspaceId: f.workspace.workspaceId,
        view: "all",
        cursor: null,
      },
    };
  }
  let readerAvailable = false;
  await checked(
    "154 roles, five sources, ten relationships and eight unique pages use six actual SQL calls each",
    async () => {
      const f = await fixture("enumeration");
      const counter = instrument(db),
        reads = f.read(counter.db);
      readerAvailable = typeof reads.pipelinePage === "function";
      assert.equal(readerAvailable, true, "bounded page reader must exist");
      const relationships = await reads.pipelinePage({
        ...f.input,
        view: "relationships",
      });
      assert.equal(relationships.status, "available");
      assert.equal(relationships.items.length, 10);
      assert.equal(relationships.totalObservations, 154);
      assert.equal(relationships.historicalRelationships, 10);
      assert.equal(counter.queries.length, 6);
      let cursor = null,
        ids = [],
        pageCount = 0;
      const perPage = [];
      do {
        const before = counter.queries.length;
        const page = await reads.pipelinePage({ ...f.input, cursor });
        assert.equal(page.status, "available");
        assert.equal(page.range.start, ids.length + 1);
        ids.push(...page.items.map((x) => x.entityId));
        assert.equal(page.range.end, ids.length);
        assert.ok(
          page.items.every(
            (x) =>
              !("body" in x) &&
              x.history === "legacy_unversioned" &&
              x.protection === "import_pending",
          ),
        );
        cursor = page.nextCursor;
        pageCount++;
        perPage.push(counter.queries.length - before);
      } while (cursor);
      assert.equal(pageCount, 8);
      assert.equal(new Set(ids).size, 154);
      assert.deepEqual(ids, [...f.plan.records.map((x) => x.id)].sort());
      assert.deepEqual(perPage, Array(8).fill(6));
      const before = counter.queries.length;
      await reads.records({
        workspaceId: f.workspace.workspaceId,
        kind: "opportunity",
        entityId: ids[0],
      });
      assert.equal(counter.queries.length - before, 6);
      receipts.push({
        kind: "actual-local-D1-wrapper-observed",
        fixtureRoles: 154,
        fixtureSources: 5,
        historicalRelationships: 10,
        pageSql: perPage,
        firstRelationshipSql: 6,
        selectedExistingDetailSql: 6,
      });
    },
  );
  if (stopped || (group==='1' && !readerAvailable)) return; // Fail fast in the initial missing-method RED phase.
  await checked(
    "genuinely empty relationships is positively admitted",
    async () => {
      const f = await fixture("empty", true);
      const page = await f
        .read()
        .pipelinePage({ ...f.input, view: "relationships" });
      assert.equal(page.status, "available");
      assert.deepEqual(page.items, []);
      assert.deepEqual(page.range, { start: 0, end: 0 });
      assert.equal(page.totalObservations, 154);
    },
  );
  await checked(
    "155-role capacity is explicitly unavailable while existing detail works",
    async () => {
      const f = await fixture("capacity", false, 155);
      assert.equal(
        (await f.read().pipelinePage(f.input)).reason,
        "page_capacity",
      );
      assert.ok(
        (
          await f
            .read()
            .records({
              workspaceId: f.workspace.workspaceId,
              kind: "opportunity",
              entityId: f.plan.records[0].id,
            })
        ).record,
      );
    },
  );
  await checked(
    "oversized display retains identity with an explicit unavailable projection",
    async () => {
      const f = await fixture("display", false, 154, true);
      const page = await f.read().pipelinePage(f.input);
      assert.equal(
        page.items.find((x) => x.entityId.endsWith("_FXD001")).display.status,
        "unavailable",
      );
    },
  );
  await checked(
    "forged cursor/view/dataset/unknown keys/positions deny",
    async () => {
      const f = await fixture("cursor");
      const first = await f.read().pipelinePage(f.input);
      const c = JSON.parse(decodeURIComponent(first.nextCursor));
      for (const changed of [
        { view: "relationships" },
        { owner: "foreign" },
        { workspace: "foreign" },
        { dataset: "b".repeat(64) },
        { after: "missing" },
        { extra: true },
      ])
        await assert.rejects(
          f
            .read()
            .pipelinePage({
              ...f.input,
              cursor: encodeURIComponent(JSON.stringify({ ...c, ...changed })),
            }),
          denied,
        );
    },
  );
  for (const [name, mutation] of [
    [
      "extra_role",
      async (f) =>
        db
          .prepare(
            "INSERT INTO records VALUES(?,'opportunity','unexpected','{}',1,100)",
          )
          .bind(f.workspace.ownerId)
          .run(),
    ],
    [
      "missing_role",
      async (f) =>
        db
          .prepare("DELETE FROM records WHERE owner=? AND id=?")
          .bind(f.workspace.ownerId, f.plan.records.at(-1).id)
          .run(),
    ],
    [
      "selected_body",
      async (f) =>
        db
          .prepare("UPDATE records SET body='{}' WHERE owner=? AND id=?")
          .bind(f.workspace.ownerId, f.plan.records[0].id)
          .run(),
    ],
    [
      "selected_revision",
      async (f) =>
        db
          .prepare("UPDATE records SET revision=2 WHERE owner=? AND id=?")
          .bind(f.workspace.ownerId, f.plan.records[0].id)
          .run(),
    ],
    [
      "selected_time",
      async (f) =>
        db
          .prepare("UPDATE records SET updated_at=101 WHERE owner=? AND id=?")
          .bind(f.workspace.ownerId, f.plan.records[0].id)
          .run(),
    ],
    [
      "selected_oversize",
      async (f) =>
        db
          .prepare("UPDATE records SET body=? WHERE owner=? AND id=?")
          .bind(
            JSON.stringify({ large: "x".repeat(54000) }),
            f.workspace.ownerId,
            f.plan.records[0].id,
          )
          .run(),
    ],
    [
      "workspace_drift",
      async (f) =>
        db
          .prepare("INSERT INTO recovery_workspaces VALUES(?,'foreign')")
          .bind(f.workspace.ownerId)
          .run(),
    ],
    [
      "raw_source_extra",
      async (f) =>
        db
          .prepare(
            "INSERT INTO recovery_import_baselines(owner,source_table,source_kind,source_id,source_revision,source_snapshot,provenance,artifact_availability,archive_state,schema_version) VALUES(?,'audited_json','raw_input','unexpected',NULL,?,'imported_legacy_baseline','not_applicable','pending',1)",
          )
          .bind(f.workspace.ownerId, JSON.stringify(f.plan.sources[0]))
          .run(),
    ],
  ])
    await checked("final statement denies interleaved " + name, async () => {
      const f = await fixture(name);
      let invoked = 0;
      const counter = instrument(db, async () => {
        invoked++;
        await mutation(f);
      });
      await assert.rejects(f.read(counter.db).pipelinePage(f.input), denied);
      assert.equal(invoked, 1);
    });
  await checked(
    "immutable receipt and raw sources reject update/delete between reconstruction and selection",
    async () => {
      const f = await fixture("immutable");
      let attempts = 0;
      const counter = instrument(db, async () => {
        for (const sql of [
          "UPDATE recovery_import_baselines SET source_snapshot='{}' WHERE owner=?",
          "DELETE FROM recovery_import_baselines WHERE owner=?",
        ]) {
          await assert.rejects(
            db.prepare(sql).bind(f.workspace.ownerId).run(),
            /RECOVERY_HISTORY_IMMUTABLE/,
          );
          attempts++;
        }
      });
      assert.equal(
        (await f.read(counter.db).pipelinePage(f.input)).status,
        "available",
      );
      assert.equal(attempts, 2);
    },
  );
  for (const mode of [
    "missing_sentinel",
    "false_admission",
    "missing_selected",
    "duplicate_selected",
  ])
    await checked(
      "incomplete result cannot become successful empty page: " + mode,
      async () => {
        const f = await fixture(mode);
        const counter = instrument(db, undefined, (r, sql) => {
          if (!sql.includes("pipeline-page-selection")) return r;
          const rows = [...r.results];
          if (mode === "missing_sentinel") rows.shift();
          if (mode === "false_admission") rows[0] = { ...rows[0], admitted: 0 };
          if (mode === "missing_selected") rows.pop();
          if (mode === "duplicate_selected") rows.push(rows.at(-1));
          return { ...r, results: rows };
        });
        await assert.rejects(f.read(counter.db).pipelinePage(f.input), denied);
      },
    );

  await checked('unknown display remains explicitly unavailable with exact identity',async()=>{
    const f=await fixture('unknown_display');const first=await f.read().pipelinePage(f.input);
    const ids=f.plan.records.map(r=>r.id).sort();const cursor=JSON.parse(decodeURIComponent(first.nextCursor));cursor.after=ids[139];
    const last=await f.read().pipelinePage({...f.input,cursor:encodeURIComponent(JSON.stringify(cursor))});
    const unknown=last.items.find(r=>r.entityId.endsWith('_FXPOST001'));
    assert.ok(unknown);assert.deepEqual(unknown.display,{status:'unavailable',reason:'unknown'});
  });
  for (const geometry of ['version','projection']) await checked('final statement rejects interleaved canonical '+geometry,async()=>{
    const f=await fixture('canonical_'+geometry);const owner=f.workspace.ownerId,workspace=f.workspace.workspaceId;
    let inserted=0;
    const counter=instrument(db,async()=>{
      const kind=geometry==='version'?'opportunity':'artifact';
      const sql=[
        db.prepare('INSERT INTO recovery_workspaces VALUES(?,?)').bind(owner,workspace),
        db.prepare("INSERT INTO recovery_chains VALUES(?,?,'epoch','0',NULL)").bind(owner,workspace),
        db.prepare("INSERT INTO recovery_transactions VALUES(?,?,'transaction','epoch','1','0',NULL,?,1,'request',?,'{\"versions\":[],\"expectedHeads\":[]}')").bind(owner,workspace,'a'.repeat(64),'b'.repeat(64)),
        db.prepare("INSERT INTO recovery_lineages VALUES(?,?,'lineage',?,'canonical_entity')").bind(owner,workspace,kind),
        db.prepare("INSERT INTO recovery_versions VALUES(?,?,'version','lineage',?,'canonical_entity','transaction','epoch','1',1,?,'{}')").bind(owner,workspace,kind,'c'.repeat(64)),
      ];
      if(geometry==='projection')sql.push(db.prepare("INSERT INTO recovery_projections VALUES(?,?,'opportunity','canonical_entity','lineage','version','{}')").bind(owner,workspace));
      await db.batch(sql);fixtureVersions++;inserted++;
    });
    await assert.rejects(f.read(counter.db).pipelinePage(f.input),denied);assert.equal(inserted,1);
  });
  const effects = await db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM recovery_versions) versions,(SELECT COUNT(*) FROM intents) intents",
    )
    .first();
  assert.deepEqual(effects, { versions: fixtureVersions, intents: 0 });
  await writeFile(
    `artifacts/pipeline/runtime-counters-group-${group}.json`,
    JSON.stringify(receipts, null, 2) + "\n",
  );
});
