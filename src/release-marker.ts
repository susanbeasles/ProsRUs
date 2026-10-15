import { z } from "zod";
import { canonicalJson } from "../integration/shared-contract.mjs";
import committed from "./release-marker.json";

/** `http-release-marker/v1` health contract. The release builder injects the
 * authoritative marker as the plain_text binding `RELEASE_MARKER` (canonical
 * JSON; artifactSha256 is the bundled worker.mjs digest, which a Worker cannot
 * embed in itself). Only when the binding is absent (local/dev/tests) is the
 * committed placeholder served, reporting `releaseTag: "unreleased"`. A
 * present but malformed binding is never guessed around: it is invalid. */
export const RELEASE_MARKER_PATH = "/.well-known/release-marker";
const SEMVER =
  /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const fields = {
  schema: z.literal("release-marker/v1"),
  application: z.literal("prosrus"),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
};
/** The committed fallback: exactly the placeholder identity. */
export const placeholderMarkerSchema = z
  .object({
    ...fields,
    releaseTag: z.literal("unreleased"),
    sourceCommit: z.literal("0".repeat(40)),
    artifactSha256: z.literal("0".repeat(64)),
  })
  .strict();
/** The injected binding: a real release identity, optional builder start time. */
export const boundMarkerSchema = z
  .object({
    ...fields,
    releaseTag: z.string().regex(SEMVER),
    startedAt: z.iso.datetime({ offset: false }).optional(),
  })
  .strict()
  .refine(
    (m) => !/^0+$/.test(m.sourceCommit) && !/^0+$/.test(m.artifactSha256),
    "RELEASE_MARKER_PLACEHOLDER",
  );
export type ReleaseMarker = Readonly<{
  schema: "release-marker/v1";
  application: "prosrus";
  releaseTag: string;
  sourceCommit: string;
  artifactSha256: string;
  startedAt: string;
}>;
const MAX_BINDING_BYTES = 1024;
let isolateStartedAt: string | null = null;

/** Strict marker resolution; throws `release-marker-invalid` on any defect. */
export function releaseMarker(
  binding: string | undefined,
  now: () => number = Date.now,
): ReleaseMarker {
  // Workers global-scope clocks are not request time; observe lazily.
  isolateStartedAt ??= new Date(now()).toISOString();
  if (binding === undefined)
    return {
      ...placeholderMarkerSchema.parse(committed),
      startedAt: isolateStartedAt,
    };
  try {
    if (typeof binding !== "string" || binding.length > MAX_BINDING_BYTES)
      throw Error();
    const raw: unknown = JSON.parse(binding);
    const marker = boundMarkerSchema.parse(raw);
    // Canonical JSON only (sorted keys, no whitespace, no duplicate keys).
    if (canonicalJson(raw) !== binding) throw Error();
    return { ...marker, startedAt: marker.startedAt ?? isolateStartedAt };
  } catch {
    throw Error("release-marker-invalid");
  }
}
/** Public, data-free health response: no auth, cookies or caching. */
export function releaseMarkerResponse(binding: string | undefined): Response {
  const headers = {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  try {
    return new Response(JSON.stringify(releaseMarker(binding)), {
      status: 200,
      headers,
    });
  } catch {
    return new Response(JSON.stringify({ error: "release-marker-invalid" }), {
      status: 503,
      headers,
    });
  }
}
