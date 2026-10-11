process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
const built = await build({
  stdin: {
    contents:
      "export * from './src/operator/import'; export * from './src/operator/protocol'; export {fixtureProfile,fixtureSupplementedInputs} from './tests/fixtures/audited-profile-inputs'; export {planAuditedImport} from './src/application/audited-legacy-import'; export {parseAuditedSourceProfile} from './src/application/audited-source-profile';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
await mkdir("artifacts/operator", { recursive: true });
const bundled = path.resolve("artifacts/operator/utf8-transport.mjs");
await writeFile(bundled, built.outputFiles[0].text);
const m = await import(pathToFileURL(bundled));
const { connectorEnvelope } = m;
const approval = { accountId: "a".repeat(32), bucket: "synthetic-originals" };
const effect = { kind: "r2.get", payload: { key: "synthetic/fixture.json" } };
const envelope = connectorEnvelope(approval, effect);
function invoke(result, options = {}) {
  return new Function("cloudflare", `return (${envelope.args.code})();`)({
    request: async (request) => {
      assert.deepEqual(request, {
        method: "GET",
        path: `/accounts/${approval.accountId}/r2/buckets/${approval.bucket}/objects/synthetic/fixture.json`,
      });
      if (options.error) throw options.error;
      return { success: true, status: 200, result, ...options };
    },
  });
}
const fixtures = [
  "",
  '{"order":[3,1,2], "escaped":"\\n\\u0000\\\""}\r\n',
  "\u0000café 🔒 e\u0301 é\n\r\n",
  '\uFEFF{"bom":true}\n',
  "actual replacement: �",
];
for (const [i, text] of fixtures.entries())
  test(`exact UTF-8 byte preservation fixture ${i}`, async () => {
    const result = await invoke(text);
    assert.deepEqual(result, {
      base64: Buffer.from(text, "utf8").toString("base64"),
    });
    assert.deepEqual(
      Buffer.from(result.base64, "base64"),
      Buffer.from(text, "utf8"),
    );
  });
for (const size of [273231, 512 * 1024])
  test(`complete maximum fixture ${size} bytes`, async () => {
    const prefix = '{"unicode":"🔒 café","payload":"',
      suffix = '"}\r\n';
    const text =
      prefix + "a".repeat(size - Buffer.byteLength(prefix + suffix)) + suffix;
    assert.equal(Buffer.byteLength(text), size);
    const result = await invoke(text);
    assert.deepEqual(Buffer.from(result.base64, "base64"), Buffer.from(text));
  });
for (const [label, value] of [
  ["lone-high", "\ud800"],
  ["lone-low", "\udc00"],
  ["bad-pair", "\ud800x"],
  ["overbound-ascii", "x".repeat(512 * 1024 + 1)],
  ["overbound-unicode", "é".repeat(512 * 1024)],
  ["object", { parsed: true }],
  ["array", []],
  ["null", null],
  ["number", 42],
])
  test(`reject ${label}`, async () => {
    await assert.rejects(invoke(value));
  });
test("retains closed raw-base64 branch without claiming binary qualification", async () => {
  assert.deepEqual(await invoke({ base64: "AAE=" }), { base64: "AAE=" });
  await assert.rejects(invoke({ base64: "AAE=", extra: true }));
});
test("structured returned404 remains absent; generic errors remain errors", async () => {
  assert.equal(await invoke(null, { status: 404, success: false }), null);
  const error = new Error(
    "Cloudflare API error: 10007: The specified key does not exist.",
  );
  await assert.rejects(invoke(null, { error }), (e) => e === error);
  await assert.rejects(invoke(null, { success: false, status: 403 }));
});
test("normalization changes remain visible to exact byte/hash validation", async () => {
  for (const [left, right] of [
    ["é", "e\u0301"],
    ["\uFEFF{}", "{}"],
    ["{}\r\n", "{}\n"],
    ['{"a":1, "b":2}', '{"b":2,"a":1}'],
  ]) {
    assert.notEqual((await invoke(left)).base64, (await invoke(right)).base64);
  }
});

function preparedFixture() {
  const profile = m.parseAuditedSourceProfile(m.fixtureProfile);
  const plan = m.planAuditedImport(
    {
      sources: m.fixtureSupplementedInputs(),
      workspace: profile.workspace,
      seriesId: profile.seriesId,
      observedAt: 1000,
    },
    profile,
  );
  const approval = {
    format: "job-stack.operator-approval.v1",
    mode: "import",
    actionId: "synthetic-utf8",
    accountId: "a".repeat(32),
    databaseId: "00000000-0000-4000-8000-000000000001",
    bucket: "synthetic-originals",
    namespace: "synthetic/",
    namespaceExclusive: true,
    window: Object.freeze({ nowMs: 100, expiresAtMs: 100000 }),
    sourceClosureSha256: "b".repeat(64),
    profileSha256: m.sha256(JSON.stringify(profile)),
    planSha256: m.sha256(JSON.stringify(plan)),
    sources: plan.sources.map((s, i) => ({
      name: s.name,
      key: `synthetic/${i}.json`,
      sha256: s.rawSha256,
      sizeBytes: s.sizeBytes,
    })),
  };
  return m.prepareOperatorInput({ plan, profile, approval });
}
test("actual broker accepts unchanged UTF-8 but rejects altered complete readback before writes", async () => {
  for (const mutation of [
    (s) => s,
    (s) => s + " ",
    (s) => s.slice(0, -1),
    (s) => "�" + s,
    (s) => JSON.stringify(JSON.parse(s), null, 2),
  ]) {
    const p = preparedFixture(),
      text = mutation(p.plan.sources[0].rawUtf8);
    let calls = 0;
    const broker = m.createParentBroker(p, {
      current: async () => {},
      now: () => 1000,
      dispatch: async (args, effect) => {
        calls++;
        assert.equal(effect.kind, "r2.get");
        return new Function("cloudflare", `return (${args.code})();`)({
          request: async () => ({ success: true, status: 200, result: text }),
        });
      },
    });
    const action = broker.accept(
      m.stable(m.requestFrame(p.effects.custody[0].get, 1, p.actionDigest)),
    );
    if (text === p.plan.sources[0].rawUtf8) await action;
    else await assert.rejects(action, /operator-original-conflict/);
    assert.equal(calls, 1);
  }
});
test("prepared envelopes include full escaped code and tool arguments under immutable limits", () => {
  const p = preparedFixture();
  for (const effect of p.effects.custody.flatMap((x) => [x.get, x.put])) {
    const e = connectorEnvelope(p.approval, effect);
    assert.equal(e.codeBytes, Buffer.byteLength(e.args.code));
    assert.equal(e.argumentBytes, Buffer.byteLength(JSON.stringify(e.args)));
    assert.ok(e.codeBytes <= m.OPERATOR_LIMITS.code);
    assert.ok(e.argumentBytes <= m.OPERATOR_LIMITS.toolArgs);
  }
});
