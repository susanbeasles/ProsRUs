import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

const requiredNodeRange = ">=24 <25";
const requiredCheck = "node --test scripts/test-tooling-policy.mjs";
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function toolingPolicyIssues({ packageJson, packageLock, hasPrettierConfig }) {
  const issues = [];
  if (packageJson.engines?.node !== requiredNodeRange) issues.push("package Node range must be >=24 <25");
  if (packageLock.packages?.[""]?.engines?.node !== requiredNodeRange) issues.push("lock root Node range must be >=24 <25");
  if (packageJson.scripts?.lint !== "eslint src dashboard tests") issues.push("lint must retain the ESLint target paths");
  if (Object.hasOwn(packageJson.scripts ?? {}, "format")) issues.push("the removed format script must stay absent");
  if (Object.values(packageJson.scripts ?? {}).some((command) => /\bprettier\b/i.test(command))) issues.push("scripts must not execute Prettier");
  if (packageJson.scripts?.["check:tooling"] !== requiredCheck) issues.push("the tooling check script must remain wired");
  if (!packageJson.scripts?.verify?.startsWith("npm run check:tooling && ")) issues.push("verify must start with the tooling check");
  for (const [owner, metadata] of [["package", packageJson], ...Object.entries(packageLock.packages ?? {})]) {
    if (owner.endsWith("/prettier")) issues.push(`Prettier lock entry is forbidden: ${owner}`);
    for (const field of dependencyFields) {
      for (const [name, version] of Object.entries(metadata[field] ?? {})) {
        if (name === "prettier" || (typeof version === "string" && version.startsWith("npm:prettier@"))) {
          issues.push(`Prettier dependency is forbidden: ${owner || "lock root"} ${field}.${name}`);
        }
      }
    }
  }
  if (hasPrettierConfig) issues.push("the removed .prettierrc.json must stay absent");
  return issues;
}

function readMetadata(name) {
  const path = new URL(`../${name}`, import.meta.url);
  assert.ok(statSync(path).size <= 1024 * 1024, `${name} exceeds the bounded metadata read`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function validMetadata() {
  return {
    packageJson: {
      engines: { node: requiredNodeRange },
      scripts: {
        lint: "eslint src dashboard tests",
        "check:tooling": requiredCheck,
        verify: "npm run check:tooling && npm run typecheck",
      },
    },
    packageLock: { packages: { "": { engines: { node: requiredNodeRange } } } },
    hasPrettierConfig: false,
  };
}

test("declared source uses Node 24 and ESLint-only tooling", () => {
  assert.deepEqual(toolingPolicyIssues({
    packageJson: readMetadata("package.json"),
    packageLock: readMetadata("package-lock.json"),
    hasPrettierConfig: existsSync(new URL("../.prettierrc.json", import.meta.url)),
  }), []);
});

for (const nodeRange of [">=22", ">=25"]) {
  test(`rejects package execution metadata ${nodeRange}`, () => {
    const metadata = validMetadata();
    metadata.packageJson.engines.node = nodeRange;
    assert.deepEqual(toolingPolicyIssues(metadata), ["package Node range must be >=24 <25"]);
  });
  test(`rejects lock execution metadata ${nodeRange}`, () => {
    const metadata = validMetadata();
    metadata.packageLock.packages[""].engines.node = nodeRange;
    assert.deepEqual(toolingPolicyIssues(metadata), ["lock root Node range must be >=24 <25"]);
  });
}

test("rejects the inherited Prettier format command", () => {
  const metadata = validMetadata();
  metadata.packageJson.scripts.format = "prettier --write src dashboard tests";
  assert.deepEqual(toolingPolicyIssues(metadata), ["the removed format script must stay absent", "scripts must not execute Prettier"]);
});

test("rejects Prettier under another script name", () => {
  const metadata = validMetadata();
  metadata.packageJson.scripts["lint:fix"] = "prettier --write src dashboard tests";
  assert.deepEqual(toolingPolicyIssues(metadata), ["scripts must not execute Prettier"]);
});

for (const field of dependencyFields) {
  test(`rejects a package Prettier ${field} declaration`, () => {
    const metadata = validMetadata();
    metadata.packageJson[field] = { prettier: "3.9.9" };
    assert.deepEqual(toolingPolicyIssues(metadata), [`Prettier dependency is forbidden: package ${field}.prettier`]);
  });
}

test("rejects the inherited lock root Prettier dependency", () => {
  const metadata = validMetadata();
  metadata.packageLock.packages[""].devDependencies = { prettier: "3.9.9" };
  assert.deepEqual(toolingPolicyIssues(metadata), ["Prettier dependency is forbidden: lock root devDependencies.prettier"]);
});

test("rejects a Prettier lock leaf", () => {
  const metadata = validMetadata();
  metadata.packageLock.packages["node_modules/prettier"] = { version: "3.9.9" };
  assert.deepEqual(toolingPolicyIssues(metadata), ["Prettier lock entry is forbidden: node_modules/prettier"]);
});

test("rejects a transitive optional Prettier alias", () => {
  const metadata = validMetadata();
  metadata.packageLock.packages["node_modules/owner"] = { optionalDependencies: { formatter: "npm:prettier@3.9.9" } };
  assert.deepEqual(toolingPolicyIssues(metadata), ["Prettier dependency is forbidden: node_modules/owner optionalDependencies.formatter"]);
});

test("rejects the inherited formatter configuration", () => {
  const metadata = validMetadata();
  metadata.hasPrettierConfig = true;
  assert.deepEqual(toolingPolicyIssues(metadata), ["the removed .prettierrc.json must stay absent"]);
});

test("rejects ESLint target drift", () => {
  const metadata = validMetadata();
  metadata.packageJson.scripts.lint = "eslint src";
  assert.deepEqual(toolingPolicyIssues(metadata), ["lint must retain the ESLint target paths"]);
});

test("rejects removal of the persistent tooling check", () => {
  const metadata = validMetadata();
  delete metadata.packageJson.scripts["check:tooling"];
  metadata.packageJson.scripts.verify = "npm run typecheck";
  assert.deepEqual(toolingPolicyIssues(metadata), ["the tooling check script must remain wired", "verify must start with the tooling check"]);
});
