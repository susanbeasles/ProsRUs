import type { ArchiveReader } from "../application/recovery-ports";
import type { ArchiveMetadataDescriptor } from "../domain/recovery";
import {
  uploadPartReceiptSchema,
  uploadPrefix,
  type UploadPartReceipt,
  type UploadSession,
} from "../domain/recovery-upload";
import { demand } from "../domain/model";
import {
  equalMetadata,
  logicalObject,
  readMetadata,
} from "./recovery-metadata";
import {
  createArtifactHash,
  readArtifact,
  readStreamChunks,
} from "./recovery-streams";

export type ResolvedUploadSession = Readonly<{
  session: UploadSession;
  descriptor: ArchiveMetadataDescriptor;
}>;
export function expectedChunkBytes(
  session: UploadSession,
  ordinal: number,
): number {
  demand(
    Number.isInteger(ordinal) && ordinal >= 0 && ordinal < session.partCount,
    "INVALID_CHUNK_ORDINAL",
  );
  return Math.min(
    session.chunkBytes,
    session.original.sizeBytes - ordinal * session.chunkBytes,
  );
}
export function validatePart(
  part: UploadPartReceipt,
  resolved: ResolvedUploadSession,
  ordinal: number,
): void {
  const { session, descriptor } = resolved;
  demand(
    part.sessionId === session.sessionId &&
      part.actorId === session.actorId &&
      equalMetadata(part.workspace, session.workspace) &&
      equalMetadata(part.session, descriptor) &&
      part.ordinal === ordinal,
    "UPLOAD_PART_CONFLICT",
    409,
  );
  demand(
    part.artifact.sizeBytes === expectedChunkBytes(session, ordinal) &&
      part.artifact.object.provider === "primary" &&
      part.artifact.object.namespace === session.namespace &&
      part.artifact.object.key ===
        `${uploadPrefix(session)}/chunks/${part.artifact.digest}` &&
      part.artifact.object.versionId !== null &&
      part.artifact.mediaType === "application/octet-stream",
    "UPLOAD_PART_CONFLICT",
    409,
  );
}
export async function loadSelectedParts(
  archive: ArchiveReader,
  resolved: ResolvedUploadSession,
): Promise<
  Readonly<{
    parts: readonly UploadPartReceipt[];
    descriptors: readonly ArchiveMetadataDescriptor[];
  }>
> {
  const parts: UploadPartReceipt[] = [];
  const descriptors: ArchiveMetadataDescriptor[] = [];
  for (let ordinal = 0; ordinal < resolved.session.partCount; ordinal++) {
    const object = logicalObject(
      resolved.session.namespace,
      `${uploadPrefix(resolved.session)}/parts/${String(ordinal).padStart(3, "0")}`,
    );
    const stored = await readMetadata(archive, object, "inventory");
    demand(stored, "UPLOAD_INCOMPLETE", 409);
    const part = uploadPartReceiptSchema.parse(stored.value);
    validatePart(part, resolved, ordinal);
    parts.push(part);
    descriptors.push(stored.descriptor);
  }
  return { parts, descriptors };
}

/** Every pass reopens exact physical chunks in selected ordinal order, validating
 * per-chunk identity/count/hash as well as the eventual whole-file identity. */
export function selectedOriginalStream(
  archive: ArchiveReader,
  parts: readonly UploadPartReceipt[],
): ReadableStream<Uint8Array> {
  const cancellation = new AbortController();
  async function* chunks() {
    for (const part of parts) {
      demand(!cancellation.signal.aborted, "STREAM_CANCELLED");
      const read = await readArtifact(archive, part.artifact);
      const digest = createArtifactHash();
      let count = 0;
      for await (const bytes of readStreamChunks(
        read.body,
        cancellation.signal,
      )) {
        count += bytes.length;
        demand(count <= part.artifact.sizeBytes, "INTEGRITY_MISMATCH");
        digest.update(bytes);
        yield bytes;
      }
      demand(
        count === part.artifact.sizeBytes &&
          digest.digest("hex") === part.artifact.digest,
        "INTEGRITY_MISMATCH",
      );
    }
  }
  const iterator = chunks();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        // iterator.return alone queues behind a pending next/read and cannot stop it.
        cancellation.abort();
        await iterator.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );
}
