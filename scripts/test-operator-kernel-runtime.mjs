process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync } from "node:fs";
import { kernel, fixture } from "./test-operator-kernel.mjs";
import { applyMigrations } from "./runtime-migrations.mjs";
const options = {
  cf: false,
  modules: true,
  script:
    "export default {fetch(){return new Response('local synthetic',{status:404});}}",
  compatibilityDate: "2026-10-06",
  d1Databases: ["DB", "ROLLBACK", "STOP", "LATE"],
  r2Buckets: ["ORIGINALS"],
};
const forbiddenTables = [
  "recovery_versions",
  "recovery_lineages",
  "intents",
  "approvals",
];
async function absent(db) {
  for (const table of forbiddenTables) {
    const exists = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .bind(table)
      .first();
    if (exists)
      assert.equal(
        (await db.prepare("SELECT count(*) AS n FROM " + table).first()).n,
        0,
        table,
      );
  }
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) AS n FROM recovery_import_baselines WHERE source_kind='pending_action'",
        )
        .first()
    ).n,
    0,
  );
}
function wrap(
  db,
  {
    clockFinal = null,
    onBatch = async (statements) => db.batch(statements),
    counts = { requests: 0, sql: 0 },
    events = [],
  } = {},
) {
  return {
    prepare(sql) {
      if (
        clockFinal !== null &&
        sql.endsWith("ELSE 1 END AS permitted FROM clock") &&
        !sql.includes("EXISTS(")
      )
        sql = sql.replace(kernel.PENDING_CLOCK_SQL, String(clockFinal));
      const create = (params) => {
        const statement = db.prepare(sql).bind(...params);
        return {
          bind: (...next) => create(next),
          first: async (...args) => {
            counts.requests++;
            counts.sql++;
            return statement.first(...args);
          },
          all: async (...args) => {
            counts.requests++;
            counts.sql++;
            return statement.all(...args);
          },
          _statement: statement,
        };
      };
      return create([]);
    },
    async batch(statements) {
      counts.requests++;
      counts.sql += statements.length;
      events.push("d1-batch");
      return onBatch(statements.map((s) => s._statement));
    },
  };
}
test(
  "real Workerd kernel: final SQL guard rollback, in-flight stop ownership, retained-only read and all 154 published reader roles",
  { timeout: 90000 },
  async (t) => {
    const mf = new Miniflare(convertV4MiniflareOptions(options));
    t.after(() => mf.dispose());
    const { plan, profile, sources } = fixture();
    assert.equal(plan.records.length, 154);
    assert.equal(sources.length, 5);
    assert.equal(Object.hasOwn(options, "queueProducers"), false);
    assert.equal(Object.hasOwn(options, "JOBS"), false);
    const bucket = await mf.getR2Bucket("ORIGINALS");
    for (const source of sources) await bucket.put(source.name, source.bytes);
    const events = [],
      counts = { requests: 0, sql: 0 };
    let copies = 0;
    const readOriginalCopy = async (name) => {
      const object = await bucket.get(name);
      copies++;
      events.push("r2-read");
      return new Uint8Array(await object.arrayBuffer());
    };
    const raw = await mf.getD1Database("DB");
    await applyMigrations(raw);
    const window = Object.freeze({
        nowMs: Date.now() - 1000,
        expiresAtMs: Date.now() + 60000,
      }),
      ports = {
        db: wrap(raw, { counts, events }),
        currentWorkspace: async () => plan.workspace,
        readOriginalCopy,
        window,
        current: async () => {
          assert.ok(Date.now() < window.expiresAtMs);
        },
      };
    const result = await kernel.observeOperatorPending(ports, plan, profile);
    assert.deepEqual(result.receipt, plan.receipt);
    assert.equal(result.stageReceipt, null);
    assert.equal(result.receipt.status, "legacy_imported_archive_pending");
    assert.equal(
      events.slice(0, events.indexOf("d1-batch")).filter((e) => e === "r2-read")
        .length,
      5,
    );
    await absent(raw);
    const importCounts = { ...counts, originalReadbacks: copies };
    const readCounts = { requests: 0, sql: 0 },
      reads = kernel.createRecordReads(
        wrap(raw, { counts: readCounts }),
        plan.workspace.ownerId,
        plan.workspace.workspaceId,
        profile,
      );
    const items = [];
    let cursor = null,
      pages = 0;
    do {
      const page = await reads.records({
        workspaceId: plan.workspace.workspaceId,
        kind: "opportunity",
        cursor,
      });
      pages++;
      items.push(...page.items);
      cursor = page.nextCursor;
      assert.ok(pages <= 154);
    } while (cursor !== null);
    assert.equal(items.length, 154);
    assert.equal(new Set(items.map((i) => i.entityId)).size, 154);
    for (const item of items) {
      assert.equal(item.history, "legacy_unversioned");
      assert.equal(item.origin, "legacy_import");
    }
    const detail = await reads.records({
      workspaceId: plan.workspace.workspaceId,
      kind: "opportunity",
      entityId: plan.records.find((r) => r.body.source.sourceId === "FXD003")
        .id,
    });
    assert.equal(detail.record.provenance.sourceReceipts.length, 5);
    assert.equal(detail.record.body.display.status, "pending");
    await absent(raw);
    const rollback = await mf.getD1Database("ROLLBACK");
    await applyMigrations(rollback);
    const finalWindow = Object.freeze({
      nowMs: Date.now() - 1000,
      expiresAtMs: Date.now() + 60000,
    });
    let failedBatch;
    const rollbackPort = wrap(rollback, {
      clockFinal: finalWindow.expiresAtMs,
      onBatch: async (statements) => {
        failedBatch = statements;
        return rollback.batch(statements);
      },
    });
    await assert.rejects(
      kernel.observeOperatorPending(
        { ...ports, db: rollbackPort, window: finalWindow },
        plan,
        profile,
      ),
      /malformed JSON|D1_ERROR/,
    );
    assert.equal(
      failedBatch.length,
      2 * kernel.pendingChunks(plan).chunks.length + sources.length + 3,
    );
    assert.equal(
      (await rollback.prepare("SELECT count(*) AS n FROM records").first()).n,
      0,
    );
    assert.equal(
      (
        await rollback
          .prepare("SELECT count(*) AS n FROM recovery_import_baselines")
          .first()
      ).n,
      0,
    );
    await absent(rollback);
    // Actual D1 batch runs to settlement after stop; cancellation must not be described as rollback.
    const stop = await mf.getD1Database("STOP");
    await applyMigrations(stop);
    let current = true,
      settled = false,
      dispatch = 0;
    const stoppedPort = wrap(stop, {
      onBatch: async (statements) => {
        dispatch++;
        current = false;
        const value = await stop.batch(statements);
        settled = true;
        return value;
      },
    });
    await assert.rejects(
      kernel.observeOperatorPending(
        {
          ...ports,
          db: stoppedPort,
          current: async () => {
            if (!current) throw Error("operator-stopped");
          },
        },
        plan,
        profile,
      ),
      /operator-stopped/,
    );
    assert.equal(dispatch, 1);
    assert.equal(settled, true);
    assert.equal(
      (await stop.prepare("SELECT count(*) AS n FROM records").first()).n,
      154,
    );
    await absent(stop);
    let readOnlyCalls = 0;
    const readOnly = wrap(stop, {
      onBatch: async () => {
        throw Error("read-only-must-not-write");
      },
    });
    const retained = await kernel.observeOperatorPending(
      {
        ...ports,
        db: readOnly,
        resultOnly: true,
        window: Object.freeze({
          nowMs: Date.now() - 1000,
          expiresAtMs: Date.now() + 60000,
        }),
        current: async () => {
          readOnlyCalls++;
        },
      },
      plan,
      profile,
    );
    assert.deepEqual(retained.receipt, result.receipt);
    assert.ok(readOnlyCalls > 0);
    assert.equal(dispatch, 1);
    const late = await mf.getD1Database("LATE");
    await applyMigrations(late);
    let expired = false,
      lateSettled = false;
    const latePort = wrap(late, {
      onBatch: async (statements) => {
        const value = await late.batch(statements);
        expired = true;
        lateSettled = true;
        return value;
      },
    });
    await assert.rejects(
      kernel.observeOperatorPending(
        {
          ...ports,
          db: latePort,
          current: async () => {
            if (expired) throw Error("operator-expired");
          },
        },
        plan,
        profile,
      ),
      /operator-expired/,
    );
    assert.equal(lateSettled, true);
    assert.equal(
      (await late.prepare("SELECT count(*) AS n FROM records").first()).n,
      154,
    );
    console.log(
      JSON.stringify({
        qualification: "LOCAL_WORKERD_ONLY_REST_UNQUALIFIED",
        roles: 154,
        sources: 5,
        importCounts,
        pages,
        readCounts,
        readDetailIncluded: true,
        finalClock:
          "deterministic test-only last SQL sample equals deadline; genuine Workerd batch/guard rollback",
        queueBindings: 0,
        providerCalls: 0,
        serviceCallbacks:
          "not instrumented by this direct published reader fixture",
      }),
    );
  },
);

test("general raw-copy API cannot select complete-read evidence by DTO fields", async () => {
  const { plan, profile } = fixture();
  const source = plan.sources[0];
  const evidence = {
    format: "job-stack.remote-original-read.v1",
    complete: true,
    literalBytesEqual: true,
    sizeBytes: source.sizeBytes,
    sha256: source.rawSha256,
  };
  let calls = 0;
  const ports = {
    currentWorkspace: async () => plan.workspace,
    readOriginalCopy: async () => evidence,
    originalReads: {
      kind: "operator-complete-read.v1",
      read: async () => evidence,
    },
    db: {
      prepare() {
        calls++;
        throw Error("unexpected-d1");
      },
    },
  };
  await assert.rejects(
    kernel.observeAuditedPending(ports, plan, profile),
    /AUDIT_ORIGINAL_READBACK/,
  );
  await assert.rejects(
    kernel.observeOperatorPending(
      {
        ...ports,
        current: async () => {},
        window: Object.freeze({ nowMs: 1, expiresAtMs: 100000 }),
      },
      plan,
      profile,
    ),
    /AUDIT_ORIGINAL_READBACK/,
  );
  assert.equal(calls, 0);
});

test(
  "real D1/R2 parent-child complete-read integration retains raw custody and gates final proof",
  { timeout: 90000 },
  async (t) => {
    const { build } = await import("esbuild");
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { pathToFileURL } = await import("node:url");
    const path = await import("node:path");
    const output = await build({
      stdin: {
        contents:
          "export * from './src/operator/import'; export * from './src/operator/protocol';",
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
    });
    await mkdir("artifacts/operator", { recursive: true });
    const file = path.resolve("artifacts/operator/complete-read-kernel.mjs");
    await writeFile(file, output.outputFiles[0].text);
    const operator = await import(pathToFileURL(file));
    const mf = new Miniflare(
      convertV4MiniflareOptions({ ...options, d1Databases: ["DB"] }),
    );
    t.after(() => mf.dispose());
    const db = await mf.getD1Database("DB"),
      bucket = await mf.getR2Bucket("ORIGINALS");
    await applyMigrations(db);
    const { plan, profile } = fixture();
    const approval = {
      format: "job-stack.operator-approval.v1",
      mode: "import",
      actionId: "synthetic-real-complete-read",
      accountId: "a".repeat(32),
      databaseId: "00000000-0000-4000-8000-000000000001",
      bucket: "synthetic-originals",
      namespace: "synthetic/",
      namespaceExclusive: true,
      window: Object.freeze({
        nowMs: Date.now() - 1000,
        expiresAtMs: Date.now() + 60000,
      }),
      sourceClosureSha256: "b".repeat(64),
      profileSha256: operator.sha256(JSON.stringify(profile)),
      planSha256: operator.sha256(JSON.stringify(plan)),
      sources: plan.sources.map((source, index) => ({
        name: source.name,
        key: `synthetic/${index}.json`,
        sizeBytes: source.sizeBytes,
        sha256: source.rawSha256,
      })),
    };
    const prepared = operator.prepareOperatorInput({ plan, profile, approval });
    let physicalCalls = 0,
      acknowledged = 0;
    const dispatch = async (args, effect) =>
      new Function("cloudflare", "fetch", `return (${args.code})();`)(
        {
          request: async (request) => {
            physicalCalls++;
            if (request.method === "PUT") {
              assert.equal(request.rawBody, true);
              assert.equal(request.contentType, "application/json");
              assert.ok(request.body instanceof Uint8Array);
              await bucket.put(effect.payload.key, request.body);
              return { success: true, result: null };
            }
            assert.equal(request.method, "POST");
            const statements = request.body.batch.map(({ sql, params }) =>
              db.prepare(sql).bind(...params),
            );
            return { success: true, result: await db.batch(statements) };
          },
        },
        async (url, init) => {
          physicalCalls++;
          assert.equal(init.redirect, "manual");
          assert.equal(
            url,
            `https://api.cloudflare.com/client/v4/accounts/${approval.accountId}/r2/buckets/${approval.bucket}/objects/${effect.payload.key}`,
          );
          const object = await bucket.get(effect.payload.key);
          return object
            ? new Response(object.body)
            : new Response(
                JSON.stringify({
                  success: false,
                  result: null,
                  errors: [{ code: 10007, message: "Synthetic absent" }],
                  messages: [],
                }),
                { status: 404 },
              );
        },
      );
    const broker = operator.createParentBroker(prepared, {
      current: async () => {},
      dispatch,
    });
    const result = await operator.runOperatorImport(prepared, (text) =>
      broker.accept(text),
    );
    await broker.finish();
    acknowledged++;
    assert.deepEqual(result.receipt, plan.receipt);
    assert.equal(physicalCalls, broker.state().requests);
    assert.equal(broker.state().r2, 25);
    assert.equal(acknowledged, 1);
    for (const source of approval.sources) {
      const object = await bucket.get(source.key);
      const actual = new Uint8Array(await object.arrayBuffer());
      assert.equal(operator.sha256(actual), source.sha256);
      assert.equal(actual.length, source.sizeBytes);
    }
    await absent(db);
    const reconciled = operator.prepareOperatorInput({
      plan,
      profile,
      approval: {
        ...approval,
        mode: "reconcile",
        actionId: "synthetic-real-reconcile",
        window: Object.freeze({ ...approval.window }),
      },
    });
    let get = 0;
    const bad = operator.createParentBroker(reconciled, {
      current: async () => {},
      dispatch: async (args, effect) => {
        if (effect.kind === "r2.get" && ++get === 6) {
          return new Function("fetch", `return (${args.code})();`)(
            async () => new Response("bad-final-read"),
          );
        }
        assert.notEqual(effect.kind, "d1.batch");
        assert.notEqual(effect.kind, "r2.put");
        return dispatch(args, effect);
      },
    });
    await assert.rejects(
      operator.runOperatorImport(reconciled, (text) => bad.accept(text)),
    );
    assert.equal(get, 6);
    assert.equal(bad.state().completed, false);
    assert.equal(acknowledged, 1);
  },
);
