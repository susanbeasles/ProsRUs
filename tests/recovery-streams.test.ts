import { describe, expect, it } from "vitest";
import { hashArtifact } from "../src/domain/recovery-canonical";
import {
  inspectArtifactStream,
  readBoundedBytes,
  openVerifiedArtifact,
} from "../src/storage/recovery-streams";

function stream(bytes: Uint8Array, stride = 3) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(offset + stride, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

describe("bounded exact-original stream reads", () => {
  it.each([new Uint8Array(), new Uint8Array([0, 13, 10, 255, 128, 27, 0])])(
    "uses the exact existing domain hash, including empty bytes",
    async (bytes) => {
      const inspected = await inspectArtifactStream(
        stream(bytes),
        bytes.length,
      );
      expect(inspected.digest).toBe(await hashArtifact(bytes));
      expect(inspected.sizeBytes).toBe(bytes.length);
      expect(inspected.rawSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(inspected.rawSha256).not.toBe(inspected.digest);
    },
  );
  it.each([2, 4])(
    "rejects an actual length different from expected %s",
    async (expected) => {
      await expect(
        inspectArtifactStream(stream(new Uint8Array(3)), expected),
      ).rejects.toThrow("STREAM_LENGTH_MISMATCH");
    },
  );
  it("cancels an oversized source instead of draining it", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readBoundedBytes(body, 7)).rejects.toThrow("BODY_TOO_LARGE");
    expect(cancelled).toBe(true);
  });
  it("preserves every exact original byte in a bounded read", async () => {
    const bytes = new Uint8Array([0, 255, 13, 10, 128]);
    expect(await readBoundedBytes(stream(bytes), 5, 5)).toEqual(bytes);
    await expect(readBoundedBytes(stream(bytes), 6, 6)).rejects.toThrow(
      "STREAM_LENGTH_MISMATCH",
    );
  });
  it("exports a pinned two-read capability for later authorized downloads", () => {
    expect(openVerifiedArtifact).toBeTypeOf("function");
  });
});

describe("verified download pinning", () => {
  const object = {
    provider: "primary" as const,
    namespace: "recovery",
    key: "blobs/test",
    versionId: "original",
  };
  it("fully verifies first read before opening the exact same physical identity again", async () => {
    const bytes = new Uint8Array([17, 0, 99]);
    let reads = 0;
    let finished = false;
    const archive = {
      getStream: async () => {
        reads += 1;
        if (reads === 2) expect(finished).toBe(true);
        return {
          object,
          sizeBytes: 3,
          mediaType: "application/octet-stream",
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
              finished = true;
            },
          }),
        };
      },
    };
    const descriptor = {
      schemaVersion: 1 as const,
      hashAlgorithm: "sha256-domain-v1" as const,
      digest: await hashArtifact(bytes),
      sizeBytes: 3,
      mediaType: "application/octet-stream",
      object,
    };
    const result = await openVerifiedArtifact(archive, descriptor);
    expect(reads).toBe(2);
    expect(await readBoundedBytes(result.body, 3)).toEqual(bytes);
  });
  it("refuses a changed provider identity on the second read", async () => {
    const bytes = new Uint8Array([1]);
    let reads = 0;
    const archive = {
      getStream: async () => ({
        object: {
          ...object,
          versionId: ++reads === 1 ? "original" : "replacement",
        },
        sizeBytes: 1,
        mediaType: "application/octet-stream",
        body: stream(bytes),
      }),
    };
    await expect(
      openVerifiedArtifact(archive, {
        schemaVersion: 1,
        hashAlgorithm: "sha256-domain-v1",
        digest: await hashArtifact(bytes),
        sizeBytes: 1,
        mediaType: "application/octet-stream",
        object,
      }),
    ).rejects.toThrow("ARCHIVE_IDENTITY_MISMATCH");
  });
  it("never opens a delivery stream after corrupt first-read bytes", async () => {
    let reads = 0;
    const archive = {
      getStream: async () => {
        reads++;
        return {
          object,
          sizeBytes: 1,
          mediaType: "application/octet-stream",
          body: stream(new Uint8Array([2])),
        };
      },
    };
    await expect(
      openVerifiedArtifact(archive, {
        schemaVersion: 1,
        hashAlgorithm: "sha256-domain-v1",
        digest: await hashArtifact(new Uint8Array([1])),
        sizeBytes: 1,
        mediaType: "application/octet-stream",
        object,
      }),
    ).rejects.toThrow("INTEGRITY_MISMATCH");
    expect(reads).toBe(1);
  });
});

import { selectedOriginalStream } from "../src/storage/recovery-upload-inventory";
import type { UploadPartReceipt } from "../src/domain/recovery-upload";

it("cancels the active pinned chunk even while selected-original readback is stalled", async () => {
  let cancelled = false;
  let unblock: () => void = () => undefined;
  let opened: () => void = () => undefined;
  const reading = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const object = {
    provider: "primary" as const,
    namespace: "recovery",
    key: "blobs/stalled",
    versionId: "pinned",
  };
  const source = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        unblock = () => controller.close();
      },
      pull() {
        opened();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const part: UploadPartReceipt = {
    formatVersion: 1,
    type: "upload_part",
    sessionId: "session",
    workspace: { ownerId: "owner", workspaceId: "workspace" },
    actorId: "actor",
    ordinal: 0,
    requestKey: "part",
    session: {
      formatVersion: 1,
      hashPurpose: "inventory",
      digest: "0".repeat(64),
      sizeBytes: 1,
      mediaType: "application/json",
      object,
    },
    artifact: {
      schemaVersion: 1,
      hashAlgorithm: "sha256-domain-v1",
      digest: "0".repeat(64),
      sizeBytes: 1,
      mediaType: "application/octet-stream",
      object,
    },
  };
  const archive = {
    get: async () => null,
    list: async () => ({ items: [], nextCursor: null }),
    getStream: async () => ({
      object,
      body: source,
      sizeBytes: 1,
      mediaType: "application/octet-stream",
    }),
  };
  const reader = selectedOriginalStream(archive, [part]).getReader();
  const pendingRead = reader.read();
  await reading;
  const stopped = reader.cancel();
  const outcome = await Promise.race([
    stopped.then(() => "cancelled"),
    new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 30)),
  ]);
  const observedCancellation = cancelled;
  if (outcome === "timeout") unblock();
  await Promise.allSettled([pendingRead, stopped]);
  reader.releaseLock();
  expect(outcome).toBe("cancelled");
  expect(observedCancellation).toBe(true);
});
