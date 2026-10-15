import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { releaseMarkerJson } from "./write-release-marker.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => {
  assert.ok(statSync(join(root, path)).size <= 65536, `${path} exceeds the bounded read`);
  return readFileSync(join(root, path), "utf8");
};
const ADAPTERS = new Set(["cloudflare-d1-migrate/v1", "cloudflare-worker/v1"]);
const keys = (value) => Object.keys(value).sort();

/** application-deployment/v1 validation (CONTRACTS §1). Returns a list of issues. */
export function manifestIssues(manifest, { exists = () => true, scripts = {}, wrangler = {} } = {}) {
  const issues = [];
  const exact = (value, expected, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return issues.push(`${label} must be an object`);
    if (keys(value).join() !== [...expected].sort().join()) issues.push(`${label} keys must be exactly ${[...expected].sort()}`);
  };
  const relative = (value, label) => {
    if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\") || value.split("/").includes("..")
        || normalize(value) !== value || value.startsWith("./") || value.endsWith("/"))
      issues.push(`${label} must be a normalized relative path inside the repository`);
  };
  exact(manifest, ["schema", "application", "repository", "repositoryId", "targets", "environments"], "manifest");
  if (manifest.schema !== "application-deployment/v1") issues.push("schema must be application-deployment/v1");
  if (manifest.application !== "prosrus") issues.push("application must be prosrus");
  if (manifest.repository !== "susanbeasles/ProsRUs") issues.push("repository mismatch");
  if (manifest.repositoryId !== 1412827677) issues.push("repositoryId mismatch");
  const targets = Array.isArray(manifest.targets) ? manifest.targets : [];
  if (!targets.length) issues.push("targets must be a non-empty array");
  const ids = new Set();
  for (const target of targets) {
    const label = `target ${target?.id}`;
    if (typeof target?.id !== "string" || !/^[a-z0-9-]{1,64}$/.test(target.id)) issues.push(`${label} id invalid`);
    if (ids.has(target?.id)) issues.push(`${label} duplicated`);
    ids.add(target?.id);
    if (!ADAPTERS.has(target?.adapter)) issues.push(`${label} adapter not in the fixed set`);
    if (!Array.isArray(target?.dependsOn) || new Set(target.dependsOn).size !== target.dependsOn.length) issues.push(`${label} dependsOn invalid`);
    if (target?.adapter === "cloudflare-d1-migrate/v1") {
      exact(target, ["id", "adapter", "build", "dependsOn", "recoveryPolicy"], label);
      exact(target.build, ["migrationsDir", "binding"], `${label} build`);
      if (target.recoveryPolicy !== "forward-only") issues.push(`${label} recoveryPolicy must be forward-only`);
      relative(target.build?.migrationsDir, `${label} migrationsDir`);
      if (!exists(target.build?.migrationsDir)) issues.push(`${label} migrationsDir missing`);
      const d1 = wrangler.d1_databases ?? [];
      if (!d1.some((db) => db.binding === target.build?.binding && db.migrations_dir === target.build?.migrationsDir))
        issues.push(`${label} binding/migrationsDir must match wrangler.jsonc`);
    }
    if (target?.adapter === "cloudflare-worker/v1") {
      exact(target, ["id", "adapter", "build", "dependsOn", "healthContract"], label);
      exact(target.build, ["wranglerConfig", "entry", "assetsDir", "buildCommand"], `${label} build`);
      if (target.healthContract !== "http-release-marker/v1") issues.push(`${label} healthContract must be http-release-marker/v1`);
      for (const key of ["wranglerConfig", "entry", "assetsDir"]) relative(target.build?.[key], `${label} ${key}`);
      for (const key of ["wranglerConfig", "entry"]) if (!exists(target.build?.[key])) issues.push(`${label} ${key} missing`);
      if (typeof target.build?.buildCommand !== "string" || !/^[a-z][a-z0-9:-]{0,63}$/.test(target.build.buildCommand) || !Object.hasOwn(scripts, target.build.buildCommand))
        issues.push(`${label} buildCommand must name an npm script`);
      if (wrangler.main !== target.build?.entry) issues.push(`${label} entry must equal wrangler main`);
      if (normalize(wrangler.assets?.directory ?? "") !== target.build?.assetsDir) issues.push(`${label} assetsDir must equal wrangler assets.directory`);
    }
  }
  for (const target of targets) for (const dep of target?.dependsOn ?? []) if (!ids.has(dep)) issues.push(`target ${target.id} depends on unknown ${dep}`);
  const visiting = new Set(), done = new Set(), byId = new Map(targets.map((t) => [t?.id, t]));
  const visit = (id) => {
    if (done.has(id)) return;
    if (visiting.has(id)) { issues.push(`dependency cycle through ${id}`); return; }
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) if (byId.has(dep)) visit(dep);
    visiting.delete(id); done.add(id);
  };
  for (const id of ids) visit(id);
  exact(manifest.environments, ["staging", "production"], "environments");
  for (const [name, refs, approvals] of [["staging", ["refs/heads/main"], 0], ["production", ["refs/tags/v*"], 1]]) {
    const env = manifest.environments?.[name];
    exact(env, ["allowedRefs", "requiredApprovals"], `environment ${name}`);
    if (JSON.stringify(env?.allowedRefs) !== JSON.stringify(refs)) issues.push(`environment ${name} allowedRefs mismatch`);
    if (env?.requiredApprovals !== approvals) issues.push(`environment ${name} requiredApprovals mismatch`);
  }
  return issues;
}
function context() {
  return {
    exists: (path) => typeof path === "string" && existsSync(join(root, path)),
    scripts: JSON.parse(read("package.json")).scripts,
    wrangler: JSON.parse(read("wrangler.jsonc")),
  };
}
const manifest = () => JSON.parse(read("deployment/application.json"));

test("deployment/application.json is exactly the application-deployment/v1 contract", () => {
  assert.deepEqual(manifestIssues(manifest(), context()), []);
});

test("rejects drift: unknown keys, adapters, cycles, escapes and missing paths", () => {
  const cases = [
    (m) => { m.extra = true; },
    (m) => { m.targets[1].adapter = "shell/v1"; },
    (m) => { m.targets[0].dependsOn = ["prosrus-worker"]; },
    (m) => { m.targets[1].dependsOn = ["missing-target"]; },
    (m) => { m.targets[1].id = "Prosrus_Worker"; },
    (m) => { m.targets[0].build.migrationsDir = "../migrations"; },
    (m) => { m.targets[1].build.entry = "/src/worker.ts"; },
    (m) => { m.targets[1].build.entry = "src/missing.ts"; },
    (m) => { m.targets[1].build.buildCommand = "vite build && rm -rf /"; },
    (m) => { m.targets[1].build.buildCommand = "not-a-script"; },
    (m) => { m.targets[1].healthContract = "http-ok/v1"; },
    (m) => { m.environments.production.requiredApprovals = 0; },
    (m) => { m.repositoryId = 1; },
  ];
  for (const change of cases) {
    const value = manifest();
    change(value);
    assert.notDeepEqual(manifestIssues(value, context()), [], String(change));
  }
});

test("every migration declares a compatibility class and versions strictly increase", () => {
  const names = readdirSync(join(root, "migrations")).filter((n) => n.endsWith(".sql")).sort();
  assert.ok(names.length >= 5);
  let previous = 0;
  for (const name of names) {
    const version = Number(/^(\d{4})/.exec(name)?.[1]);
    assert.ok(version > previous, name);
    previous = version;
    const first = readFileSync(join(root, "migrations", name), "utf8").split("\n")[0];
    assert.match(first, /^-- compatibility: (additive|expand|contract)$/, name);
    assert.notEqual(first, "-- compatibility: contract", `${name}: contract migrations require a reviewed -- requires: header`);
  }
});

test("the release marker helper emits only canonical RELEASE_MARKER binding JSON", () => {
  const commit = "a".repeat(40), digest = "b".repeat(64);
  assert.equal(
    releaseMarkerJson("v1.2.3", commit, digest),
    `{"application":"prosrus","artifactSha256":"${digest}","releaseTag":"v1.2.3","schema":"release-marker/v1","sourceCommit":"${commit}"}`,
  );
  for (const args of [["1.2.3", commit, digest], ["v1.2", commit, digest], ["v01.2.3", commit, digest],
    ["v1.2.3", "A".repeat(40), digest], ["v1.2.3", "0".repeat(40), digest], ["v1.2.3", commit, "0".repeat(64)],
    ["v1.2.3", commit, "b".repeat(63)], ["v1.2.3", commit, undefined]])
    assert.throws(() => releaseMarkerJson(...args), String(args));
  const committedBefore = read("src/release-marker.json");
  const directory = mkdtempSync(join(tmpdir(), "prosrus-marker-"));
  try {
    const out = join(directory, "marker.json"), script = join(root, "scripts/write-release-marker.mjs");
    const printed = spawnSync(process.execPath, [script, "v2.0.0", commit, digest], { encoding: "utf8", timeout: 5000 });
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(JSON.parse(printed.stdout).releaseTag, "v2.0.0");
    const written = spawnSync(process.execPath, [script, "v2.0.0", commit, digest, "--out", out], { encoding: "utf8", timeout: 5000 });
    assert.equal(written.status, 0, written.stderr);
    assert.equal(readFileSync(out, "utf8"), releaseMarkerJson("v2.0.0", commit, digest));
    const bad = spawnSync(process.execPath, [script, "v2.0.0", commit], { encoding: "utf8", timeout: 5000 });
    assert.notEqual(bad.status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(read("src/release-marker.json"), committedBefore);
  assert.equal(JSON.parse(committedBefore).releaseTag, "unreleased");
});
