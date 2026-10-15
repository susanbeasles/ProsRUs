process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
const output = (
  await build({
    stdin: {
      contents:
        "export * from './src/storage/audited-pending-observation';export {planAuditedImport} from './src/application/audited-legacy-import';export {parseAuditedSourceProfile} from './src/application/audited-source-profile';export {fixtureSupplementedInputs,fixtureProfile,fixtureSource} from './tests/fixtures/audited-profile-inputs';export {createRecordReads} from './src/application/record-reads';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  })
).outputFiles[0].text;
await mkdir("artifacts/operator", { recursive: true });
const file = path.resolve("artifacts/operator/kernel-" + Date.now() + ".mjs");
await writeFile(file, output);
const kernel = await import(pathToFileURL(file));
function fixture() {
  const sources = kernel.fixtureSupplementedInputs(),
    main = JSON.parse(new TextDecoder().decode(sources[0].bytes));
  for (let i = 0; i < 17; i++)
    main.digest_listings.push({
      id: "FXMORE" + String(i).padStart(3, "0"),
      company: "Synthetic extension",
      role: "Synthetic role",
    });
  sources[0] = kernel.fixtureSource(sources[0].name, main);
  const profile = kernel.parseAuditedSourceProfile({
    ...kernel.fixtureProfile,
    expectedCounts: {
      ...kernel.fixtureProfile.expectedCounts,
      digest_listings: 136,
    },
  });
  const plan = kernel.planAuditedImport(
    {
      sources,
      workspace: profile.workspace,
      seriesId: profile.seriesId,
      observedAt: 1000,
    },
    profile,
  );
  return { sources, profile, plan };
}
export { kernel, fixture };
test("mandatory immutable operator window/current rejects before any original or D1 effect", async () => {
  assert.equal(typeof kernel.observeOperatorPending, "function");
  const { plan, profile } = fixture();
  let effects = 0;
  const ports = {
    db: {
      prepare() {
        effects++;
        throw Error("unexpected-d1");
      },
    },
    currentWorkspace: async () => {
      effects++;
      return plan.workspace;
    },
    readOriginalCopy: async () => {
      effects++;
      throw Error("unexpected-r2");
    },
  };
  for (const extra of [
    {},
    {
      window: { nowMs: 0, expiresAtMs: Number.MAX_SAFE_INTEGER },
      current: async () => {},
    },
    {
      window: Object.freeze({ nowMs: 5, expiresAtMs: 4 }),
      current: async () => {},
    },
    {
      window: Object.freeze({ nowMs: 0, expiresAtMs: Number.MAX_SAFE_INTEGER }),
    },
  ])
    await assert.rejects(
      kernel.observeOperatorPending({ ...ports, ...extra }, plan, profile),
    );
  assert.equal(effects, 0);
});
test("operator current denial before dispatch has zero storage effects", async () => {
  assert.equal(typeof kernel.observeOperatorPending, "function");
  const { plan, profile } = fixture();
  let effects = 0;
  await assert.rejects(
    kernel.observeOperatorPending(
      {
        db: {
          prepare() {
            effects++;
            throw Error("unexpected");
          },
        },
        currentWorkspace: async () => plan.workspace,
        readOriginalCopy: async () => {
          effects++;
          throw Error("unexpected");
        },
        window: Object.freeze({
          nowMs: 0,
          expiresAtMs: Number.MAX_SAFE_INTEGER,
        }),
        current: async () => {
          throw Error("stopped");
        },
      },
      plan,
      profile,
    ),
    /stopped/,
  );
  assert.equal(effects, 0);
});
