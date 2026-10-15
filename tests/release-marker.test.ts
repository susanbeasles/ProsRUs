import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RELEASE_MARKER_PATH,
  releaseMarker,
  releaseMarkerResponse,
  releaseMarkerSchema,
} from "../src/release-marker";

describe("http-release-marker/v1", () => {
  it("serves the committed placeholder values with a stable isolate start", async () => {
    const committed = JSON.parse(
      readFileSync("src/release-marker.json", "utf8"),
    );
    expect(committed).toEqual({
      schema: "release-marker/v1",
      application: "prosrus",
      releaseTag: "unreleased",
      sourceCommit: "0".repeat(40),
      artifactSha256: "0".repeat(64),
    });
    const first = releaseMarker(() => 1_800_000_000_000);
    expect(first).toEqual({
      ...committed,
      startedAt: new Date(1_800_000_000_000).toISOString(),
    });
    expect(releaseMarker(() => 1_900_000_000_000).startedAt).toBe(
      first.startedAt,
    );
    const response = releaseMarkerResponse();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual(first);
    expect(RELEASE_MARKER_PATH).toBe("/.well-known/release-marker");
  });
  it("accepts only semver release tags and exact digests", () => {
    const base = {
      schema: "release-marker/v1",
      application: "prosrus",
      releaseTag: "v1.2.3",
      sourceCommit: "a".repeat(40),
      artifactSha256: "b".repeat(64),
    };
    expect(releaseMarkerSchema.parse(base)).toEqual(base);
    for (const change of [
      { releaseTag: "1.2.3" },
      { releaseTag: "v01.2.3" },
      { releaseTag: "v1.2" },
      { sourceCommit: "A".repeat(40) },
      { artifactSha256: "b".repeat(63) },
      { application: "other" },
      { extra: true },
    ])
      expect(() => releaseMarkerSchema.parse({ ...base, ...change })).toThrow();
  });
});
