// Optional helper: print (or write with --out) the canonical release-marker/v1
// JSON a release builder injects as the plain_text RELEASE_MARKER binding. It
// never modifies src/release-marker.json (the committed "unreleased" fallback the
// Worker serves only when the binding is absent) and executes nothing.
// Usage: node scripts/write-release-marker.mjs <vMAJOR.MINOR.PATCH> <40-hex commit> <64-hex worker.mjs sha256> [--out <path>]
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEMVER = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const COMMIT = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;

/** Canonical JSON (sorted keys, no whitespace), exactly what the Worker accepts. */
export function releaseMarkerJson(releaseTag, sourceCommit, artifactSha256) {
  if (!SEMVER.test(releaseTag ?? "")) throw Error("release tag must be vMAJOR.MINOR.PATCH");
  if (!COMMIT.test(sourceCommit ?? "") || /^0{40}$/.test(sourceCommit))
    throw Error("source commit must be a nonzero 40 lowercase hex commit");
  if (!DIGEST.test(artifactSha256 ?? "") || /^0{64}$/.test(artifactSha256))
    throw Error("artifact digest must be a nonzero 64 lowercase hex sha256");
  const marker = { application: "prosrus", artifactSha256, releaseTag, schema: "release-marker/v1", sourceCommit };
  return JSON.stringify(marker);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const usage = "Usage: write-release-marker.mjs <tag> <commit> <sha256> [--out <path>]";
  let out = null;
  if (args.length === 5 && args[3] === "--out" && args[4]) out = args.splice(3, 2)[1];
  if (args.length !== 3) throw Error(usage);
  const value = releaseMarkerJson(...args);
  if (out === null) process.stdout.write(value + "\n");
  else writeFileSync(out, value);
}
