process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
import test from "node:test";
import { emittedRead } from "./operator-complete-read-fixtures.mjs";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
const output = (
  await build({
    stdin: {
      contents:
        "export * from './src/operator/protocol';export * from './src/operator/import';export {createPipeExchange} from './src/operator/stdio';export {fixtureProfile,fixtureSupplementedInputs} from './tests/fixtures/audited-profile-inputs';export {planAuditedImport} from './src/application/audited-legacy-import';export {parseAuditedSourceProfile} from './src/application/audited-source-profile';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  })
).outputFiles[0].text;
await mkdir("artifacts/operator", { recursive: true });
const file = path.resolve("artifacts/operator/broker-" + Date.now() + ".mjs");
await writeFile(file, output);
const m = await import(pathToFileURL(file));
function prepared(mode = "import", extra = {}) {
  const profile = m.parseAuditedSourceProfile(m.fixtureProfile),
    sources = m.fixtureSupplementedInputs(),
    plan = m.planAuditedImport(
      {
        sources,
        workspace: profile.workspace,
        seriesId: profile.seriesId,
        observedAt: 1000,
      },
      profile,
    ),
    window = Object.freeze({ nowMs: 100, expiresAtMs: 100000 });
  const approval = {
    format: "job-stack.operator-approval.v1",
    mode,
    actionId: "synthetic-action" + (mode === "reconcile" ? "-read" : ""),
    accountId: "a".repeat(32),
    databaseId: "00000000-0000-4000-8000-000000000001",
    bucket: "synthetic-originals",
    namespace: "synthetic-manifest/",
    namespaceExclusive: true,
    window,
    sourceClosureSha256: "b".repeat(64),
    profileSha256: m.sha256(JSON.stringify(profile)),
    planSha256: m.sha256(JSON.stringify(plan)),
    sources: plan.sources.map((s, i) => ({
      name: s.name,
      key: "synthetic-manifest/" + i + ".json",
      sha256: s.rawSha256,
      sizeBytes: s.sizeBytes,
    })),
    ...extra,
  };
  return m.prepareOperatorInput({ plan, profile, approval });
}
const broker = (p, dispatch = async () => null) =>
  m.createParentBroker(p, {
    current: async () => {},
    dispatch,
    now: () => 1000,
  });
test("parent compares complete source-owned SQL/params and targets before dispatch", async () => {
  for (const changed of ["sql", "params", "target"]) {
    const p = prepared(),
      b = broker(p, async () => {
        throw Error("dispatch-must-be-zero");
      }),
      effect = structuredClone(p.effects.header);
    if (changed === "sql") effect.payload.statements[0].sql += " ";
    if (changed === "params")
      effect.payload.statements[0].params[0] = "foreign";
    if (changed === "target") effect.payload.databaseId = "foreign";
    await assert.rejects(
      b.accept(m.stable(m.requestFrame(effect, 1, p.actionDigest))),
    );
    assert.equal(b.state().requests, 0);
  }
});
test("duplicate, extra, reordered, missing and trailing frames stop sticky; response identity cannot cross-bind", async () => {
  const p = prepared(),
    b = broker(p);
  const frame = m.requestFrame(
      { kind: "current", payload: {} },
      1,
      p.actionDigest,
    ),
    text = m.stable(frame);
  await b.accept(text);
  await assert.rejects(b.accept(text));
  assert.equal(b.state().stopped, true);
  await assert.rejects(
    b.accept(
      m.stable(
        m.requestFrame({ kind: "current", payload: {} }, 2, p.actionDigest),
      ),
    ),
  );
  for (const effect of [
    { ...frame, extra: 1 },
    { ...frame, sequence: 2 },
  ])
    await assert.rejects(broker(p).accept(m.stable(effect)));
  await assert.rejects(broker(p).finish());
  const response = {
    protocol: m.PROTOCOL,
    sequence: 1,
    actionDigest: p.actionDigest,
    requestDigest: frame.requestDigest,
    ok: true,
    result: null,
  };
  assert.throws(() =>
    m.checkedResponse(m.stable({ ...response, sequence: 2 }), frame),
  );
  assert.throws(() => m.parseRequest('{"sequence":1,' + text.slice(1)));
});
test("immutable window, namespace exclusivity and complete escaped envelopes are checked before upload", () => {
  assert.throws(() => prepared("import", { namespaceExclusive: false }));
  assert.throws(() =>
    prepared("import", { window: { nowMs: 100, expiresAtMs: 100000 } }),
  );
  const p = prepared();
  assert.ok(
    p.envelopes.every(
      (e) =>
        e.codeBytes <= m.OPERATOR_LIMITS.code &&
        e.argumentBytes <= m.OPERATOR_LIMITS.toolArgs &&
        e.requestBytes <= m.OPERATOR_LIMITS.request,
    ),
  );
  assert.ok(p.batchBytes <= m.OPERATOR_LIMITS.batch);
});
test("stop while actual dispatch remains unresolved retains ownership and denies positive acknowledgement", async () => {
  const p = prepared();
  let release;
  const waiting = new Promise((resolve) => (release = resolve));
  const b = broker(p, async () => waiting),
    frame = m.requestFrame(p.effects.custody[0].get, 1, p.actionDigest);
  const work = b.accept(m.stable(frame));
  await new Promise((r) => setImmediate(r));
  assert.equal(b.state().inFlight, true);
  b.stop();
  assert.equal(b.state().inFlight, true);
  await assert.rejects(
    b.accept(
      m.stable(
        m.requestFrame({ kind: "current", payload: {} }, 2, p.actionDigest),
      ),
    ),
  );
  release(null);
  await assert.rejects(work);
  assert.equal(b.state().inFlight, false);
  assert.equal(b.state().requests, 1);
  assert.equal(b.state().stopped, true);
});
test("source conflict never uploads and reconciliation uses distinct current identity and cannot batch", async () => {
  const p = prepared(),
    b = broker(p, async () => ({
      base64: Buffer.from("different").toString("base64"),
    }));
  await assert.rejects(
    b.accept(
      m.stable(m.requestFrame(p.effects.custody[0].get, 1, p.actionDigest)),
    ),
  );
  assert.equal(b.state().requests, 1);
  const read = prepared("reconcile");
  assert.notEqual(read.actionDigest, p.actionDigest);
  const rb = broker(read);
  await assert.rejects(
    rb.accept(m.stable(m.requestFrame(p.effects.batch, 1, read.actionDigest))),
  );
  assert.equal(rb.state().requests, 0);
});
test("fragment count, empty count, stall and aggregate bounds reject sticky", () => {
  let now = 100;
  const reserve = (n) => assert.ok(n <= m.OPERATOR_LIMITS.aggregate);
  let f = m.createFrameReader({ deadline: 100000, now: () => now, reserve });
  assert.throws(() => f.push(new Uint8Array(m.OPERATOR_LIMITS.fragment + 1)));
  assert.throws(() => f.finish());
  f = m.createFrameReader({ deadline: 100000, now: () => now, reserve });
  for (let i = 0; i < 32; i++) f.push(new Uint8Array());
  assert.throws(() => f.push(new Uint8Array()));
  f = m.createFrameReader({ deadline: 100000, now: () => now, reserve });
  for (let i = 0; i < 256; i++) f.push(Uint8Array.of(32));
  assert.throws(() => f.push(Uint8Array.of(32)));
  f = m.createFrameReader({ deadline: 100000, now: () => now, reserve });
  now += 30000;
  assert.throws(() => f.check());
});
function syntheticProvider(p) {
  const objects = new Map();
  let committed = false;
  const plan = p.plan,
    owner = plan.workspace.ownerId,
    fixed = {
      provenance: "imported_legacy_baseline",
      artifact_availability: "not_applicable",
      archive_state: "pending",
      schema_version: 1,
    };
  const baseline = (
    kind,
    id,
    text,
    table = "audited_json",
    revision = null,
  ) => ({
    owner,
    source_table: table,
    source_kind: kind,
    source_id: id,
    source_revision: revision,
    source_snapshot: text,
    ...fixed,
  });
  return async (args, effect) => {
    const payload = effect.payload;
    if (effect.kind === "r2.get")
      return emittedRead(
        args,
        objects.has(payload.key)
          ? Buffer.from(objects.get(payload.key), "base64")
          : null,
        { now: () => p.approval.window.nowMs + 1 },
      );
    if (effect.kind === "r2.put") {
      objects.set(payload.key, payload.base64);
      return { written: true };
    }
    if (effect.kind === "d1.batch") {
      committed = true;
      return { statements: payload.statements.length };
    }
    const sql = payload.statements[0].sql;
    if (sql === p.effects.header.payload.statements[0].sql)
      return {
        rows: [
          {
            ...(committed
              ? baseline(
                  "import_receipt",
                  plan.seriesId,
                  JSON.stringify(plan.receipt),
                )
              : { source_snapshot: null }),
            p_snapshot: null,
            stage_count: 0,
            canonical_count: 0,
            record_count: committed ? plan.records.length : 0,
            baseline_count: committed ? plan.records.length : 0,
            source_count: committed ? plan.sources.length : 0,
          },
        ],
      };
    if (sql === p.effects.sources.payload.statements[0].sql)
      return {
        rows: plan.sources.map((s) =>
          baseline("raw_input", s.rawSha256, JSON.stringify(s)),
        ),
      };
    if (sql === p.effects.clock.payload.statements[0].sql)
      return { rows: [{ observed: 1000 }] };
    const ids = JSON.parse(payload.statements[0].params[1]);
    return {
      rows: plan.records
        .filter((r) => ids.includes(r.id))
        .map((r) => ({
          owner,
          kind: "opportunity",
          id: r.id,
          body: JSON.stringify(r.body),
          revision: 1,
          updated_at: r.updatedAt,
          b_owner: owner,
          ...baseline(
            "opportunity",
            r.id,
            JSON.stringify({
              body: r.body,
              revision: "1",
              updatedAt: r.updatedAt,
            }),
            "records",
            "1",
          ),
        })),
    };
  };
}
test("complete synthetic parent/child protocol uses exact kernel program and bounded management counts", async () => {
  const p = prepared(),
    provider = syntheticProvider(p),
    b = broker(p, provider);
  const result = await m.runOperatorImport(p, (text) => b.accept(text));
  assert.deepEqual(result.receipt, p.plan.receipt);
  await b.finish();
  assert.equal(b.state().completed, true);
  assert.equal(b.state().d1, 8);
  assert.equal(b.state().r2, 25);
  assert.equal(b.state().sql, 21);
  assert.ok(b.state().sequence <= 128);
  await assert.rejects(
    b.accept(
      m.stable(
        m.requestFrame(
          { kind: "current", payload: {} },
          b.state().sequence + 1,
          p.actionDigest,
        ),
      ),
    ),
  );
});
test("same-labelled valid-position atomic SQL, params and target alterations each have zero additional dispatch", async () => {
  for (const changed of ["sql", "params", "target"]) {
    const p = prepared(),
      provider = syntheticProvider(p);
    let calls = 0;
    const b = broker(p, async (args, effect) => {
      calls++;
      return provider(args, effect);
    });
    let attacked = false;
    await assert.rejects(
      m.runOperatorImport(p, async (text) => {
        const frame = JSON.parse(text);
        if (frame.kind === "d1.batch") {
          attacked = true;
          const before = calls;
          if (changed === "sql") frame.payload.statements[0].sql += " ";
          if (changed === "params") frame.payload.statements[0].params[0]++;
          if (changed === "target")
            frame.payload.databaseId = "00000000-0000-4000-8000-000000000002";
          const altered = m.requestFrame(
            { kind: frame.kind, payload: frame.payload },
            frame.sequence,
            frame.actionDigest,
          );
          try {
            return await b.accept(m.stable(altered));
          } finally {
            assert.equal(calls, before);
          }
        }
        return b.accept(text);
      }),
    );
    assert.equal(attacked, true);
    assert.equal(b.state().stopped, true);
  }
});
test("concurrent frame admission during asynchronous authority check cannot dispatch twice", async () => {
  const p = prepared();
  let release;
  const hold = new Promise((r) => (release = r));
  let calls = 0;
  const b = m.createParentBroker(p, {
      now: () => 1000,
      current: async () => hold,
      dispatch: async () => {
        calls++;
        return null;
      },
    }),
    a = b.accept(
      m.stable(m.requestFrame(p.effects.custody[0].get, 1, p.actionDigest)),
    );
  const second = b.accept(
    m.stable(m.requestFrame(p.effects.custody[0].get, 2, p.actionDigest)),
  );
  release();
  await assert.rejects(second);
  await assert.rejects(a);
  assert.equal(calls, 0);
});
test("actual credential-free subprocess completes a synthetic run through the parent validator", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const p = prepared("import", {
      window: Object.freeze({
        nowMs: Date.now() - 1000,
        expiresAtMs: Date.now() + 60000,
      }),
    }),
    dir = await mkdtemp(path.join(tmpdir(), "job-stack-operator-synthetic-"));
  const files = ["plan.json", "profile.json", "approval.json"].map((f) =>
    path.join(dir, f),
  );
  await Promise.all(
    [p.plan, p.profile, p.approval].map((v, i) =>
      writeFile(files[i], JSON.stringify(v)),
    ),
  );
  const child = spawn(
    process.execPath,
    ["scripts/run-operator.mjs", ...files],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, CLOUDFLARE_CF_FETCH_ENABLED: "false" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const b = m.createParentBroker(p, {
    current: async () => {},
    dispatch: syntheticProvider(p),
  });
  let errors = "",
    buffer = Buffer.alloc(0);
  child.stderr.on("data", (v) => {
    assert.ok(errors.length + v.length < 4096);
    errors += v.toString();
  });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const timeout = setTimeout(() => {
    b.stop();
    child.kill("SIGTERM");
  }, 60000);
  try {
    for await (const chunk of child.stdout) {
      buffer = Buffer.concat([buffer, chunk]);
      assert.ok(buffer.length <= m.OPERATOR_LIMITS.request + 1);
      const newline = buffer.indexOf(10);
      if (newline < 0) continue;
      assert.equal(newline, buffer.length - 1);
      const text = buffer.subarray(0, newline).toString();
      buffer = Buffer.alloc(0);
      const response = await b.accept(text);
      for (let start = 0; start < response.length; start += 8192)
        await new Promise((resolve, reject) =>
          child.stdin.write(response.slice(start, start + 8192), (e) =>
            e ? reject(e) : resolve(),
          ),
        );
      await new Promise((resolve, reject) =>
        child.stdin.write("\n", (e) => (e ? reject(e) : resolve())),
      );
      if (JSON.parse(text).kind === "done") child.stdin.end();
    }
    const terminal = await exit;
    assert.equal(terminal.code, 0, errors);
    assert.equal(buffer.length, 0);
    await b.finish();
    assert.equal(b.state().requests, 33);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGTERM");
  }
});
test("escaped complete batch overflow is rejected during preparation before any upload", () => {
  const p = prepared();
  const sources = p.plan.sources.map((s) => {
    const bytes = Buffer.concat([
      Buffer.from("\t".repeat(400000)),
      Buffer.from(JSON.stringify(JSON.parse(s.rawUtf8))),
    ]);
    return {
      name: s.name,
      bytes,
      receipt: {
        ...s.sourceReceipt,
        rawSha256: m.sha256(bytes),
        sizeBytes: bytes.length,
      },
    };
  });
  const plan = m.planAuditedImport(
    {
      sources,
      workspace: p.plan.workspace,
      seriesId: p.plan.seriesId,
      observedAt: p.plan.receipt.importObservedAt,
    },
    p.profile,
  );
  const approval = {
    ...p.approval,
    window: Object.freeze({ ...p.approval.window }),
    planSha256: m.sha256(JSON.stringify(plan)),
    sources: plan.sources.map((s, i) => ({
      name: s.name,
      key: p.approval.namespace + i + ".json",
      sha256: s.rawSha256,
      sizeBytes: s.sizeBytes,
    })),
  };
  assert.ok(
    plan.sources.every((s) => s.sizeBytes <= m.OPERATOR_LIMITS.original),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(plan)) <= m.OPERATOR_LIMITS.plan);
  assert.throws(
    () => m.prepareOperatorInput({ plan, profile: p.profile, approval }),
    /operator-batch-bound|operator-envelope-bound/,
  );
});
test("current expiry and provider failure retain unknown write outcome without automatic replay", async () => {
  const p = prepared(),
    provider = syntheticProvider(p);
  let clock = 1000,
    calls = 0;
  const b = m.createParentBroker(p, {
    current: async () => {},
    now: () => clock,
    dispatch: async (args, effect) => {
      calls++;
      const result = await provider(args, effect);
      if (effect.kind === "d1.batch") clock = 100001;
      return result;
    },
  });
  await assert.rejects(m.runOperatorImport(p, (text) => b.accept(text)));
  assert.equal(b.state().batchOutcome, "settled-unverified");
  assert.equal(b.state().stopped, true);
  assert.equal(calls, 22);
  const q = prepared(),
    bad = m.createParentBroker(q, {
      current: async () => {},
      now: () => 1000,
      dispatch: async (args, effect) => {
        if (effect.kind === "d1.batch")
          throw Error("private body must not escape");
        return synthetic(args, effect);
      },
    }),
    synthetic = syntheticProvider(q);
  await assert.rejects(
    m.runOperatorImport(q, (text) => bad.accept(text)),
    /operator-provider-settlement-unknown/,
  );
  assert.equal(bad.state().batchOutcome, "unknown");
  assert.equal(bad.state().stopped, true);
});
test("stop scheduled between authority promise and dispatcher continuation denies before dispatch and ACK", async () => {
  const p = prepared();
  let b,
    calls = 0;
  b = m.createParentBroker(p, {
    now: () => 1000,
    current: async () => {
      queueMicrotask(() => queueMicrotask(() => b.stop()));
    },
    dispatch: async () => {
      calls++;
      return null;
    },
  });
  await assert.rejects(
    b.accept(
      m.stable(
        m.requestFrame({ kind: "current", payload: {} }, 1, p.actionDigest),
      ),
    ),
  );
  assert.equal(calls, 0);
  assert.equal(b.state().stopped, true);
});

test("local pipe backpressure is bounded by the original deadline and settles before rejection", async () => {
  const { PassThrough } = await import("node:stream");
  const input = new PassThrough(),
    output = new PassThrough({ highWaterMark: 1 });
  const pipe = m.createPipeExchange(input, output, Date.now() + 50);
  await assert.rejects(pipe.exchange('"synthetic"'));
  assert.equal(output.destroyed, true);
});

test("exact trusted private key map retains distinct bounded names and rejects ambiguous targets before effects", () => {
  const seed = prepared(),
    namespace = "synthetic-custody/manifest-fixed/",
    sources = seed.approval.sources.map((source, index) => ({
      ...source,
      key:
        namespace +
        "originals/source-" +
        String.fromCharCode(97 + index) +
        ".json",
    }));
  const p = prepared("import", { namespace, sources });
  assert.deepEqual(
    p.approval.sources.map((source) => source.key),
    sources.map((source) => source.key),
  );
  assert.deepEqual(
    p.effects.custody.map((original) => original.get.payload.key),
    sources.map((source) => source.key),
  );
  for (const key of [
    "foreign/original.json",
    namespace.slice(0, -1) + "-other/original.json",
    namespace,
    namespace + "../escape.json",
    namespace + "./file.json",
    namespace + "a//file.json",
    namespace + "%2e%2e/escape.json",
    namespace + "https://foreign.example/original",
    "/" + namespace + "file.json",
    namespace + "file\\name.json",
    namespace + "x".repeat(1025),
    sources[1].key,
  ]) {
    assert.throws(() =>
      prepared("import", {
        namespace,
        sources: sources.map((source, index) =>
          index === 0 ? { ...source, key } : source,
        ),
      }),
    );
  }
  for (const invalid of [
    "/synthetic/",
    "synthetic",
    "synthetic/../",
    "synthetic//",
    "https://foreign.example/",
    "synthetic/%2e/",
  ]) {
    assert.throws(() =>
      prepared("import", {
        namespace: invalid,
        sources: sources.map((source, index) => ({
          ...source,
          key: invalid + index + ".json",
        })),
      }),
    );
  }
});

test("connector envelope uses the exact D1 API batch body", async () => {
  const p = prepared(),
    captures = [];
  for (const effect of [p.effects.header, p.effects.sources, p.effects.batch]) {
    const envelope = m.connectorEnvelope(p.approval, effect),
      calls = [];
    const invoke = (response) =>
      new Function("cloudflare", `return (${envelope.args.code})();`)({
        request: async (request) => {
          calls.push(structuredClone(request));
          return response;
        },
      });
    const result = effect.payload.statements.map((_, index) => ({
      success: true,
      results: [{ synthetic: index }],
      meta: { ignored: true },
    }));
    const normalized = await invoke({
      success: true,
      result,
      ignored: "provider metadata",
    });
    assert.equal(calls.length, 1);
    assert.equal(envelope.args.account_id, p.approval.accountId);
    assert.equal(
      Array.isArray(calls[0].body),
      false,
      "D1 requires the batch object wrapper",
    );
    assert.deepEqual(calls[0], {
      method: "POST",
      path: `/accounts/${p.approval.accountId}/d1/database/${p.approval.databaseId}/query`,
      body: { batch: effect.payload.statements },
    });
    assert.deepEqual(
      normalized,
      effect.kind === "d1.batch"
        ? { statements: result.length }
        : { rows: result[0].results },
    );
    assert.equal(envelope.codeBytes, Buffer.byteLength(envelope.args.code));
    assert.equal(
      envelope.argumentBytes,
      Buffer.byteLength(JSON.stringify(envelope.args)),
    );
    captures.push({
      kind: effect.kind,
      args: envelope.args,
      request: calls[0],
      normalized,
    });
    for (const malformed of [
      { success: false, result },
      { success: true, result: [] },
      {
        success: true,
        result: result.map((r, index) =>
          index === 0 ? { ...r, success: false } : r,
        ),
      },
      {
        success: true,
        result: result.map((r, index) =>
          index === 0 ? { ...r, results: {} } : r,
        ),
      },
    ])
      await assert.rejects(
        invoke(malformed),
        /operator-provider-failed|operator-result-order/,
      );
  }
  const atomic = captures.find((capture) => capture.kind === "d1.batch");
  assert.ok(
    atomic.request.body.batch.some((statement) =>
      statement.params.some((value) => typeof value === "number"),
    ),
  );
  assert.equal(
    p.batchBytes,
    Buffer.byteLength(
      JSON.stringify({ batch: p.effects.batch.payload.statements }),
    ),
  );
  assert.ok(Object.isFrozen(p.effects.batch.payload.statements));
  await writeFile(
    "artifacts/operator/generated-d1-envelope-capture.json",
    JSON.stringify(captures, null, 2) + "\n",
  );
});

test("canonical frame decoder rejects complete and fragmented UTF8 BOM without normalization", () => {
  const p = prepared(),
    canonical = Buffer.from(
      m.stable(
        m.requestFrame({ kind: "current", payload: {} }, 1, p.actionDigest),
      ),
    );
  const reader = () =>
    m.createFrameReader({ deadline: 1000, now: () => 1, reserve: () => {} });
  const valid = reader();
  valid.push(canonical);
  assert.equal(valid.finish(), canonical.toString("utf8"));
  for (const fragments of [
    [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical])],
    [
      Buffer.from([0xef]),
      Buffer.from([0xbb]),
      Buffer.concat([Buffer.from([0xbf]), canonical]),
    ],
    [Buffer.from([0xef, 0xbb]), Buffer.from([0xbf]), canonical],
    [Buffer.from([0xc0, 0xaf])],
  ]) {
    const invalid = reader();
    for (const fragment of fragments) invalid.push(fragment);
    assert.throws(() => invalid.finish());
    assert.throws(() => invalid.push(canonical));
  }
});
for (const [index, name] of ["plan", "profile", "approval"].entries()) {
  test(`actual private ${name} runner rejects UTF8 BOM before any emitted effect`, async () => {
    const { spawn } = await import("node:child_process"),
      { once } = await import("node:events");
    const { mkdtemp } = await import("node:fs/promises"),
      { tmpdir } = await import("node:os");
    const p = prepared("import", {
      window: Object.freeze({
        nowMs: Date.now() - 1000,
        expiresAtMs: Date.now() + 60000,
      }),
    });
    const directory = await mkdtemp(
      path.join(tmpdir(), "job-stack-operator-bom-synthetic-"),
    );
    const files = ["plan", "profile", "approval"].map((kind) =>
      path.join(directory, kind + ".json"),
    );
    await Promise.all(
      [p.plan, p.profile, p.approval].map((value, selected) =>
        writeFile(
          files[selected],
          Buffer.concat([
            selected === index
              ? Buffer.from([0xef, 0xbb, 0xbf])
              : Buffer.alloc(0),
            Buffer.from(JSON.stringify(value)),
          ]),
        ),
      ),
    );
    const child = spawn(
      process.execPath,
      ["scripts/run-operator.mjs", ...files],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, CLOUDFLARE_CF_FETCH_ENABLED: "false" },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      },
    );
    let stdoutBytes = 0,
      stderrBytes = 0;
    child.stdout.on("data", (value) => {
      stdoutBytes += value.length;
    });
    child.stderr.on("data", (value) => {
      stderrBytes += value.length;
    });
    child.stdin.end();
    const [code, signal] = await once(child, "close");
    assert.equal(signal, null);
    assert.equal(code, 1);
    assert.equal(
      stdoutBytes,
      0,
      "BOM input must fail before the first parent current/effect frame",
    );
    assert.ok(stderrBytes > 0 && stderrBytes < 4096);
  });
}

test("complete or absent receipt from another invocation cannot replay into custody", async () => {
  const p = prepared();
  const first = m.requestFrame(p.effects.custody[0].get, 1, p.actionDigest);
  const args = m.connectorEnvelope(p.approval, p.effects.custody[0].get, {
    source: p.plan.sources[0],
    frame: first,
  }).args;
  for (const body of [null, Buffer.from(p.plan.sources[0].rawUtf8)]) {
    const prior = await emittedRead(args, body);
    const b = broker(p, async () => prior);
    await b.accept(
      m.stable(
        m.requestFrame({ kind: "current", payload: {} }, 1, p.actionDigest),
      ),
    );
    await assert.rejects(
      b.accept(
        m.stable(m.requestFrame(p.effects.custody[0].get, 2, p.actionDigest)),
      ),
      /operator-read-binding/,
    );
    assert.equal(b.state().requests, 1);
    assert.equal(b.state().d1, 0);
  }
});
test("proof absent, mismatch, stop or expiry after final await never yields final acknowledgement", async () => {
  for (const fault of ["absent", "mismatch", "stop", "expiry", "current"]) {
    const p = prepared(),
      provider = syntheticProvider(p);
    let final = false,
      clock = 1000,
      denied = false;
    const b = m.createParentBroker(p, {
      now: () => clock,
      current: async () => {
        if (denied) throw Error("synthetic-current-denied");
      },
      dispatch: async (args, effect) => {
        if (final && effect.kind === "r2.get") {
          if (fault === "absent") return emittedRead(args, null);
          if (fault === "mismatch")
            return emittedRead(args, Buffer.from("mismatch"));
          const value = await provider(args, effect);
          if (fault === "stop") b.stop();
          if (fault === "expiry") clock = p.approval.window.expiresAtMs;
          if (fault === "current") denied = true;
          return value;
        }
        const result = await provider(args, effect);
        if (
          effect === p.effects.clock ||
          (effect.kind === "d1.first" &&
            effect.payload.statements[0].sql ===
              p.effects.clock.payload.statements[0].sql)
        )
          final = true;
        return result;
      },
    });
    await assert.rejects(m.runOperatorImport(p, (text) => b.accept(text)));
    assert.equal(final, true);
    assert.equal(b.state().completed, false);
    assert.equal(b.state().stopped, true);
    assert.equal(b.state().batchOutcome, "committed");
    assert.equal(b.state().r2, 21);
    await assert.rejects(b.finish());
  }
});
test("reconciliation consumes complete-read evidence, rejects initial absence and never writes", async () => {
  const p = prepared("reconcile");
  let writes = 0;
  const b = broker(p, async (args, effect) => {
    if (effect.kind === "r2.get") {
      const index = p.approval.sources.findIndex(
        (s) => s.key === effect.payload.key,
      );
      return emittedRead(args, Buffer.from(p.plan.sources[index].rawUtf8));
    }
    if (effect.kind === "r2.put" || effect.kind === "d1.batch") {
      writes++;
      throw Error("unexpected mutation");
    }
    return {
      rows: [
        {
          source_snapshot: null,
          p_snapshot: null,
          record_count: 0,
          baseline_count: 0,
          source_count: 0,
          stage_count: 0,
          canonical_count: 0,
        },
      ],
    };
  });
  assert.equal(await m.runOperatorImport(p, (text) => b.accept(text)), null);
  await b.finish();
  assert.equal(writes, 0);
  const missing = broker(p, (args) => emittedRead(args, null));
  await assert.rejects(
    m.runOperatorImport(p, (text) => missing.accept(text)),
    /operator-original-absent/,
  );
  assert.equal(missing.state().d1, 0);
});
