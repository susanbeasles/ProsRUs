process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { applyMigrations } from "./runtime-migrations.mjs";
const bundled = (
  await build({
    stdin: {
      contents:
        "export {planAuditedImport} from './src/application/audited-legacy-import';export {seedAuditedLegacy} from './src/storage/audited-legacy-seed';export {createRecordReads} from './src/application/record-reads';export {inputs,supplementedInputs,fixtureProfile} from './tests/fixtures/audited-inputs';export {parseAuditedSourceProfile} from './src/application/audited-source-profile';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  })
).outputFiles[0].text;
await mkdir("artifacts/read-first", { recursive: true });
const artifact = path.resolve(
  "artifacts/read-first/audited-" + Date.now() + ".mjs",
);
await writeFile(artifact, bundled);
const {
  planAuditedImport: actualPlanAuditedImport,
  seedAuditedLegacy: actualSeedAuditedLegacy,
  fixtureProfile,
  parseAuditedSourceProfile,
  inputs,
  supplementedInputs,
  createRecordReads,
} = await import(pathToFileURL(artifact));
const profileFor = (workspace, seriesId) => parseAuditedSourceProfile({ ...fixtureProfile, workspace, seriesId });
const planAuditedImport = (input) => actualPlanAuditedImport(input, profileFor(input.workspace, input.seriesId));
const seedAuditedLegacy = (ports, requested) => actualSeedAuditedLegacy(ports, requested, profileFor(requested.workspace, requested.seriesId));
test("actual local D1 seed is atomic, lossless, collision-safe and exactly repeatable", async (t) => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script:
        "export default {fetch(){return new Response('local fixture',{status:404});}}",
      compatibilityDate: "2026-10-06",
      d1Databases: ["DB"],
    }),
  );
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  await applyMigrations(db);
  const sources = inputs(),
    workspace = {
      ownerId: "synthetic_owner",
      workspaceId: "synthetic_workspace",
    };
  const plan = planAuditedImport({
    sources,
    workspace,
    seriesId: "synthetic_audit",
    observedAt: 100,
  });
  const copies = new Map(sources.map((s) => [s.name, s.bytes]));
  const ports = {
    mode: "local-miniflare",
    db,
    currentWorkspace: async () => workspace,
    readOriginalCopy: async (name) => copies.get(name),
  };
  const receipt = await seedAuditedLegacy(ports, plan);
  assert.equal(receipt.status, "legacy_imported_archive_pending");
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM records").first()).n,
    137,
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT COUNT(*) n FROM recovery_import_baselines WHERE source_kind='raw_input'",
        )
        .first()
    ).n,
    4,
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM recovery_versions").first()).n,
    0,
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM intents").first()).n,
    0,
  );
  const retry = planAuditedImport({
    sources,
    workspace,
    seriesId: "synthetic_audit",
    observedAt: 999,
  });
  assert.deepEqual(await seedAuditedLegacy(ports, retry), receipt);
  assert.equal(
    (await db.prepare("SELECT MAX(updated_at) n FROM records").first()).n,
    100,
  );
  await assert.rejects(seedAuditedLegacy({ ...ports, mode: "remote" }, plan));
  await assert.rejects(
    seedAuditedLegacy(
      {
        ...ports,
        currentWorkspace: async () => ({
          ...workspace,
          workspaceId: "foreign",
        }),
      },
      plan,
    ),
  );
  const changed = structuredClone(sources);
  changed[0].receipt.note = "changed import meaning";
  const conflict = planAuditedImport({
    sources: changed,
    workspace,
    seriesId: "synthetic_audit",
    observedAt: 100,
  });
  await assert.rejects(seedAuditedLegacy(ports, conflict));
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM records").first()).n,
    137,
  );
  // A collision late in the real batch must roll back its earlier writes and receipt.
  const other = {
    ownerId: "rollback_owner",
    workspaceId: "rollback_workspace",
  };
  const rollback = planAuditedImport({
    sources,
    workspace: other,
    seriesId: "synthetic_audit",
    observedAt: 500,
  });
  const occupied = rollback.records.at(-1);
  await db
    .prepare(
      "INSERT INTO records(owner,kind,id,body,revision,updated_at) VALUES(?,'opportunity',?,'{}',1,5)",
    )
    .bind(other.ownerId, occupied.id)
    .run();
  await assert.rejects(
    seedAuditedLegacy(
      { ...ports, currentWorkspace: async () => other },
      rollback,
    ),
  );
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM records WHERE owner=?")
        .bind(other.ownerId)
        .first()
    ).n,
    1,
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT COUNT(*) n FROM recovery_import_baselines WHERE owner=?",
        )
        .bind(other.ownerId)
        .first()
    ).n,
    0,
  );
  // A failed original readback after commit cannot produce a success receipt.
  const uncertain = {
    ownerId: "uncertain_owner",
    workspaceId: "uncertain_workspace",
  };
  const uncertainPlan = planAuditedImport({
    sources,
    workspace: uncertain,
    seriesId: "synthetic_audit",
    observedAt: 700,
  });
  let copyReads = 0;
  await assert.rejects(
    seedAuditedLegacy(
      {
        ...ports,
        currentWorkspace: async () => uncertain,
        readOriginalCopy: async (name) =>
          ++copyReads > 4 ? new Uint8Array([0]) : copies.get(name),
      },
      uncertainPlan,
    ),
    /AUDIT_ORIGINAL_READBACK/,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM records WHERE owner=?")
        .bind(uncertain.ownerId)
        .first()
    ).n,
    137,
  );
  assert.equal(
    (
      await seedAuditedLegacy(
        { ...ports, currentWorkspace: async () => uncertain },
        uncertainPlan,
      )
    ).importObservedAt,
    700,
  );

  const fifthSources = supplementedInputs(),
    fifthWorkspace = { ownerId: "fifth_owner", workspaceId: "fifth_workspace" };
  const fifthPlan = planAuditedImport({
    sources: fifthSources,
    workspace: fifthWorkspace,
    seriesId: "synthetic_fifth",
    observedAt: 800,
  });
  await seedAuditedLegacy(
    {
      ...ports,
      currentWorkspace: async () => fifthWorkspace,
      readOriginalCopy: async (name) =>
        fifthSources.find((s) => s.name === name).bytes,
    },
    fifthPlan,
  );
  const reads = createRecordReads(
    db,
    fifthWorkspace.ownerId,
    fifthWorkspace.workspaceId,
    profileFor(fifthWorkspace, "synthetic_fifth"),
  );
  const target = fifthPlan.records.find(
    (r) => r.body.source.sourceId === "FXD003",
  );
  const detail = await reads.records({
    workspaceId: fifthWorkspace.workspaceId,
    kind: "opportunity",
    entityId: target.id,
  });
  assert.equal(detail.record.provenance.sourceReceipts.length, 5);
  assert.equal(detail.record.body.display.status, "pending");
  const original = fifthPlan.sources[0];
  const corrupted = {
    ...original,
    rawUtf8: original.rawUtf8.replace("Independent fixture company", "CORRUPTED DATA"),
  };
  await assert.rejects(
    db
      .prepare(
        "UPDATE recovery_import_baselines SET source_snapshot=? WHERE owner=? AND source_kind='raw_input' AND source_id=?",
      )
      .bind(
        JSON.stringify(corrupted),
        fifthWorkspace.ownerId,
        original.rawSha256,
      )
      .run(),
    /RECOVERY_HISTORY_IMMUTABLE/,
  );
  const corruptTransport = {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        bind(...values) {
          const bound = statement.bind(...values);
          if (sql.includes("source_kind='raw_input'"))
            return {
              first(...arguments_) {
                return bound.first(...arguments_);
              },
              async all() {
                const result = await bound.all();
                return {
                  ...result,
                  results: result.results.map((row) =>
                    JSON.parse(row.source_snapshot).rawSha256 ===
                    original.rawSha256
                      ? { ...row, source_snapshot: JSON.stringify(corrupted) }
                      : row,
                  ),
                };
              },
            };
          return bound;
        },
      };
    },
  };
  await assert.rejects(
    createRecordReads(
      corruptTransport,
      fifthWorkspace.ownerId,
      fifthWorkspace.workspaceId,
      profileFor(fifthWorkspace, "synthetic_fifth"),
    ).records({
      workspaceId: fifthWorkspace.workspaceId,
      kind: "opportunity",
      entityId: target.id,
    }),
    /AUDIT_SOURCE_HASH/,
  );
});
