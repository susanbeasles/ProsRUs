# ADR 0003: Release marker from a build-time binding

Status: accepted (2026-10-15)

## Context

The artifact-driven deployer checks `http-release-marker/v1` on the service-only Product. The marker must report the release tag, source commit and the sha256 of the bundled `worker.mjs`; a Worker cannot embed its own digest.

## Decision

- The release builder injects canonical release-marker/v1 JSON as the plain_text binding `RELEASE_MARKER` (optional `Environment` string, not a wrangler var). It is authoritative.
- Default fetch serves only `GET /.well-known/release-marker` (200, `application/json`, `cache-control: no-store`, no cookies or data); every other path is 404. `JobStack.releaseMarker()` returns the same payload for service-binding checks.
- The binding must be canonical JSON (sorted keys, no whitespace or duplicates) with exactly schema, application `prosrus`, a `vMAJOR.MINOR.PATCH` tag, nonzero 40-hex commit and 64-hex digest, and optional UTC `startedAt`; otherwise the route answers 503 `{"error":"release-marker-invalid"}` and the RPC throws, never a guess. Without `startedAt`, the isolate's first observation is reported.
- Only when the binding is absent (local, dev, tests) is the committed placeholder `src/release-marker.json` served with `releaseTag: "unreleased"`. `scripts/write-release-marker.mjs` only prints the canonical binding value.

## Consequences

Health checks distinguish an unreleased build, a valid release and a misconfigured one. The marker value never comes from request data or ordinary environment configuration.
