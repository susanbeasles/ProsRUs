// CI-only: overwrite src/release-marker.json with the exact release identity
// before the Worker bundle is built. It writes one file and executes nothing.
// Usage: node scripts/write-release-marker.mjs <vMAJOR.MINOR.PATCH> <40-hex commit> <64-hex sha256> [--out <path>]
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEMVER = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const COMMIT = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function releaseMarkerJson(releaseTag, sourceCommit, artifactSha256) {
  if (!SEMVER.test(releaseTag ?? "")) throw Error("release tag must be vMAJOR.MINOR.PATCH");
  if (!COMMIT.test(sourceCommit ?? "")) throw Error("source commit must be 40 lowercase hex characters");
  if (!DIGEST.test(artifactSha256 ?? "") || /^0{64}$/.test(artifactSha256))
    throw Error("artifact digest must be a nonzero 64 lowercase hex sha256");
  if (/^0{40}$/.test(sourceCommit)) throw Error("source commit must not be the placeholder");
  // Same key order and encoding as the committed placeholder.
  return JSON.stringify({ schema: "release-marker/v1", application: "prosrus", releaseTag, sourceCommit, artifactSha256 }) + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let out = fileURLToPath(new URL("../src/release-marker.json", import.meta.url));
  const outIndex = args.indexOf("--out");
  if (outIndex !== -1) {
    if (outIndex !== 3 || args.length !== 5 || !args[4]) throw Error("Usage: write-release-marker.mjs <tag> <commit> <sha256> [--out <path>]");
    out = args[4];
    args.splice(3, 2);
  }
  if (args.length !== 3) throw Error("Usage: write-release-marker.mjs <tag> <commit> <sha256> [--out <path>]");
  writeFileSync(out, releaseMarkerJson(...args));
  console.log(`Wrote release marker ${args[0]} for ${args[1]}`);
}
