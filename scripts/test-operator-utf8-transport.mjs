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
      "export {completeReadCode} from './src/operator/complete-read'; export * from './src/operator/import'; export * from './src/operator/protocol'; export {fixtureProfile,fixtureSupplementedInputs} from './tests/fixtures/audited-profile-inputs'; export {planAuditedImport} from './src/application/audited-legacy-import'; export {parseAuditedSourceProfile} from './src/application/audited-source-profile';",
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
function preparedFixture(size = 95) {
  const profile = m.parseAuditedSourceProfile(m.fixtureProfile);
  const sources = m.fixtureSupplementedInputs();
  const raw = '{"call_notes":[],"bytes":"café 🔒 é é\\r\\n"}';
  const bytes = Buffer.from(raw + " ".repeat(size - Buffer.byteLength(raw)));
  sources[3] = {
    ...sources[3],
    bytes,
    receipt: {
      ...sources[3].receipt,
      sizeBytes: bytes.length,
      rawSha256: m.sha256(bytes),
    },
  };
  const plan = m.planAuditedImport(
    {
      sources,
      workspace: profile.workspace,
      seriesId: profile.seriesId,
      observedAt: 1000,
    },
    profile,
  );
  return m.prepareOperatorInput({
    plan,
    profile,
    approval: {
      format: "job-stack.operator-approval.v1",
      mode: "import",
      actionId: "synthetic-complete-read",
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
    },
  });
}
async function execute(args, bytes, options = {}) {
  let calls = 0;
  const result = await new Function(
    "fetch",
    "cloudflare",
    "Date",
    `return (${args.code})();`,
  )(
    async (url, init) => {
      calls++;
      assert.match(
        url,
        /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/a{32}\/r2\/buckets\/synthetic-originals\/objects\/synthetic\/[0-4]\.json$/,
      );
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "manual");
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(Object.hasOwn(init, "headers"), false);
      return new Response(bytes, { status: 200, ...options });
    },
    {
      request: async () => {
        calls++;
        return {
          success: true,
          status: 200,
          result: { base64: Buffer.from(bytes).toString("base64") },
        };
      },
    },
    class extends Date {
      static now() {
        return 1000;
      }
    },
  );
  assert.equal(calls, 1);
  return result;
}
test("actual emitted GET verifies complete 95-byte source and returns only bound receipt", async () => {
  const p = preparedFixture();
  let last;
  const broker = m.createParentBroker(p, {
    current: async () => {},
    now: () => 1000,
    dispatch: async (args, effect) => {
      const index = p.approval.sources.findIndex(
        (s) => s.key === effect.payload.key,
      );
      last = await execute(args, Buffer.from(p.plan.sources[index].rawUtf8));
      return last;
    },
  });
  for (let i = 0; i <= 3; i++) {
    const frame = m.requestFrame(
      p.effects.custody[i].get,
      i + 1,
      p.actionDigest,
    );
    const response = m.checkedResponse(
      await broker.accept(m.stable(frame)),
      frame,
    );
    assert.equal(last.format, "job-stack.remote-original-read.v1");
    assert.equal(last.requestDigest, frame.requestDigest);
    assert.equal(last.sequence, frame.sequence);
    assert.equal(last.sourceName, p.approval.sources[i].name);
    assert.equal(last.sha256, p.approval.sources[i].sha256);
    assert.equal(last.sizeBytes, p.approval.sources[i].sizeBytes);
    assert.equal(last.literalBytesEqual, true);
    assert.equal(last.complete, true);
    assert.equal(Object.hasOwn(last, "base64"), false);
    assert.ok(Buffer.byteLength(JSON.stringify(last)) <= 2048);
    assert.deepEqual(response.result, last);
  }
  assert.equal(last.sizeBytes, 95);
  assert.equal(broker.state().d1, 0);
});

const fixture = preparedFixture();
function readEnvelope(p = fixture, index = 3, sequence = 1) {
  const effect = p.effects.custody[index].get;
  const frame = m.requestFrame(effect, sequence, p.actionDigest);
  return {
    frame,
    ...m.connectorEnvelope(p.approval, effect, {
      source: p.plan.sources[index],
      frame,
    }),
  };
}
const { emittedRead } = await import("./operator-complete-read-fixtures.mjs");
const expected = Buffer.from(fixture.plan.sources[3].rawUtf8);
const metadata = [];
for (const size of [95, 273231, 524288])
  test(`complete exact ${size} byte stream has small receipt and measured admitted envelopes`, async () => {
    const p = preparedFixture(size),
      envelope = readEnvelope(p);
    const bytes = Buffer.from(p.plan.sources[3].rawUtf8);
    const result = await emittedRead(envelope.args, bytes, {
      headers: {
        "content-length": String(size),
        "content-encoding": "identity",
      },
    });
    assert.equal(result.sizeBytes, size);
    assert.equal(result.sha256, m.sha256(bytes));
    assert.equal(result.literalBytesEqual, true);
    const responseBytes = Buffer.byteLength(JSON.stringify(result));
    assert.ok(responseBytes <= 2048);
    for (const e of p.envelopes) {
      assert.ok(e.codeBytes <= m.OPERATOR_LIMITS.code);
      assert.ok(e.argumentBytes <= m.OPERATOR_LIMITS.toolArgs);
      assert.ok(
        e.requestBytes +
          e.codeBytes +
          e.argumentBytes +
          m.OPERATOR_LIMITS.response +
          m.OPERATOR_LIMITS.original <=
          m.OPERATOR_LIMITS.aggregate,
      );
    }
    metadata.push({
      size,
      codeBytes: envelope.codeBytes,
      argumentBytes: envelope.argumentBytes,
      responseBytes,
      envelopes: p.envelopes,
    });
    await writeFile(
      "artifacts/operator/complete-read-costs.json",
      JSON.stringify(metadata, null, 2) + "\n",
    );
  });
for (const [label, body, options] of [
  [
    "one-byte mismatch",
    Buffer.concat([Buffer.from("x"), expected.subarray(1)]),
  ],
  ["short", expected.subarray(0, -1)],
  ["extra", Buffer.concat([expected, Buffer.from(" ")])],
  ["empty", Buffer.alloc(0)],
  ["lying length", expected, { headers: { "content-length": "94" } }],
  ["negative length", expected, { headers: { "content-length": "-1" } }],
  ["leading zero length", expected, { headers: { "content-length": "095" } }],
  ["invalid length", expected, { headers: { "content-length": "95x" } }],
  ["overbound length", expected, { headers: { "content-length": "524289" } }],
  ["compressed", expected, { headers: { "content-encoding": "gzip" } }],
  ...[201, 206, 301, 302, 307, 308, 401, 403, 429, 500, 503].map((status) => [
    `status ${status}`,
    expected,
    { status },
  ]),
])
  test(`actual emitted code rejects ${label}`, async () => {
    await assert.rejects(emittedRead(readEnvelope().args, body, options));
  });
function stream(chunks, ending = "close") {
  let position = 0;
  return new ReadableStream({
    pull(controller) {
      if (position < chunks.length) controller.enqueue(chunks[position++]);
      else if (ending === "throw")
        controller.error(Error("synthetic-stream-error"));
      else if (ending === "close") controller.close();
      else return new Promise(() => {});
    },
  });
}
test("throwing, too many empty chunks and total chunk cap never establish EOF", async () => {
  for (const body of [
    stream([expected], "throw"),
    stream(Array.from({ length: 33 }, () => new Uint8Array())),
    stream(Array.from({ length: 1025 }, () => Uint8Array.of(32))),
  ]) {
    const envelope = readEnvelope(preparedFixture(273231));
    await assert.rejects(emittedRead(envelope.args, body));
  }
});
test(
  "deadline aborts stalled fetch and body; hung cancellation cannot hold settlement",
  { timeout: 3000 },
  async () => {
    for (const fetchStall of [false, true]) {
      let aborted = false,
        cancelled = false;
      const body = new ReadableStream({
        pull: () => new Promise(() => {}),
        cancel: () => {
          cancelled = true;
          return new Promise(() => {});
        },
      });
      await assert.rejects(
        emittedRead(readEnvelope().args, body, {
          setTimeout: (callback) => setTimeout(callback, 15),
          fetch: async (_url, init) => {
            init.signal.addEventListener("abort", () => {
              aborted = true;
            });
            return fetchStall ? new Promise(() => {}) : new Response(body);
          },
        }),
        /operator-read-deadline/,
      );
      assert.equal(aborted, true);
      assert.equal(cancelled, !fetchStall);
    }
  },
);
test("expiry checked before fetch and after asynchronous body settlement", async () => {
  let calls = 0,
    now = 100000;
  await assert.rejects(
    emittedRead(readEnvelope().args, expected, {
      now: () => now,
      fetch: async () => {
        calls++;
        return new Response(expected);
      },
    }),
    /deadline/,
  );
  assert.equal(calls, 0);
  now = 1000;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(expected);
    },
    pull(c) {
      now = 100000;
      c.close();
    },
  });
  await assert.rejects(
    emittedRead(readEnvelope().args, body, { now: () => now }),
    /deadline/,
  );
});
const absence = {
  success: false,
  result: null,
  errors: [{ code: 10007, message: "Synthetic absent" }],
  messages: [],
};
test("only actual404 closed provider absence establishes bound absence receipt", async () => {
  const { args, frame } = readEnvelope();
  const result = await emittedRead(args, JSON.stringify(absence), {
    status: 404,
  });
  assert.equal(result.format, "job-stack.remote-original-absent.v1");
  assert.equal(result.requestDigest, frame.requestDigest);
  assert.equal(result.status, 404);
  assert.equal(result.errorCode, 10007);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2048);
});
for (const [label, value] of [
  ["success true", { ...absence, success: true }],
  ["result object", { ...absence, result: {} }],
  ["no errors", { ...absence, errors: [] }],
  [
    "mixed errors",
    {
      ...absence,
      errors: [...absence.errors, { code: 10001, message: "Unauthorized" }],
    },
  ],
  [
    "code string",
    { ...absence, errors: [{ code: "10007", message: "Synthetic" }] },
  ],
  ["code only", { ...absence, errors: [{ code: 10007 }] }],
  ["error string", { ...absence, errors: ["10007"] }],
  ["unknown envelope field", { ...absence, extra: true }],
  ["messages", { ...absence, messages: ["ambiguous"] }],
  ["missing result", { success: false, errors: absence.errors, messages: [] }],
  ["truncated", '{"success":false'],
  ["empty", ""],
  ["overbound", " ".repeat(8193)],
])
  test(`actual404 rejects ${label}`, async () => {
    await assert.rejects(
      emittedRead(
        readEnvelope().args,
        typeof value === "string" ? value : JSON.stringify(value),
        { status: 404 },
      ),
    );
  });
test("absence-looking non404 and network exceptions remain failures", async () => {
  await assert.rejects(
    emittedRead(readEnvelope().args, JSON.stringify(absence)),
  );
  await assert.rejects(
    emittedRead(readEnvelope().args, null, {
      fetch: async () => {
        throw Error("10007 synthetic network error");
      },
    }),
  );
});
test("receipt forgery, old raw copy, truncation and cross-invocation results deny before writes", async () => {
  const p = preparedFixture();
  const first = readEnvelope(p, 0);
  const good = await emittedRead(
    first.args,
    Buffer.from(p.plan.sources[0].rawUtf8),
  );
  const variants = [
    null,
    { base64: Buffer.from(p.plan.sources[0].rawUtf8).toString("base64") },
    { ...good, extra: true },
    { ...good, complete: false },
    { ...good, literalBytesEqual: false },
    { ...good, sequence: 2 },
    { ...good, requestDigest: "0".repeat(64) },
    { ...good, accountId: "c".repeat(32) },
    { ...good, bucket: "foreign" },
    { ...good, key: "synthetic/1.json" },
    { ...good, sourceName: "foreign.json" },
    { ...good, actionDigest: "c".repeat(64) },
    { ...good, sha256: good.sha256.toUpperCase() },
    { ...good, sizeBytes: String(good.sizeBytes) },
    { ...good, sizeBytes: good.sizeBytes + 1 },
    { ...good, sha256: "0".repeat(64) },
    { ...good, status: 206 },
    { ...good, format: "foreign" },
    { ...good, truncated: true },
    ...Object.keys(good).map((key) =>
      Object.fromEntries(Object.entries(good).filter(([k]) => k !== key)),
    ),
  ];
  for (const value of variants) {
    const b = m.createParentBroker(p, {
      current: async () => {},
      now: () => 1000,
      dispatch: async () => value,
    });
    await assert.rejects(b.accept(m.stable(first.frame)));
    assert.equal(b.state().stopped, true);
    assert.equal(b.state().d1, 0);
    assert.equal(b.state().requests, 1);
  }
});

for (const [label, bytes] of [
  ["BOM and CRLF", Buffer.from('\uFEFF{"raw":true}\r\n')],
  ["Unicode normalization", Buffer.from("é e\u0301 🔒\r\n")],
  ["binary", Buffer.from([0, 255, 128, 192, 10, 13, 239, 187, 191])],
])
  test(`source template preserves literal ${label} bytes without decoding`, async () => {
    const p = fixture,
      source = p.approval.sources[3],
      frame = readEnvelope().frame;
    const binding = {
      accountId: p.approval.accountId,
      bucket: p.approval.bucket,
      key: source.key,
      sourceName: source.name,
      actionDigest: p.actionDigest,
      sequence: frame.sequence,
      requestDigest: frame.requestDigest,
    };
    const args = {
      code: m.completeReadCode({
        binding,
        expectedBase64: bytes.toString("base64"),
        expectedSize: bytes.length,
        expectedSha256: m.sha256(bytes),
        expiresAtMs: 100000,
      }),
    };
    const result = await emittedRead(args, bytes);
    assert.equal(result.sizeBytes, bytes.length);
    assert.equal(result.sha256, m.sha256(bytes));
    assert.equal(result.literalBytesEqual, true);
    await assert.rejects(
      emittedRead(
        args,
        Buffer.from(
          bytes
            .toString("utf8")
            .normalize("NFC")
            .replaceAll("\r", "")
            .replaceAll("\uFEFF", ""),
        ),
      ),
    );
  });

test("source template rejects overbound expected bytes before fetch", async () => {
  const p = fixture,
    source = p.approval.sources[3],
    frame = readEnvelope().frame;
  const bytes = Buffer.alloc(524289, 32);
  let fetched = 0;
  await assert.rejects(async () => {
    const code = m.completeReadCode({
      binding: {
        accountId: p.approval.accountId,
        bucket: p.approval.bucket,
        key: source.key,
        sourceName: source.name,
        actionDigest: p.actionDigest,
        sequence: frame.sequence,
        requestDigest: frame.requestDigest,
      },
      expectedBase64: bytes.toString("base64"),
      expectedSize: bytes.length,
      expectedSha256: m.sha256(bytes),
      expiresAtMs: 100000,
    });
    return emittedRead({ code }, bytes, {
      fetch: async () => {
        fetched++;
        return new Response(bytes);
      },
    });
  });
  assert.equal(fetched, 0);
});

test("actual404 rejects duplicate envelope and error keys as ambiguous", async () => {
  for (const text of [
    '{"success":true,"success":false,"result":null,"errors":[{"code":10007,"message":"Synthetic absent"}],"messages":[]}',
    '{"success":false,"result":null,"errors":[{"code":10001,"code":10007,"message":"Synthetic absent"}],"messages":[]}',
    '{"success":false,"result":null,"errors":[{"code":10007,"message":"Synthetic absent"}],"messages":["warning"],"messages":[]}',
  ]) await assert.rejects(emittedRead(readEnvelope().args, text, { status: 404 }));
});

test("strict404 key counting preserves escaped message strings and recognizes escaped duplicate keys", async () => {
  const value = { ...absence, errors: [{ code: 10007, message: 'Synthetic "success":true and \\ path' }] };
  const result = await emittedRead(readEnvelope().args, JSON.stringify(value), { status: 404 });
  assert.equal(result.status, 404);
  await assert.rejects(emittedRead(readEnvelope().args,
    '{"success":true,"\\u0073uccess":false,"result":null,"errors":[{"code":10007,"message":"Synthetic absent"}],"messages":[]}',
    { status: 404 }));
});

test("strict404 accepts unique JSON-escaped field names", async () => {
  const value = '{"\\u0073uccess":false,"result":null,"errors":[{"\\u0063ode":10007,"message":"Synthetic absent"}],"messages":[]}';
  assert.equal((await emittedRead(readEnvelope().args, value, { status: 404 })).status, 404);
});

test("literal comparison rejects wrong bytes even if a mocked digest matches expected", async () => {
  const envelope = readEnvelope();
  const changed = Buffer.from(expected);
  changed[0] ^= 1;
  let hashed;
  await assert.rejects(new Function("fetch", "Date", "crypto", `return (${envelope.args.code})();`)(
    async () => new Response(changed),
    class extends Date { static now() { return 1000; } },
    { subtle: { digest: async (_algorithm, bytes) => {
      hashed = Buffer.from(bytes);
      return Buffer.from(m.sha256(expected), "hex");
    } } },
  ), /operator-original-conflict/);
  assert.deepEqual(hashed, changed);
});

test("child cannot inject fetch URL, headers or expected bytes into an admitted GET", async () => {
  const p = fixture;
  for (const extra of [{ url: "https://foreign.example/" }, { headers: { Authorization: "synthetic" } }, { expectedBase64: expected.toString("base64") }]) {
    const effect = { ...p.effects.custody[0].get, payload: { ...p.effects.custody[0].get.payload, ...extra } };
    let calls = 0;
    const b = m.createParentBroker(p, { current: async () => {}, now: () => 1000,
      dispatch: async () => { calls++; throw Error("unexpected-dispatch"); } });
    await assert.rejects(b.accept(m.stable(m.requestFrame(effect, 1, p.actionDigest))), /operator-effect-mismatch/);
    assert.equal(calls, 0);
  }
});
