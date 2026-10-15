import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const target = "integration/shared-contract.mjs";
const sourceFiles = [
  "src/domain/recovery.ts",
  "src/domain/recovery-domain-plan.ts",
  "src/domain/recovery-record.ts",
  "src/domain/model.ts",
  "src/domain/profile-field.ts",
  "src/domain/targeting-profile.ts",
];
const hashes = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (path) => [
      path,
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    ]),
  ),
);
const schemaNames = [
  "versionManifestSchema",
  "saveVersionResultSchema",
  "protectionViewSchema",
  "archiveObjectRefSchema",
  "workspaceChainSchema",
  "preparedEnvelopeSchema",
  "preparedEnvelopePayloadSchema",
  "commitCertificateSchema",
];
await mkdir("artifacts", { recursive: true });
await build({
  stdin: {
    contents: `import {z} from 'zod';import * as recovery from './src/domain/recovery';export const schemas=Object.fromEntries(${JSON.stringify(schemaNames)}.map(key=>[key,z.toJSONSchema(recovery[key],{unrepresentable:'any',reused:'inline',cycles:'throw'})]));`,
    resolveDir: process.cwd(),
    sourcefile: "recovery-schema-extraction.ts",
  },
  outfile: "artifacts/recovery-schema-extraction.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
});
const { schemas } = await import(
  pathToFileURL(resolve("artifacts/recovery-schema-extraction.mjs")).href
);
// JSON object keys are already scalar strings in the shared decoder. Zod's
// unconstrained propertyNames annotation adds no validation; keep constrained
// property-name schemas unsupported rather than silently dropping a rule.
function inlineSupportedProjection(value) {
  if (!value || typeof value !== "object") return;
  if (Object.hasOwn(value, "propertyNames")) {
    if (JSON.stringify(value.propertyNames) !== '{"type":"string"}')
      throw Error("UNSUPPORTED_PROPERTY_NAME_CONSTRAINT");
    delete value.propertyNames;
  }
  for (const child of Object.values(value))
    if (Array.isArray(child)) child.forEach(inlineSupportedProjection);
    else inlineSupportedProjection(child);
}
inlineSupportedProjection(schemas);
const source = await readFile(target, "utf8");
const line = /const legacyRecoverySchemas=freeze\(.*\);/;
if (!line.test(source)) throw Error("MISSING_GENERATED_RECOVERY_SCHEMA_SLOT");
let next = source.replace(
  line,
  () => `const legacyRecoverySchemas=freeze(${JSON.stringify(schemas)});`,
);
const marker =
  /\/\/ (?:Frozen from reviewed Task3 contracts, manifest SHA-256 [a-f0-9]+\.|Generated recovery schema projection\. Source hashes: .*\.)/;
if (!marker.test(next)) throw Error("MISSING_GENERATED_RECOVERY_SCHEMA_MARKER");
next = next.replace(
  marker,
  () =>
    `// Generated recovery schema projection. Source hashes: ${JSON.stringify(hashes)}.`,
);
const inert = /export const INERT_KINDS=freeze\(\[([^\]]+)\]\);/;
const match = inert.exec(next);
if (!match) throw Error("MISSING_ARCHIVAL_KIND_SLOT");
const existing = match[1].split(",").map((value) => value.trim().slice(1, -1));
const allowed = ["offer", "question", "reminder"];
for (const kind of allowed)
  if (!schemas.versionManifestSchema.properties.kind.enum.includes(kind))
    throw Error("MISSING_DOMAIN_ARCHIVAL_KIND");
const kinds = [...new Set([...existing, ...allowed])];
next = next.replace(
  inert,
  () => `export const INERT_KINDS=freeze(${JSON.stringify(kinds)});`,
);
if (process.argv.includes("--check")) {
  if (next !== source) throw Error("GENERATED_RECOVERY_SCHEMA_DRIFT");
} else await writeFile(target, next);
await writeFile(
  "artifacts/recovery-schema-source-hashes.json",
  JSON.stringify(hashes, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    mode: process.argv.includes("--check") ? "checked" : "generated",
    sourceFiles: hashes,
    sharedSha256: createHash("sha256").update(next).digest("hex"),
    schemaBytes: JSON.stringify(schemas).length,
    archivalKindsAdded: allowed,
  }),
);
