// Private local subprocess only. No socket, credentials, provider SDK or tool access.
import { readFile, open, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
const [planPath, profilePath, approvalPath] = process.argv.slice(2);
if (
  process.argv.length !== 5 ||
  ![planPath, profilePath, approvalPath].every((p) => p && path.isAbsolute(p))
)
  throw Error(
    "usage: node scripts/run-operator.mjs ABSOLUTE_PLAN ABSOLUTE_PROFILE ABSOLUTE_APPROVAL",
  );
async function bounded(file, limit) {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit)
      throw Error("operator-private-file-bound");
    const buffer = Buffer.alloc(limit + 1);
    let bytes = 0;
    while (bytes <= limit) {
      const result = await handle.read(
        buffer,
        bytes,
        Math.min(48 * 1024, limit + 1 - bytes),
        null,
      );
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    if (bytes > limit) throw Error("operator-private-file-bound");
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(buffer.subarray(0, bytes));
    const value = JSON.parse(text);
    if (JSON.stringify(value) !== text)
      throw Error("operator-noncanonical-private-file");
    return value;
  } finally {
    await handle.close();
  }
}
try {
  const [plan, profile, approval] = await Promise.all([
    bounded(planPath, 8 * 1024 * 1024),
    bounded(profilePath, 5000),
    bounded(approvalPath, 16384),
  ]);
  Object.freeze(approval.window);
  const result = await build({
    stdin: {
      contents:
        "export {prepareOperatorInput,runOperatorImport} from './src/operator/import';export {createPipeExchange} from './src/operator/stdio';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
  });
  // Source-only cache, never plan/profile/approval bytes. Parent verifies its accepted source closure separately.
  await mkdir("artifacts/operator", { recursive: true });
  const file = path.resolve(
    "artifacts/operator/runner-" + process.pid + ".mjs",
  );
  await writeFile(file, result.outputFiles[0].text);
  const { prepareOperatorInput, runOperatorImport, createPipeExchange } =
    await import(pathToFileURL(file));
  const prepared = prepareOperatorInput({ plan, profile, approval }),
    input = process.stdin;
  const pipe = createPipeExchange(
    input,
    process.stdout,
    approval.window.expiresAtMs,
  );
  process.once("SIGTERM", () => pipe.stop());
  process.once("SIGINT", () => pipe.stop());
  await runOperatorImport(prepared, pipe.exchange);
  input.destroy();
} catch {
  process.stderr.write(
    "operator-stopped; inspect the parent retained settlement receipt\n",
  );
  process.exitCode = 1;
}
