import { createHash } from "node:crypto";
import type {
  ArchiveReader,
  ArchiveStreamReadResult,
} from "../application/recovery-ports";
import { demand } from "../domain/model";
import {
  blobDescriptorSchema,
  type ArchiveObjectRef,
  type BlobDescriptor,
} from "../domain/recovery";
import {
  RECOVERY_HASH_ALGORITHM,
  RECOVERY_SCHEMA_VERSION,
} from "../domain/recovery-canonical";

import {
  STREAM_READ_BYTES,
  MAX_ARCHIVE_BYTES,
  MAX_ORIGINAL_BYTES,
} from "../domain/recovery-limits";
export {
  STREAM_READ_BYTES,
  MAX_ARCHIVE_BYTES,
  MAX_ORIGINAL_BYTES,
} from "../domain/recovery-limits";
const blobPrefix = `job-stack-recovery/${RECOVERY_SCHEMA_VERSION}/${RECOVERY_HASH_ALGORITHM}/blob\0`;

/** One bounded reader, no tee. Native byte streams use BYOB; small trusted synthetic
 * streams use a default reader. Cancellation propagates when a consumer stops early. */
export async function* readStreamChunks(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let reader:
    ReadableStreamBYOBReader | ReadableStreamDefaultReader<Uint8Array>;
  let byob = false;
  try {
    reader = body.getReader({ mode: "byob" });
    byob = true;
  } catch {
    reader = body.getReader();
  }
  let complete = false;
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      if (byob) {
        // Workerd's BYOB extension is absent from the DOM library used by Node tests.
        const byteReader = reader as ReadableStreamBYOBReader & {
          readAtLeast?: (
            minimum: number,
            view: Uint8Array,
          ) => Promise<ReadableStreamReadResult<Uint8Array>>;
        };
        const buffer = new Uint8Array(STREAM_READ_BYTES);
        next =
          typeof byteReader.readAtLeast === "function"
            ? await byteReader.readAtLeast(STREAM_READ_BYTES, buffer)
            : await byteReader.read(buffer);
      } else
        next = await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
      demand(!signal?.aborted, "STREAM_CANCELLED");
      if (next.value?.byteLength) yield next.value;
      if (next.done) {
        complete = true;
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createArtifactHash() {
  return createHash("sha256").update(blobPrefix);
}

export function artifactDigest(bytes: Uint8Array): string {
  return createArtifactHash().update(bytes).digest("hex");
}

export async function inspectArtifactStream(
  body: ReadableStream<Uint8Array>,
  expectedSizeBytes: number,
): Promise<Readonly<{ digest: string; rawSha256: string; sizeBytes: number }>> {
  demand(
    Number.isSafeInteger(expectedSizeBytes) &&
      expectedSizeBytes >= 0 &&
      expectedSizeBytes <= MAX_ORIGINAL_BYTES,
    "INVALID_ORIGINAL_SIZE",
  );
  const digest = createHash("sha256").update(blobPrefix);
  const raw = createHash("sha256");
  let sizeBytes = 0;
  for await (const bytes of readStreamChunks(body)) {
    sizeBytes += bytes.byteLength;
    demand(sizeBytes <= expectedSizeBytes, "STREAM_LENGTH_MISMATCH");
    digest.update(bytes);
    raw.update(bytes);
  }
  demand(sizeBytes === expectedSizeBytes, "STREAM_LENGTH_MISMATCH");
  return {
    digest: digest.digest("hex"),
    rawSha256: raw.digest("hex"),
    sizeBytes,
  };
}

export async function readBoundedBytes(
  body: ReadableStream<Uint8Array>,
  limit: number,
  expectedSizeBytes?: number,
): Promise<Uint8Array> {
  demand(
    Number.isSafeInteger(limit) && limit >= 0 && limit <= MAX_ARCHIVE_BYTES,
    "INVALID_BYTE_LIMIT",
  );
  demand(
    expectedSizeBytes === undefined ||
      (Number.isSafeInteger(expectedSizeBytes) &&
        expectedSizeBytes >= 0 &&
        expectedSizeBytes <= limit),
    "INVALID_BYTE_LIMIT",
  );
  const bytes = new Uint8Array(expectedSizeBytes ?? limit);
  let offset = 0;
  for await (const chunk of readStreamChunks(body)) {
    demand(offset + chunk.byteLength <= limit, "BODY_TOO_LARGE");
    demand(offset + chunk.byteLength <= bytes.length, "STREAM_LENGTH_MISMATCH");
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  demand(
    expectedSizeBytes === undefined || offset === expectedSizeBytes,
    "STREAM_LENGTH_MISMATCH",
  );
  return offset === bytes.length ? bytes : bytes.slice(0, offset);
}

export function sameArchiveObject(
  left: ArchiveObjectRef,
  right: ArchiveObjectRef,
): boolean {
  return (
    left.provider === right.provider &&
    left.namespace === right.namespace &&
    left.key === right.key &&
    left.versionId === right.versionId
  );
}

export async function readArtifact(
  archive: Pick<ArchiveReader, "getStream">,
  descriptor: BlobDescriptor,
): Promise<ArchiveStreamReadResult> {
  blobDescriptorSchema.parse(descriptor);
  demand(descriptor.object.versionId !== null, "ARCHIVE_IDENTITY_REQUIRED");
  const read = await archive.getStream(descriptor.object);
  demand(read, "ARCHIVE_OBJECT_MISSING");
  if (
    !sameArchiveObject(read.object, descriptor.object) ||
    read.sizeBytes !== descriptor.sizeBytes
  ) {
    await read.body.cancel().catch(() => undefined);
    demand(
      sameArchiveObject(read.object, descriptor.object),
      "ARCHIVE_IDENTITY_MISMATCH",
    );
    demand(false, "INTEGRITY_MISMATCH");
  }
  return read;
}

export async function verifyArtifact(
  archive: Pick<ArchiveReader, "getStream">,
  descriptor: BlobDescriptor,
): Promise<void> {
  const read = await readArtifact(archive, descriptor);
  const inspected = await inspectArtifactStream(
    read.body,
    descriptor.sizeBytes,
  );
  demand(inspected.digest === descriptor.digest, "INTEGRITY_MISMATCH");
}

/** Authorize before calling. Fully verify a pinned read, then reopen that identity.
 * Same-version/provider or transit corruption on the delivery read remains possible;
 * callers needing stronger assurance must also verify at the receiving client. */
export async function openVerifiedArtifact(
  archive: Pick<ArchiveReader, "getStream">,
  descriptor: BlobDescriptor,
): Promise<ArchiveStreamReadResult> {
  await verifyArtifact(archive, descriptor);
  return readArtifact(archive, descriptor);
}
