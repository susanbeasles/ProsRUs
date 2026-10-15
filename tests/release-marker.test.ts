import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RELEASE_MARKER_PATH,
  releaseMarker,
  releaseMarkerResponse,
} from "../src/release-marker";

const commit = "a".repeat(40),
  digest = "b".repeat(64);
/** Canonical JSON exactly as the release builder injects RELEASE_MARKER. */
function binding(extra: Record<string, unknown> = {}) {
  const value: Record<string, unknown> = {
    schema: "release-marker/v1",
    application: "prosrus",
    releaseTag: "v1.2.3",
    sourceCommit: commit,
    artifactSha256: digest,
    ...extra,
  };
  return JSON.stringify(
    Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]])),
  );
}

describe("http-release-marker/v1", () => {
  it("serves the committed unreleased placeholder only when the binding is absent", async () => {
    const committed = JSON.parse(readFileSync("src/release-marker.json", "utf8"));
    expect(committed).toEqual({
      schema: "release-marker/v1",
      application: "prosrus",
      releaseTag: "unreleased",
      sourceCommit: "0".repeat(40),
      artifactSha256: "0".repeat(64),
    });
    const first = releaseMarker(undefined, () => 1_800_000_000_000);
    expect(first).toEqual({ ...committed, startedAt: first.startedAt });
    expect(Date.parse(first.startedAt)).not.toBeNaN();
    expect(releaseMarker(undefined, () => 1_900_000_000_000).startedAt).toBe(
      first.startedAt,
    );
    const response = releaseMarkerResponse(undefined);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual(first);
    expect(RELEASE_MARKER_PATH).toBe("/.well-known/release-marker");
  });

  it("treats a present binding as authoritative", async () => {
    const isolate = releaseMarker(undefined).startedAt;
    expect(releaseMarker(binding())).toEqual({
      schema: "release-marker/v1",
      application: "prosrus",
      releaseTag: "v1.2.3",
      sourceCommit: commit,
      artifactSha256: digest,
      startedAt: isolate,
    });
    const started = "2026-10-15T00:00:00.000Z";
    expect(releaseMarker(binding({ startedAt: started })).startedAt).toBe(started);
    const response = releaseMarkerResponse(binding());
    expect(response.status).toBe(200);
    expect((await response.json()).releaseTag).toBe("v1.2.3");
  });

  it("answers 503 release-marker-invalid for any malformed binding, never a guess", async () => {
    const canonical = binding();
    for (const value of [
      "",
      "not json",
      canonical.replace("{", "{ "),
      JSON.stringify({ ...JSON.parse(canonical) }, null, 1),
      `{"schema":"release-marker/v1",${canonical.slice(1)}`,
      binding({ releaseTag: "unreleased" }),
      binding({ releaseTag: "1.2.3" }),
      binding({ sourceCommit: "0".repeat(40) }),
      binding({ artifactSha256: "0".repeat(64) }),
      binding({ artifactSha256: "B".repeat(64) }),
      binding({ application: "other" }),
      binding({ extra: true }),
      binding({ startedAt: "yesterday" }),
      binding({ startedAt: "2026-10-15T00:00:00+02:00" }),
      `${canonical}${" ".repeat(1024)}`,
    ]) {
      expect(() => releaseMarker(value), value).toThrow("release-marker-invalid");
      const response = releaseMarkerResponse(value);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "release-marker-invalid" });
    }
  });
});
