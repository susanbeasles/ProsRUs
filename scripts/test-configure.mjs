import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = fileURLToPath(new URL("./configure.mjs", import.meta.url));
const baseline = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const outputs = {
  environment: { value: "staging" },
  account_id: { value: "a".repeat(32) },
  database_id: { value: "11111111-2222-4333-8444-555555555555" },
  originals_bucket_name: { value: "job-stack-staging-originals" },
  uploads_bucket_name: { value: "job-stack-staging-uploads" },
  queue_name: { value: "job-stack-staging" },
};

async function run(t, output = outputs, config = baseline) {
  const directory = await mkdtemp(join(tmpdir(), "prosrus-configure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "wrangler.jsonc"), JSON.stringify(config));
  await writeFile(join(directory, "outputs.json"), JSON.stringify(output));
  const result = spawnSync(process.execPath, [script, "outputs.json", "synthetic_owner"], {
    cwd: directory, encoding: "utf8", timeout: 5000,
    env: { PATH: process.env.PATH },
  });
  let generated = null;
  try { generated = JSON.parse(await readFile(join(directory, "wrangler.staging.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return { result, generated };
}

test("configures reviewed resource references while preserving disabled consumers and public ingress", async t => {
  const { result, generated } = await run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(generated.account_id, outputs.account_id.value);
  assert.equal(generated.d1_databases[0].database_id, outputs.database_id.value);
  assert.deepEqual(generated.queues.consumers, []);
  assert.deepEqual(generated.triggers.crons, []);
  assert.equal(generated.workers_dev, false);
  assert.equal(generated.preview_urls, false);
  assert.deepEqual(generated.migrations, baseline.migrations);
  assert.equal(generated.vars.OWNER_ID, "synthetic_owner");
  assert.deepEqual(generated.r2_buckets.map(b => [b.binding, b.bucket_name]).sort(), [["ORIGINALS", "job-stack-staging-originals"], ["UPLOADS", "job-stack-staging-uploads"]]);
  assert.match(result.stdout, /not deployed/i);
});

test("preserves an existing reviewed reciprocal authority binding without deriving one from outputs", async t => {
  const services = [{ binding: "CONTROL_AUTHORITY", service: "existing_control_fixture", entrypoint: "JobStackAuthority" }];
  const { result, generated } = await run(t, outputs, { ...baseline, services });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(generated.services, services);
});

test("rejects malformed resource identity before generating configuration", async t => {
  for (const [key, value] of [
    ["account_id", ""], ["account_id", "https://arbitrary.invalid"],
    ["database_id", "0".repeat(36)], ["database_id", "00000000-0000-0000-0000-000000000000"],
    ["originals_bucket_name", null], ["uploads_bucket_name", "job-stack-staging-backup"],
    ["originals_bucket_name", "job-stack-staging-backup"], ["queue_name", "foreign-queue"],
  ]) {
    const { result, generated } = await run(t, { ...outputs, [key]: { value } });
    assert.notEqual(result.status, 0, key);
    assert.equal(generated, null, key);
  }
});

test("does not turn altered ingress or consumer configuration into an approved release config", async t => {
  for (const change of [
    { workers_dev: true }, { preview_urls: true },
    { triggers: { crons: ["* * * * *"] } },
    { queues: { ...baseline.queues, consumers: [{ queue: "job-stack-staging" }] } },
    { r2_buckets: [...baseline.r2_buckets, { binding: "BACKUP", bucket_name: "job-stack-staging-backup" }] },
  ]) {
    const { result, generated } = await run(t, outputs, { ...baseline, ...change });
    assert.notEqual(result.status, 0);
    assert.equal(generated, null);
  }
});
