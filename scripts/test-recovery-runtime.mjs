import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { applyMigrations, splitMigrationSql } from "./runtime-migrations.mjs";
import assert from "node:assert/strict";
import replacementFixtures from "../tests/fixtures/recovery-replacement.json" with { type: "json" };

process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
mkdirSync("artifacts", { recursive: true });
await build({
  entryPoints: ["scripts/runtime-exports.ts"],
  outfile: "artifacts/recovery-testing.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
});
const runtime = await import("../artifacts/recovery-testing.mjs");
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script:
      'export default { fetch() { return new Response("local recovery fixture"); } };',
    compatibilityDate: "2026-10-08",
    cf: false,
    d1Databases: {
      DB: "recovery",
      UPGRADE: "upgrade",
      MIGRATION_FAILURE: "migration-failure",
      ORDINALS: "ordinal-boundary",
    },
    r2Buckets: ["UPGRADE_ARTIFACTS"],
  }),
);
let checks = 0;
const format = {
  schemaVersion: 1,
  canonicalizationVersion: "jcs-rfc8785-v1",
  hashAlgorithm: "sha256-domain-v1",
};
const signature = { keyId: "synthetic-key", algorithm: "ES256", jws: "a.b.c" };
async function fixture(store, overrides = {}) {
  const workspace = overrides.workspace ?? {
    ownerId: "owner",
    workspaceId: "workspace",
  };
  let chain;
  try {
    chain = await store.getChain();
  } catch (error) {
    if (!String(error).includes("RECOVERY_WORKSPACE_UNINITIALIZED"))
      throw error;
    chain = {
      epochId: "synthetic-epoch",
      sequence: "0",
      previousTransactionDigest: null,
    };
  }
  const suffix = overrides.suffix ?? String(BigInt(chain.sequence) + 1n);
  const transactionId = `transaction-${suffix}`;
  const versionId = `version-${suffix}`;
  const lineageId = overrides.lineageId ?? "lineage";
  const parentVersionIds =
    overrides.parentVersionIds ?? (await store.getHeads(lineageId));
  const sequence = overrides.sequence ?? String(BigInt(chain.sequence) + 1n);
  const branchRequested = overrides.branchRequested ?? false;
  const epochId = overrides.epochId ?? chain.epochId;
  const manifest = {
    ...format,
    workspace,
    epochId,
    sequence,
    transactionId,
    versionId,
    lineageId,
    entityId: overrides.entityId ?? "resume",
    kind: overrides.kind ?? "resume",
    parentVersionIds,
    branchRequested,
    sourceVersionIds: [],
    recordSnapshot: { text: overrides.text ?? `exact original ${suffix}\r\n` },
    artifacts: [],
    approval: { state: "draft", evidenceVersionIds: [] },
    actorId: "access-owner:owner@example.com",
    createdAt: 1000,
    generationRecipe: null,
    recoveryLocator: {
      workspaceId: workspace.workspaceId,
      lineageId,
      formatVersion: 1,
      namespace: "recovery",
      archives: [{ provider: "primary", namespace: "recovery" }],
      trustRootIds: ["synthetic-key"],
    },
  };
  const result = {
    versionId,
    transactionId,
    digest: await runtime.hashEnvelope("manifest", manifest),
    statusUrl: `/versions/${versionId}/protection`,
    status: "saved_primary",
    protection: "protection_pending",
  };
  return {
    ...format,
    purpose: "preparation",
    workspace,
    epochId,
    sequence,
    previousTransactionDigest: chain.previousTransactionDigest,
    transactionId,
    requestKey: overrides.requestKey ?? `request-${suffix}`,
    requestDigest: await runtime.hashEnvelope("request", {
      suffix,
      text: manifest.recordSnapshot.text,
    }),
    actorId: manifest.actorId,
    issuer: "synthetic-control",
    audience: "job-stack",
    grant: {
      id: "grant",
      revision: "1",
      scopes: ["write"],
      resourceBounds: [{ kind: manifest.kind, id: manifest.entityId }],
      expiresAt: 100000,
    },
    createdAt: 1000,
    versions: [manifest],
    events: [],
    expectedHeads: [{ lineageId, parentVersionIds, branchRequested }],
    objects: [],
    sourceDescriptors: [],
    packageObject: {
      provider: "primary",
      namespace: "recovery",
      key: `packages/${transactionId}`,
      versionId: null,
    },
    result,
    signature,
  };
}
const countTables = [
  "recovery_versions",
  "recovery_transactions",
  "recovery_request_results",
  "recovery_audit",
  "recovery_outbox",
  "recovery_events",
  "recovery_heads",
  "recovery_projections",
  "recovery_workspaces",
  "recovery_chains",
  "recovery_lineages",
  "recovery_protection",
  "recovery_protection_receipts",
  "recovery_job_history",
];
async function counts(db) {
  const result = {};
  for (const table of countTables)
    result[table] = (
      await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()
    ).n;
  return result;
}
async function checked(name, operation) {
  await operation();
  checks++;
  console.log(`PASS: ${name}`);
}
async function rejectUnchanged(db, operation, pattern) {
  const beforeCounts = await counts(db);
  await assert.rejects(operation, pattern);
  const afterCounts = await counts(db);
  assert.deepEqual(afterCounts, beforeCounts);
}
async function recoveryRows(db) {
  const snapshot = {};
  for (const table of [...countTables, "recovery_import_baselines"])
    snapshot[table] = (
      await db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()
    ).results;
  return snapshot;
}
async function seedOrdinalHistory(db, ordinalCase, owner) {
  const sqlFor = (sql) =>
    sql
      .replaceAll("'owner'", `'${owner}'`)
      .replaceAll("'changed-owner'", `'changed-${owner}'`);
  const statements = [
    db.prepare(
      sqlFor("INSERT INTO recovery_workspaces VALUES('owner','workspace')"),
    ),
  ];
  if (ordinalCase.table !== "recovery_workspaces")
    statements.push(
      db.prepare(
        sqlFor(
          "INSERT INTO recovery_chains VALUES('owner','workspace','epoch','0',NULL)",
        ),
      ),
      db
        .prepare(
          sqlFor(
            "INSERT INTO recovery_transactions VALUES('owner','workspace','transaction','epoch','1','0',NULL,?,1,'request',?,'{\"versions\":[],\"expectedHeads\":[]}')",
          ),
        )
        .bind("a".repeat(64), "c".repeat(64)),
    );
  statements.push(...ordinalCase.setup.map((sql) => db.prepare(sqlFor(sql))));
  await db.batch(statements);
  return sqlFor(ordinalCase.replace);
}
async function ordinalAffectedRows(db, table) {
  const snapshot = {};
  for (const name of new Set([table, "recovery_chains", "recovery_audit"]))
    snapshot[name] = (
      await db.prepare(`SELECT rowid,* FROM ${name} ORDER BY rowid`).all()
    ).results;
  return snapshot;
}
function gateFirstCommitBatches(db) {
  let arrivals = 0;
  let releaseReady;
  let releaseWinner;
  const ready = new Promise((resolve) => {
    releaseReady = resolve;
  });
  const winnerDone = new Promise((resolve) => {
    releaseWinner = resolve;
  });
  return (winner) =>
    new Proxy(db, {
      get(target, property) {
        if (property === "batch")
          return async (statements) => {
            if (++arrivals === 2) releaseReady();
            await ready;
            if (!winner) await winnerDone;
            try {
              return await target.batch(statements);
            } finally {
              if (winner) releaseWinner();
            }
          };
        return typeof target[property] === "function"
          ? target[property].bind(target)
          : target[property];
      },
    });
}
function commitWinnerAfterBindingRead(db, winner) {
  let injected = false;
  const wrap = (statement) =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values) => wrap(target.bind(...values));
        if (property === "first")
          return async (...args) => {
            const result = await target.first(...args);
            if (!injected) {
              injected = true;
              await runtime
                .createRecoveryStore(db, winner.workspace.ownerId)
                .commitPrepared(winner);
            }
            return result;
          };
        return typeof target[property] === "function"
          ? target[property].bind(target)
          : target[property];
      },
    });
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql) => {
          const statement = target.prepare(sql);
          return sql ===
            "SELECT workspace_id,epoch_id FROM recovery_chains WHERE owner=?"
            ? wrap(statement)
            : statement;
        };
      return typeof target[property] === "function"
        ? target[property].bind(target)
        : target[property];
    },
  });
}
function outcome(settled) {
  return settled.status === "fulfilled"
    ? "saved_primary"
    : (/RECOVERY_(?:WORKSPACE_MISMATCH|CHAIN_CONFLICT)/.exec(
        String(settled.reason),
      )?.[0] ?? String(settled.reason));
}
try {
  const db = await mf.getD1Database("DB");
  await applyMigrations(db);
  await checked("recovery schema exists after ordered migrations", async () => {
    const schema = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='recovery_versions'",
      )
      .all();
    assert.equal(
      schema.results.length,
      1,
      "recovery_versions schema is missing",
    );
    assert.equal(
      typeof runtime.createRecoveryStore,
      "function",
      "RecoveryStore adapter is missing",
    );
  });
  await checked(
    "migration tokenizer preserves comments, quoted semicolons and multi-statement triggers",
    async () => {
      const sql = `-- lead;\nCREATE TABLE parser_test(value TEXT); CREATE TRIGGER parser_trigger BEFORE INSERT ON parser_test BEGIN SELECT CASE WHEN NEW.value='bad;value' THEN RAISE(ABORT,'PARSER_ABORT') END; SELECT 1; END; /* tail; */`;
      const statements = splitMigrationSql(sql);
      assert.equal(statements.length, 2);
      await db.batch(statements.map((statement) => db.prepare(statement)));
      await assert.rejects(
        () => db.prepare("INSERT INTO parser_test VALUES('bad;value')").run(),
        /PARSER_ABORT/,
      );
    },
  );
  const store = runtime.createRecoveryStore(db, "owner");
  await checked("empty store exposes no invented workspace epoch", async () => {
    await assert.rejects(
      () => store.getChain(),
      /RECOVERY_WORKSPACE_UNINITIALIZED/,
    );
    assert.equal(await store.findRequest("unknown"), null);
    assert.deepEqual(await store.getHeads("lineage"), []);
  });
  const first = await fixture(store);
  await checked(
    "primary commit stores the complete atomic set and canonical result",
    async () => {
      assert.deepEqual(await store.commitPrepared(first), first.result);
      assert.equal((await counts(db)).recovery_versions, 1);
      assert.equal((await counts(db)).recovery_request_results, 1);
      assert.equal((await counts(db)).recovery_audit, 1);
      assert.equal((await counts(db)).recovery_outbox, 1);
      assert.deepEqual(await store.getHeads("lineage"), [
        first.result.versionId,
      ]);
      assert.deepEqual(await store.getPrepared(first.transactionId), first);
      assert.deepEqual(
        await store.getVersion(first.result.versionId),
        first.versions[0],
      );
    },
  );
  await checked(
    "nonpositive ordinals reject atomically while implicit and NULL allocation remain valid in all ten tables",
    async () => {
      const ordinalDb = await mf.getD1Database("ORDINALS");
      await applyMigrations(ordinalDb);
      for (const [index, ordinalCase] of replacementFixtures.entries()) {
        const owner = `ordinal-${index}`;
        const candidateSql = await seedOrdinalHistory(
          ordinalDb,
          ordinalCase,
          owner,
        );
        const before = await recoveryRows(ordinalDb);
        const affected = await ordinalAffectedRows(
          ordinalDb,
          ordinalCase.table,
        );
        for (const alias of ["rowid", "_rowid_", "oid"])
          for (const value of [-2, -1, 0]) {
            const invalid = candidateSql
              .replace("$ROWID", alias)
              .replace("$RID", String(value));
            await assert.rejects(
              () => ordinalDb.prepare(invalid).run(),
              /RECOVERY_INVALID_ORDINAL/,
            );
            assert.deepEqual(
              await ordinalAffectedRows(ordinalDb, ordinalCase.table),
              affected,
            );
            await assert.rejects(
              () =>
                ordinalDb.batch([
                  ordinalDb
                    .prepare(
                      "INSERT INTO recovery_audit VALUES(?,'workspace','ordinal-marker-before',1,'{}')",
                    )
                    .bind(owner),
                  ordinalDb.prepare(invalid),
                  ordinalDb
                    .prepare(
                      "INSERT INTO recovery_audit VALUES(?,'workspace','ordinal-marker-after',1,'{}')",
                    )
                    .bind(owner),
                ]),
              /RECOVERY_INVALID_ORDINAL/,
            );
            assert.deepEqual(
              await ordinalAffectedRows(ordinalDb, ordinalCase.table),
              affected,
            );
          }
        assert.deepEqual(await recoveryRows(ordinalDb), before);
        await ordinalDb
          .prepare(
            candidateSql
              .replace("INSERT OR REPLACE", "INSERT")
              .replace("($ROWID,", "(")
              .replace("VALUES($RID,", "VALUES("),
          )
          .run();
        const allocated = (
          await ordinalDb
            .prepare(`SELECT rowid,* FROM ${ordinalCase.table} ORDER BY rowid`)
            .all()
        ).results;
        const oldIds = new Set(
          before[ordinalCase.table].map((row) => row.rowid),
        );
        assert.deepEqual(
          allocated.filter((row) => oldIds.has(row.rowid)),
          before[ordinalCase.table],
        );
        const added = allocated.filter((row) => !oldIds.has(row.rowid));
        assert.equal(added.length, 1);
        assert.ok(added[0].rowid > 0);
        for (const alias of ["rowid", "_rowid_", "oid"]) {
          const nullSql = await seedOrdinalHistory(
            ordinalDb,
            ordinalCase,
            `null-${index}-${alias}`,
          );
          await ordinalDb
            .prepare(nullSql.replace("$ROWID", alias).replace("$RID", "NULL"))
            .run();
        }
        assert.equal(
          (
            await ordinalDb
              .prepare(
                `SELECT count(*) AS n FROM ${ordinalCase.table} WHERE rowid<=0`,
              )
              .first()
          ).n,
          0,
        );
      }
      const safeStore = runtime.createRecoveryStore(
        ordinalDb,
        "safe-ordinal-commit",
      );
      const prepared = await fixture(safeStore, {
        suffix: "safe-ordinal",
        workspace: {
          ownerId: "safe-ordinal-commit",
          workspaceId: "safe-ordinal-commit",
        },
      });
      assert.deepEqual(
        await safeStore.commitPrepared(prepared),
        prepared.result,
      );
      console.log(
        "Evidence: 90 nonpositive statement rejections, 90 D1 batch rollbacks, 10 subsequent ordinary writes, 30 NULL alias allocations and a normal prepared commit.",
      );
    },
  );
  await checked(
    "persisted outcomes bind workspace and epoch across both bootstrap reconciliation paths",
    async () => {
      const actual = [];
      const expected = [];
      for (const flow of ["batch-race", "between-prereads"]) {
        for (const conflict of ["workspace", "epoch"]) {
          const owner = `${flow}-${conflict}`;
          const ordinary = runtime.createRecoveryStore(db, owner);
          const winner = await fixture(ordinary, {
            suffix: "same-context-request",
            requestKey: "same-request",
            workspace: { ownerId: owner, workspaceId: "winner" },
          });
          const loser = await fixture(ordinary, {
            suffix: "same-context-request",
            requestKey: "same-request",
            workspace: {
              ownerId: owner,
              workspaceId: conflict === "workspace" ? "loser" : "winner",
            },
            epochId: conflict === "epoch" ? "other-epoch" : winner.epochId,
          });
          assert.equal(winner.requestDigest, loser.requestDigest);
          let result;
          if (flow === "batch-race") {
            const gate = gateFirstCommitBatches(db);
            const settled = await Promise.allSettled([
              runtime
                .createRecoveryStore(gate(true), owner)
                .commitPrepared(winner),
              runtime
                .createRecoveryStore(gate(false), owner)
                .commitPrepared(loser),
            ]);
            assert.deepEqual(settled[0].value, winner.result);
            result = settled[1];
          } else {
            result = (
              await Promise.allSettled([
                runtime
                  .createRecoveryStore(
                    commitWinnerAfterBindingRead(db, winner),
                    owner,
                  )
                  .commitPrepared(loser),
              ])
            )[0];
          }
          actual.push({ flow, conflict, outcome: outcome(result) });
          expected.push({
            flow,
            conflict,
            outcome:
              conflict === "workspace"
                ? "RECOVERY_WORKSPACE_MISMATCH"
                : "RECOVERY_CHAIN_CONFLICT",
          });
          const persisted = await ordinary.getVersion(winner.result.versionId);
          assert.equal(
            persisted.workspace.workspaceId,
            winner.workspace.workspaceId,
          );
          assert.equal(persisted.epochId, winner.epochId);
          assert.equal(
            (await ordinary.listVersions("lineage")).items.length,
            1,
          );
        }
      }
      console.log(`Context reconciliation evidence: ${JSON.stringify(actual)}`);
      assert.deepEqual(actual, expected);
    },
  );
  await checked(
    "same-context first-commit races and lost responses preserve one genuine result",
    async () => {
      const owner = "identical-bootstrap";
      const store = runtime.createRecoveryStore(db, owner);
      const candidate = await fixture(store, {
        suffix: "same",
        workspace: { ownerId: owner, workspaceId: owner },
      });
      const gate = gateFirstCommitBatches(db);
      const results = await Promise.all([
        runtime
          .createRecoveryStore(gate(true), owner)
          .commitPrepared(candidate),
        runtime
          .createRecoveryStore(gate(false), owner)
          .commitPrepared(candidate),
      ]);
      assert.deepEqual(results, [candidate.result, candidate.result]);
      assert.equal((await store.listVersions("lineage")).items.length, 1);
      const lostOwner = "lost-response";
      const lostStore = runtime.createRecoveryStore(db, lostOwner);
      const lostCandidate = await fixture(lostStore, {
        suffix: "lost",
        workspace: { ownerId: lostOwner, workspaceId: lostOwner },
      });
      let batches = 0;
      const interrupted = new Proxy(db, {
        get(target, property) {
          if (property === "batch")
            return async (statements) => {
              batches++;
              await target.batch(statements);
              throw Error("SYNTHETIC_LOST_COMMIT_RESPONSE");
            };
          return typeof target[property] === "function"
            ? target[property].bind(target)
            : target[property];
        },
      });
      assert.deepEqual(
        await runtime
          .createRecoveryStore(interrupted, lostOwner)
          .commitPrepared(lostCandidate),
        lostCandidate.result,
      );
      assert.equal(batches, 1);
      assert.deepEqual(
        await lostStore.findRequest(
          lostCandidate.requestKey,
          lostCandidate.requestDigest,
        ),
        lostCandidate.result,
      );
      assert.equal((await lostStore.listVersions("lineage")).items.length, 1);
      assert.deepEqual((await lostStore.listDueJobs(2000, null)).jobIds, [
        lostCandidate.transactionId,
      ]);
      const prereadOwner = "same-preread";
      const prereadStore = runtime.createRecoveryStore(db, prereadOwner);
      const prereadCandidate = await fixture(prereadStore, {
        suffix: "preread",
        workspace: { ownerId: prereadOwner, workspaceId: prereadOwner },
      });
      assert.deepEqual(
        await runtime
          .createRecoveryStore(
            commitWinnerAfterBindingRead(db, prereadCandidate),
            prereadOwner,
          )
          .commitPrepared(prereadCandidate),
        prereadCandidate.result,
      );
      assert.equal(
        (await prereadStore.listVersions("lineage")).items.length,
        1,
      );
    },
  );
  await checked(
    "replacement inserts cannot bypass immutable history",
    async () => {
      await assert.rejects(
        () =>
          db
            .prepare(
              "INSERT OR REPLACE INTO recovery_versions SELECT * FROM recovery_versions WHERE owner='owner'",
            )
            .run(),
        /RECOVERY_HISTORY_IMMUTABLE/,
      );
    },
  );
  await checked(
    "alternate unique keys cannot replace archived lineages or versions",
    async () => {
      // A history sink must remain immutable when derived heads/projections are
      // absent. Real D1 constraints, not referring rows, must reject replacement.
      await db.batch([
        db.prepare(
          "INSERT INTO recovery_workspaces VALUES('replace-sink','replace-sink')",
        ),
        db.prepare(
          "INSERT INTO recovery_chains VALUES('replace-sink','replace-sink','epoch','0',NULL)",
        ),
        db
          .prepare(
            "INSERT INTO recovery_transactions VALUES('replace-sink','replace-sink','transaction','epoch','1','0',NULL,?,1,'request',?,'{\"versions\":[],\"expectedHeads\":[]}')",
          )
          .bind("a".repeat(64), "b".repeat(64)),
        db.prepare(
          "INSERT INTO recovery_lineages VALUES('replace-sink','replace-sink','lineage','resume','entity')",
        ),
        db
          .prepare(
            "INSERT INTO recovery_versions VALUES('replace-sink','replace-sink','original','lineage','resume','entity','transaction','epoch','1',1,?,'{}')",
          )
          .bind("c".repeat(64)),
        db.prepare(
          "INSERT INTO recovery_lineages VALUES('replace-sink','replace-sink','unreferenced','resume','other-entity')",
        ),
      ]);
      const originals = (
        await db
          .prepare("SELECT * FROM recovery_versions WHERE owner='replace-sink'")
          .all()
      ).results;
      await rejectUnchanged(
        db,
        () =>
          db
            .prepare(
              "INSERT OR REPLACE INTO recovery_versions VALUES('replace-sink','replace-sink','replacement','lineage','resume','entity','transaction','epoch','1',1,?,'{}')",
            )
            .bind("d".repeat(64))
            .run(),
        /RECOVERY_HISTORY_IMMUTABLE/,
      );
      assert.deepEqual(
        (
          await db
            .prepare(
              "SELECT * FROM recovery_versions WHERE owner='replace-sink'",
            )
            .all()
        ).results,
        originals,
      );
      await rejectUnchanged(
        db,
        () =>
          db
            .prepare(
              "INSERT OR REPLACE INTO recovery_lineages VALUES('replace-sink','replace-sink','replacement','resume','other-entity')",
            )
            .run(),
        /RECOVERY_HISTORY_IMMUTABLE/,
      );
    },
  );
  await checked(
    "all ten immutable tables reject rowid aliases and the transaction alternate slot without changing rows",
    async () => {
      for (const [index, fixture] of replacementFixtures.entries()) {
        const owner = `rowid-${index}`;
        const sqlFor = (sql) =>
          sql
            .replaceAll("'owner'", `'${owner}'`)
            .replaceAll("'changed-owner'", `'changed-${owner}'`);
        await db
          .prepare(
            sqlFor(
              "INSERT INTO recovery_workspaces VALUES('owner','workspace')",
            ),
          )
          .run();
        if (fixture.table !== "recovery_workspaces") {
          await db
            .prepare(
              sqlFor(
                "INSERT INTO recovery_chains VALUES('owner','workspace','epoch','0',NULL)",
              ),
            )
            .run();
          await db
            .prepare(
              sqlFor(
                "INSERT INTO recovery_transactions VALUES('owner','workspace','transaction','epoch','1','0',NULL,?,1,'request',?,'{\"versions\":[],\"expectedHeads\":[]}')",
              ),
            )
            .bind("a".repeat(64), "c".repeat(64))
            .run();
        }
        for (const sql of fixture.setup) await db.prepare(sqlFor(sql)).run();
        const original = await db
          .prepare(`SELECT rowid FROM ${fixture.table} WHERE owner=?`)
          .bind(owner)
          .first();
        const before = await recoveryRows(db);
        for (const alias of ["rowid", "_rowid_", "oid"]) {
          await assert.rejects(
            () =>
              db
                .prepare(
                  sqlFor(fixture.replace)
                    .replace("$ROWID", alias)
                    .replace("$RID", String(original.rowid)),
                )
                .run(),
            /RECOVERY_HISTORY_IMMUTABLE/,
          );
          assert.deepEqual(await recoveryRows(db), before);
        }
        await db
          .prepare(
            sqlFor(fixture.replace)
              .replace("$ROWID", "rowid")
              .replace("$RID", String(100000 + index)),
          )
          .run();
        assert.deepEqual(
          (
            await db
              .prepare(`SELECT rowid,* FROM ${fixture.table} WHERE rowid=?`)
              .bind(original.rowid)
              .all()
          ).results,
          before[fixture.table].filter((row) => row.rowid === original.rowid),
        );
      }
      const owner = "transaction-slot";
      await db.batch([
        db
          .prepare("INSERT INTO recovery_workspaces VALUES(?,'workspace')")
          .bind(owner),
        db
          .prepare(
            "INSERT INTO recovery_chains VALUES(?,'workspace','epoch','0',NULL)",
          )
          .bind(owner),
        db
          .prepare(
            "INSERT INTO recovery_transactions VALUES(?,'workspace','original','epoch','1','0',NULL,?,1,'original',?,'{\"versions\":[],\"expectedHeads\":[]}')",
          )
          .bind(owner, "a".repeat(64), "c".repeat(64)),
      ]);
      // Synthetic rebuild of a mutable projection cannot authorize replacing history.
      await db
        .prepare(
          "UPDATE recovery_chains SET sequence='0',transaction_digest=NULL WHERE owner=?",
        )
        .bind(owner)
        .run();
      const before = await recoveryRows(db);
      await assert.rejects(
        () =>
          db
            .prepare(
              "INSERT OR REPLACE INTO recovery_transactions VALUES(?,'workspace','replacement','epoch','1','0',NULL,?,1,'replacement',?,'{\"versions\":[],\"expectedHeads\":[]}')",
            )
            .bind(owner, "b".repeat(64), "d".repeat(64))
            .run(),
        /RECOVERY_HISTORY_IMMUTABLE/,
      );
      assert.deepEqual(await recoveryRows(db), before);
      console.log(
        "Evidence: 30 real-D1 rowid/_rowid_/oid rejections, 10 unused-positive-rowid controls and immutable transaction-slot rejection; full 15-table snapshots unchanged.",
      );
    },
  );
  await checked(
    "a successful zero-row chain update raises a transactional abort",
    async () => {
      await db
        .prepare(
          "CREATE TRIGGER test_ignore_chain_update BEFORE UPDATE ON recovery_chains WHEN OLD.owner='ignored' BEGIN SELECT RAISE(IGNORE); END;",
        )
        .run();
      const isolated = runtime.createRecoveryStore(db, "ignored");
      const candidate = await fixture(isolated, {
        suffix: "zero-row",
        workspace: { ownerId: "ignored", workspaceId: "ignored" },
      });
      await rejectUnchanged(
        db,
        () => isolated.commitPrepared(candidate),
        /RECOVERY_CHAIN_CONFLICT/,
      );
      await assert.rejects(
        () => isolated.getChain(),
        /RECOVERY_WORKSPACE_UNINITIALIZED/,
      );
    },
  );
  await checked(
    "same request/digest returns exactly one original result",
    async () => {
      const before = await counts(db);
      const results = await Promise.all([
        store.commitPrepared(first),
        store.commitPrepared(first),
      ]);
      assert.deepEqual(results, [first.result, first.result]);
      assert.deepEqual(await counts(db), before);
      assert.deepEqual(await store.findRequest(first.requestKey), first.result);
    },
  );
  await checked(
    "same key with conflicting canonical payload is denied",
    async () => {
      const changed = await fixture(store, {
        suffix: "changed",
        requestKey: first.requestKey,
        text: "changed payload",
      });
      await rejectUnchanged(
        db,
        () => store.commitPrepared(changed),
        /IDEMPOTENCY_CONFLICT/,
      );
    },
  );
  await checked(
    "early request lookup rejects a changed canonical digest",
    async () => {
      assert.deepEqual(
        await store.findRequest(first.requestKey, first.requestDigest),
        first.result,
      );
      await assert.rejects(
        () => store.findRequest(first.requestKey, "f".repeat(64)),
        /REQUEST_KEY_CONFLICT/,
      );
    },
  );
  await checked(
    "result digest mismatch cannot acknowledge a fabricated manifest",
    async () => {
      const wrong = await fixture(store, { suffix: "wrong-result-digest" });
      wrong.result.digest = "f".repeat(64);
      await rejectUnchanged(
        db,
        () => store.commitPrepared(wrong),
        /RECOVERY_RESULT_DIGEST_MISMATCH/,
      );
    },
  );
  await checked("stale head aborts all batch writes", async () => {
    const stale = await fixture(store, {
      suffix: "stale-head",
      parentVersionIds: [],
    });
    await rejectUnchanged(
      db,
      () => store.commitPrepared(stale),
      /RECOVERY_HEAD_CONFLICT/,
    );
  });
  await checked(
    "stale workspace comparison aborts all batch writes",
    async () => {
      const stale = await fixture(store, {
        suffix: "stale-chain",
        lineageId: "other",
        entityId: "other",
        sequence: "1",
      });
      await rejectUnchanged(
        db,
        () => store.commitPrepared(stale),
        /RECOVERY_CHAIN_CONFLICT/,
      );
    },
  );
  await checked(
    "wrong owner and workspace cannot read or mutate history",
    async () => {
      const other = runtime.createRecoveryStore(db, "other");
      assert.equal(await other.getVersion(first.result.versionId), null);
      assert.equal(await other.findRequest(first.requestKey), null);
      assert.equal(await other.getPrepared(first.transactionId), null);
      assert.deepEqual((await other.readAudit(null)).items, []);
      await rejectUnchanged(
        db,
        () => other.commitPrepared(first),
        /RECOVERY_OWNER_MISMATCH/,
      );
      const wrong = await fixture(store, {
        suffix: "wrong-workspace",
        workspace: { ownerId: "owner", workspaceId: "other-workspace" },
      });
      await rejectUnchanged(
        db,
        () => store.commitPrepared(wrong),
        /RECOVERY_WORKSPACE_MISMATCH/,
      );
    },
  );
  await checked(
    "different documents compete for one workspace epoch/sequence",
    async () => {
      const a = await fixture(store, {
        suffix: "race-a",
        lineageId: "race-a",
        entityId: "race-a",
      });
      const b = await fixture(store, {
        suffix: "race-b",
        lineageId: "race-b",
        entityId: "race-b",
      });
      const results = await Promise.allSettled([
        store.commitPrepared(a),
        store.commitPrepared(b),
      ]);
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        results.filter((result) => result.status === "rejected").length,
        1,
      );
      assert.match(
        String(results.find((result) => result.status === "rejected").reason),
        /RECOVERY_CHAIN_CONFLICT/,
      );
    },
  );
  await checked(
    "first-commit workspace race creates one immutable binding",
    async () => {
      const fresh = runtime.createRecoveryStore(db, "fresh");
      const a = await fixture(fresh, {
        suffix: "bootstrap-a",
        workspace: { ownerId: "fresh", workspaceId: "a" },
      });
      const b = await fixture(fresh, {
        suffix: "bootstrap-b",
        workspace: { ownerId: "fresh", workspaceId: "b" },
      });
      const before = await counts(db);
      const results = await Promise.allSettled([
        fresh.commitPrepared(a),
        fresh.commitPrepared(b),
      ]);
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        results.filter((result) => result.status === "rejected").length,
        1,
      );
      const after = await counts(db);
      for (const table of [
        "recovery_versions",
        "recovery_request_results",
        "recovery_audit",
        "recovery_outbox",
        "recovery_chains",
        "recovery_workspaces",
      ])
        assert.equal(after[table] - before[table], 1);
    },
  );
  await checked(
    "every atomic statement boundary rolls back the complete save",
    async () => {
      await db
        .prepare(
          "CREATE TABLE recovery_test_failure (value INTEGER CHECK(value=1))",
        )
        .run();
      const candidate = await fixture(store, { suffix: "injected" });
      let batchSize = 0;
      const observing = new Proxy(db, {
        get(target, property) {
          if (property === "batch")
            return async (statements) => {
              batchSize = statements.length;
              throw Error("CAPTURE_BATCH");
            };
          return typeof target[property] === "function"
            ? target[property].bind(target)
            : target[property];
        },
      });
      await assert.rejects(
        () =>
          runtime
            .createRecoveryStore(observing, "owner")
            .commitPrepared(candidate),
        /CAPTURE_BATCH/,
      );
      assert.ok(batchSize >= 7);
      for (let index = 0; index <= batchSize; index++) {
        const failing = new Proxy(db, {
          get(target, property) {
            if (property === "batch")
              return (statements) =>
                target.batch([
                  ...statements.slice(0, index),
                  target.prepare(
                    "INSERT INTO recovery_test_failure(value) VALUES(0)",
                  ),
                  ...statements.slice(index),
                ]);
            return typeof target[property] === "function"
              ? target[property].bind(target)
              : target[property];
          },
        });
        await rejectUnchanged(
          db,
          () =>
            runtime
              .createRecoveryStore(failing, "owner")
              .commitPrepared(candidate),
          /CHECK constraint failed/,
        );
      }
      console.log(
        `Evidence: ${batchSize + 1} real-D1 injected rollback boundaries`,
      );
    },
  );
  await checked("immutable archive rows reject UPDATE and DELETE", async () => {
    for (const table of [
      "recovery_versions",
      "recovery_transactions",
      "recovery_request_results",
      "recovery_audit",
    ]) {
      await assert.rejects(
        () => db.prepare(`UPDATE ${table} SET owner=owner`).run(),
        /RECOVERY_HISTORY_IMMUTABLE/,
      );
      await assert.rejects(
        () => db.prepare(`DELETE FROM ${table}`).run(),
        /RECOVERY_HISTORY_IMMUTABLE/,
      );
    }
  });
  await checked(
    "explicit branch preserves alternate heads and stable entity identity",
    async () => {
      const descendant = await fixture(store, { suffix: "descendant" });
      await store.commitPrepared(descendant);
      const branch = await fixture(store, {
        suffix: "branch",
        parentVersionIds: [first.result.versionId],
        branchRequested: true,
      });
      await store.commitPrepared(branch);
      assert.deepEqual(
        await store.getHeads("lineage"),
        [branch.result.versionId, descendant.result.versionId].sort(),
      );
      assert.equal(
        (
          await db
            .prepare(
              "SELECT version_id FROM recovery_projections WHERE owner='owner' AND lineage_id='lineage'",
            )
            .first()
        ).version_id,
        descendant.result.versionId,
      );
      const wrong = await fixture(store, {
        suffix: "wrong-entity",
        entityId: "changed-entity",
        parentVersionIds: [descendant.result.versionId],
        branchRequested: true,
      });
      await rejectUnchanged(
        db,
        () => store.commitPrepared(wrong),
        /RECOVERY_ENTITY_CONFLICT/,
      );
      const missing = await fixture(store, {
        suffix: "missing-parent",
        parentVersionIds: ["unknown"],
        branchRequested: true,
      });
      await rejectUnchanged(
        db,
        () => store.commitPrepared(missing),
        /RECOVERY_PARENT_CONFLICT/,
      );
    },
  );
  await checked(
    "archiveable source checkpoints and historical receipts remain inert",
    async () => {
      const candidate = await fixture(store, {
        suffix: "events",
        lineageId: "event-lineage",
        entityId: "event-entity",
      });
      candidate.events = [
        "source_checkpoint",
        "external_receipt",
        "approval",
        "request_result",
      ].map((kind) => ({
        ...format,
        workspace: candidate.workspace,
        eventId: `event-${kind}`,
        transactionId: candidate.transactionId,
        epochId: candidate.epochId,
        sequence: candidate.sequence,
        kind,
        body: { historical: true, providerRevision: "revision-7" },
      }));
      const legacyBefore = await db
        .prepare("SELECT count(*) AS n FROM intents")
        .first();
      await store.commitPrepared(candidate);
      assert.equal(
        (
          await db
            .prepare(
              "SELECT count(*) AS n FROM recovery_events WHERE owner='owner'",
            )
            .first()
        ).n,
        4,
      );
      assert.equal(
        (await db.prepare("SELECT count(*) AS n FROM intents").first()).n,
        legacyBefore.n,
      );
      await assert.rejects(
        () => db.prepare("UPDATE recovery_events SET body=body").run(),
        /RECOVERY_HISTORY_IMMUTABLE/,
      );
    },
  );
  await checked(
    "outbox takeover fences renewal and every mutable finalization",
    async () => {
      const jobId = first.transactionId;
      const oldLease = await store.claimJob(jobId, "worker-a", 2000, 100);
      assert.ok(oldLease);
      assert.equal(await store.claimJob(jobId, "worker-b", 2050, 100), null);
      const renewed = await store.renewJob(oldLease, 2050, 100);
      assert.ok(renewed);
      const lease = await store.claimJob(jobId, "worker-b", 2200, 100);
      assert.ok(lease);
      assert.equal(BigInt(lease.fence), BigInt(oldLease.fence) + 1n);
      assert.equal(await store.renewJob(oldLease, 2201, 100), null);
      const result = {
        jobId,
        transactionId: first.transactionId,
        fence: oldLease.fence,
        stage: "replicate",
        status: "completed",
        attempt: oldLease.attempt,
        nextAttemptAt: null,
        errorCategory: null,
      };
      const before = await counts(db);
      assert.equal(
        await store.finishJob(oldLease, result, 2201),
        "stale_fence",
      );
      assert.deepEqual(await counts(db), before);
      const digest = (await store.getChain()).previousTransactionDigest;
      const { signature: ignored, ...firstPayload } = first;
      void ignored;
      const transactionDigest = await runtime.hashEnvelope(
        "transaction",
        firstPayload,
      );
      const receipt = {
        ...format,
        purpose: "receipt",
        workspace: first.workspace,
        epochId: first.epochId,
        sequence: first.sequence,
        transactionDigest,
        inventoryDigest: "c".repeat(64),
        checkpoint: {
          ...format,
          workspace: first.workspace,
          epochId: first.epochId,
          sequence: first.sequence,
          transactionDigest,
          inventoryDigest: "c".repeat(64),
          checkedAt: 2201,
        },
        observations: ["primary", "replica"].map((provider) => ({
          object: {
            provider,
            namespace: "recovery",
            key: first.packageObject.key,
            versionId: null,
          },
          digest: "a".repeat(64),
          sizeBytes: 10,
          verifiedAt: 2201,
        })),
        retentionEvidence: [],
        verifierId: "independent-verifier",
        verifiedAt: 2201,
        signature,
      };
      assert.equal(
        await store.projectProtection(oldLease, receipt, 2201),
        "stale_fence",
      );
      assert.equal(
        (await store.getProtection(first.result.versionId)).replication,
        "protection_pending",
      );
      const expiredCounts = await counts(db);
      assert.equal(
        await store.projectProtection(lease, receipt, 2301),
        "stale_fence",
      );
      assert.deepEqual(await counts(db), expiredCounts);
      assert.equal(
        await store.projectProtection(lease, receipt, 2202),
        "applied",
      );
      assert.equal(
        (await store.getProtection(first.result.versionId)).replication,
        "verified_both",
      );
      const projectionAudit = (await store.readAudit(null)).items.find(
        (event) => event.operation === "recovery.protection",
      );
      assert.equal(projectionAudit.serverTime, 2202);
      const olderReceipt = {
        ...receipt,
        verifiedAt: 2190,
        checkpoint: { ...receipt.checkpoint, checkedAt: 2190 },
        observations: receipt.observations.map((observation) => ({
          ...observation,
          verifiedAt: 2190,
        })),
      };
      await rejectUnchanged(
        db,
        () => store.projectProtection(lease, olderReceipt, 2203),
        /RECOVERY_PROTECTION_REGRESSION/,
      );
      assert.equal(
        (await store.getProtection(first.result.versionId)).lastCheckedAt,
        2201,
      );
      assert.equal(
        await store.finishJob(
          lease,
          { ...result, fence: lease.fence, attempt: lease.attempt },
          2202,
        ),
        "applied",
      );
      assert.ok(digest);
    },
  );
  await checked(
    "501 versions, audit records and due jobs remain discoverable by complete pagination",
    async () => {
      const paging = runtime.createRecoveryStore(db, "paging");
      for (let index = 0; index < 501; index++)
        await paging.commitPrepared(
          await fixture(paging, {
            suffix: `page-${index}`,
            workspace: { ownerId: "paging", workspaceId: "paging" },
          }),
        );
      async function collect(read, key) {
        let cursor = null;
        const items = [];
        let pages = 0;
        do {
          const page = await read(cursor);
          items.push(...page[key]);
          cursor = page.nextCursor;
          pages++;
          assert.ok(pages < 20);
        } while (cursor !== null);
        return items;
      }
      const versions = await collect(
        (cursor) => paging.listVersions("lineage", cursor ?? undefined),
        "items",
      );
      assert.equal(versions.length, 501);
      assert.equal(
        new Set(versions.map((version) => version.versionId)).size,
        501,
      );
      assert.equal(
        (await collect((cursor) => paging.readAudit(cursor), "items")).length,
        501,
      );
      assert.equal(
        (await collect((cursor) => paging.listDueJobs(2000, cursor), "jobIds"))
          .length,
        501,
      );
      await assert.rejects(
        () => paging.listVersions("lineage", "bogus"),
        /INVALID_RECOVERY_CURSOR/,
      );
    },
  );
  await checked(
    "decimal sequences and lease fences stay exact above the safe-number boundary",
    async () => {
      const precise = runtime.createRecoveryStore(db, "precise");
      await precise.commitPrepared(
        await fixture(precise, {
          suffix: "precise-first",
          workspace: { ownerId: "precise", workspaceId: "precise" },
        }),
      );
      // Explicit synthetic checkpoint fixture, not a production restore/cutover.
      await db
        .prepare(
          "UPDATE recovery_chains SET sequence='9007199254740992' WHERE owner='precise'",
        )
        .run();
      const candidate = await fixture(precise, {
        suffix: "precise-next",
        workspace: { ownerId: "precise", workspaceId: "precise" },
      });
      assert.equal(candidate.sequence, "9007199254740993");
      await precise.commitPrepared(candidate);
      assert.equal((await precise.getChain()).sequence, "9007199254740993");
      await assert.rejects(
        () =>
          db
            .prepare(
              "UPDATE recovery_chains SET sequence='09007199254740993' WHERE owner='precise'",
            )
            .run(),
        /CHECK constraint failed/,
      );
      await db
        .prepare(
          "UPDATE recovery_outbox SET fence='9007199254740992' WHERE owner='precise' AND job_id=?",
        )
        .bind(candidate.transactionId)
        .run();
      const lease = await precise.claimJob(
        candidate.transactionId,
        "precise-worker",
        2000,
        100,
      );
      assert.equal(lease.fence, "9007199254740993");
    },
  );
  await checked(
    "retry timing, expired leases, dead letters and stage regressions remain explicit",
    async () => {
      const work = runtime.createRecoveryStore(db, "work");
      const candidate = await fixture(work, {
        suffix: "work",
        workspace: { ownerId: "work", workspaceId: "work" },
      });
      await work.commitPrepared(candidate);
      const lease = await work.claimJob(
        candidate.transactionId,
        "worker",
        2000,
        100,
      );
      const result = {
        jobId: lease.jobId,
        transactionId: lease.transactionId,
        fence: lease.fence,
        stage: "replicate",
        status: "retryable",
        attempt: lease.attempt,
        nextAttemptAt: 2500,
        errorCategory: "PROVIDER_UNAVAILABLE",
      };
      assert.equal(await work.finishJob(lease, result, 2100), "stale_fence");
      assert.equal(await work.renewJob(lease, 2100, 100), null);
      const takeover = await work.claimJob(lease.jobId, "worker", 2100, 1000);
      assert.equal(
        await work.finishJob(
          takeover,
          { ...result, fence: takeover.fence, attempt: takeover.attempt },
          2101,
        ),
        "applied",
      );
      assert.deepEqual((await work.listDueJobs(2499, null)).jobIds, []);
      assert.deepEqual((await work.listDueJobs(2500, null)).jobIds, [
        lease.jobId,
      ]);
      const retry = await work.claimJob(lease.jobId, "worker", 2500, 100);
      await assert.rejects(
        () =>
          work.finishJob(
            retry,
            {
              ...result,
              fence: retry.fence,
              attempt: retry.attempt,
              stage: "primary_journal",
            },
            2501,
          ),
        /RECOVERY_JOB_STAGE_REGRESSION/,
      );
      assert.equal(
        await work.finishJob(
          retry,
          {
            ...result,
            fence: retry.fence,
            attempt: retry.attempt,
            status: "dead_letter",
            nextAttemptAt: null,
          },
          2501,
        ),
        "applied",
      );
      assert.deepEqual((await work.listDueJobs(10000, null)).jobIds, []);
      assert.equal(
        await work.claimJob(lease.jobId, "worker", 10000, 100),
        null,
      );
      assert.equal(
        (await work.getProtection(candidate.result.versionId)).replication,
        "protection_pending",
      );
    },
  );
  await checked(
    "failed ordered migration rolls back schema, baseline capture and ledger together",
    async () => {
      const migrationDb = await mf.getD1Database("MIGRATION_FAILURE");
      await applyMigrations(migrationDb, { through: "0001.sql" });
      await migrationDb
        .prepare(
          "INSERT INTO records VALUES('legacy','claim','claim','{\"text\":\"preserved\"}',1,100)",
        )
        .run();
      await migrationDb
        .prepare("CREATE TABLE migration_failure(value INTEGER CHECK(value=1))")
        .run();
      const before = (await migrationDb.prepare("SELECT * FROM records").all())
        .results;
      const failing = new Proxy(migrationDb, {
        get(target, property) {
          if (property === "batch")
            return (statements) =>
              target.batch([
                ...statements.slice(0, -1),
                target.prepare("INSERT INTO migration_failure VALUES(0)"),
                statements.at(-1),
              ]);
          return typeof target[property] === "function"
            ? target[property].bind(target)
            : target[property];
        },
      });
      await assert.rejects(
        () => applyMigrations(failing),
        /CHECK constraint failed/,
      );
      assert.deepEqual(
        (await migrationDb.prepare("SELECT * FROM records").all()).results,
        before,
      );
      assert.deepEqual(
        (
          await migrationDb
            .prepare("SELECT name FROM runtime_migrations ORDER BY name")
            .all()
        ).results,
        [{ name: "0001.sql" }],
      );
      assert.equal(
        (
          await migrationDb
            .prepare(
              "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'recovery_%'",
            )
            .first()
        ).n,
        0,
      );
      await applyMigrations(migrationDb);
      assert.equal(
        (
          await migrationDb
            .prepare("SELECT count(*) AS n FROM recovery_import_baselines")
            .first()
        ).n,
        1,
      );
    },
  );
  await checked(
    "populated 0001 upgrade preserves bodies, revisions, approvals and artifact uncertainty",
    async () => {
      const upgrade = await mf.getD1Database("UPGRADE");
      const originals = await mf.getR2Bucket("UPGRADE_ARTIFACTS");
      assert.equal(await originals.get("old/original.pdf"), null);
      await applyMigrations(upgrade, { through: "0001.sql" });
      await upgrade.batch([
        upgrade.prepare(
          "INSERT INTO records VALUES('legacy','claim','claim','{\"status\":\"user_confirmed\",\"text\":\"original\"}',7,123)",
        ),
        upgrade.prepare(
          "INSERT INTO records VALUES('legacy','artifact','artifact','{\"r2Key\":\"old/original.pdf\",\"digest\":\"unverified\"}',3,124)",
        ),
        upgrade.prepare(
          "INSERT INTO records VALUES('legacy','settings','settings','{\"sendingEnabled\":true}',2,125)",
        ),
        upgrade.prepare(
          "INSERT INTO source_keys VALUES('legacy','provider-old','opportunity-old')",
        ),
        upgrade.prepare(
          "INSERT INTO intents(owner,id,kind,digest,payload,state,receipt,created_at,updated_at) VALUES('legacy','sent','send','digest','{}','succeeded','historical receipt',1,2)",
        ),
      ]);
      const before = (
        await upgrade
          .prepare("SELECT * FROM records ORDER BY owner,kind,id")
          .all()
      ).results;
      await applyMigrations(upgrade);
      assert.deepEqual(
        (
          await upgrade
            .prepare("SELECT * FROM records ORDER BY owner,kind,id")
            .all()
        ).results,
        before,
      );
      const candidates = (
        await upgrade
          .prepare(
            "SELECT * FROM recovery_import_baselines ORDER BY source_table,source_id",
          )
          .all()
      ).results;
      assert.ok(candidates.length >= 5);
      assert.ok(
        candidates.every(
          (candidate) =>
            candidate.provenance === "imported_legacy_baseline" &&
            candidate.archive_state === "pending",
        ),
      );
      assert.equal(
        candidates.find((candidate) => candidate.source_id === "artifact")
          .artifact_availability,
        "unobserved",
      );
      assert.equal(
        (
          await upgrade
            .prepare("SELECT count(*) AS n FROM recovery_versions")
            .first()
        ).n,
        0,
      );
      assert.equal(
        (
          await upgrade
            .prepare("SELECT state,receipt FROM intents WHERE id='sent'")
            .first()
        ).state,
        "succeeded",
      );
      await applyMigrations(upgrade);
      assert.equal(
        (
          await upgrade
            .prepare("SELECT count(*) AS n FROM recovery_import_baselines")
            .first()
        ).n,
        candidates.length,
      );
      assert.equal(await originals.get("old/original.pdf"), null);
      const upgradedStore = runtime.createRecoveryStore(upgrade, "legacy");
      const newSave = await fixture(upgradedStore, {
        suffix: "post-upgrade",
        workspace: { ownerId: "legacy", workspaceId: "legacy" },
      });
      assert.deepEqual(
        await upgradedStore.commitPrepared(newSave),
        newSave.result,
      );
      await rejectUnchanged(
        upgrade,
        () =>
          upgradedStore.commitPrepared({
            ...newSave,
            requestKey: "stale-upgrade",
            transactionId: "stale-upgrade",
            versions: newSave.versions.map((version) => ({
              ...version,
              transactionId: "stale-upgrade",
              versionId: "stale-upgrade",
            })),
            result: {
              ...newSave.result,
              transactionId: "stale-upgrade",
              versionId: "stale-upgrade",
            },
          }),
        /RECOVERY_RESULT_DIGEST_MISMATCH/,
      );
      assert.deepEqual(
        (
          await upgrade
            .prepare("SELECT * FROM records ORDER BY owner,kind,id")
            .all()
        ).results,
        before,
      );
      assert.equal(
        (
          await upgrade
            .prepare("SELECT count(*) AS n FROM recovery_import_baselines")
            .first()
        ).n,
        candidates.length,
      );
    },
  );
  console.log(
    `PASS: ${checks} recovery integration checks against real Miniflare D1. No provider calls.`,
  );
} finally {
  await mf.dispose();
}
