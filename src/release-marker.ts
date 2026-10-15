import { z } from "zod";
import committed from "./release-marker.json";

/** `http-release-marker/v1` health contract. Values are fixed at build time in
 * release-marker.json (written by scripts/write-release-marker.mjs in CI); none
 * comes from env. `startedAt` is this isolate's first observation, taken lazily
 * because Workers global-scope clocks are not request time. */
export const RELEASE_MARKER_PATH = "/.well-known/release-marker";
export const releaseMarkerSchema = z
  .object({
    schema: z.literal("release-marker/v1"),
    application: z.literal("prosrus"),
    releaseTag: z
      .string()
      .regex(/^(?:unreleased|v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ReleaseMarker = z.infer<typeof releaseMarkerSchema> &
  Readonly<{ startedAt: string }>;
let startedAt: string | null = null;
export function releaseMarker(now: () => number = Date.now): ReleaseMarker {
  const marker = releaseMarkerSchema.parse(committed);
  startedAt ??= new Date(now()).toISOString();
  return { ...marker, startedAt };
}
/** Public, data-free health response: no auth, cookies or caching. */
export function releaseMarkerResponse(): Response {
  return new Response(JSON.stringify(releaseMarker()), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
