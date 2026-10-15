import { join } from "node:path";
import { applyMigrations } from "./runtime-migrations.mjs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
const runPath = join(
  "artifacts",
  `primary-run-${Date.now()}-${crypto.randomUUID()}`,
);
mkdirSync(runPath, { recursive: true });
const bundlePath = join(runPath, "worker.mjs");
await build({
  entryPoints: ["scripts/primary-runtime-worker.ts"],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  external: ["node:crypto"],
});
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: readFileSync(bundlePath, "utf8"),
    compatibilityDate: "2026-10-08",
    compatibilityFlags: ["nodejs_compat"],
    cf: false,
    r2Buckets: { BUCKET: "primary-product-fixture" },
    d1Databases: { DB: "primary-product-fixture" },
    resourcePersistencePath: "artifacts/primary-runtime-state",
  }),
);
const cases = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "streams",
      "stream-faults",
      "uploads",
      "authority-failures",
      "packages",
      "large?length=8388625",
    ];
try {
  await applyMigrations(await mf.getD1Database("DB"));
  for (const name of cases) {
    const namespace = `fixture-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const started = Date.now();
    const response = await mf.dispatchFetch(
      `http://local/${name}${name.includes("?") ? "&" : "?"}namespace=${namespace}`,
    );
    const result = {
      case: name,
      namespace,
      status: response.status,
      elapsedMs: Date.now() - started,
      ...(await response.json()),
    };
    console.log(JSON.stringify(result));
    writeFileSync(
      join(runPath, `primary-${namespace}.json`),
      JSON.stringify(result, null, 2) + "\n",
    );
    assert.equal(response.status, 200);
  }
} finally {
  await mf.dispose();
}
