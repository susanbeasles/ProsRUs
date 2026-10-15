import { createHash } from "node:crypto";
import type {
  ArchivePutInput,
  ArchivePutResult,
  ArchiveStreamPutInput,
  ArchiveStreamReadResult,
  PrimaryArchive,
} from "../application/recovery-ports";
import { demand, DomainError } from "../domain/model";
import {
  archiveObjectRefSchema,
  type ArchiveObjectRef,
} from "../domain/recovery";
import {
  canonicalizeEnvelope,
  hashEnvelope,
  MAX_ENVELOPE_BYTES,
  parseEnvelopeJson,
} from "../domain/recovery-canonical";
import {
  artifactDigest,
  createArtifactHash,
  MAX_ARCHIVE_BYTES,
  MAX_ORIGINAL_BYTES,
  readBoundedBytes,
  inspectArtifactStream,
  readStreamChunks,
} from "./recovery-streams";

function storageKey(object: ArchiveObjectRef): string {
  archiveObjectRefSchema.parse(object);
  demand(object.provider === "primary", "WRONG_ARCHIVE_PROVIDER");
  return `${object.namespace}/${object.key}`;
}

async function verifyBytes(
  input: ArchivePutInput,
  bytes: Uint8Array,
): Promise<void> {
  if (input.hashPurpose === "blob") {
    demand(artifactDigest(bytes) === input.digest, "INTEGRITY_MISMATCH");
    return;
  }
  demand(bytes.length <= MAX_ENVELOPE_BYTES, "ENVELOPE_TOO_LARGE");
  const parsed = parseEnvelopeJson(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
  );
  const canonical = canonicalizeEnvelope(parsed);
  demand(
    canonical.length === bytes.length &&
      canonical.every((byte, index) => byte === bytes[index]),
    "NONCANONICAL_ARCHIVE_METADATA",
  );
  demand(
    (await hashEnvelope(input.hashPurpose, parsed)) === input.digest,
    "INTEGRITY_MISMATCH",
  );
}

/** Maps a pinned upload version to the version an operator restore created for
 * the same key (ADR 0004). Returns null when the identity was never restored. */
export type RestoredVersionResolver = (
  storageKey: string,
  versionId: string,
) => Promise<string | null>;

/** A private binding adapter. Callers supply trusted namespace/resource authorization;
 * this does not grant owner access. No delete, overwrite, generic fetch or signing port. */
export function createPrimaryArchive(
  bucket: R2Bucket,
  restored: RestoredVersionResolver | null = null,
): PrimaryArchive {
  async function getStream(
    object: ArchiveObjectRef,
  ): Promise<ArchiveStreamReadResult | null> {
    const key = storageKey(object);
    const read = await bucket.get(key);
    if (read === null) return null;
    // A restored object keeps its pinned logical identity only through an
    // immutable restore alias; callers still verify its content digest.
    const aliased =
      read.key === key &&
      object.versionId !== null &&
      object.versionId !== read.version &&
      restored !== null &&
      (await restored(key, object.versionId)) === read.version;
    if (
      read.key !== key ||
      (object.versionId !== null && object.versionId !== read.version && !aliased)
    ) {
      await read.body.cancel().catch(() => undefined);
      throw new DomainError("ARCHIVE_IDENTITY_MISMATCH");
    }
    if (
      !Number.isSafeInteger(read.size) ||
      read.size < 0 ||
      read.size > MAX_ORIGINAL_BYTES
    ) {
      await read.body.cancel().catch(() => undefined);
      throw new DomainError("INVALID_ORIGINAL_SIZE");
    }
    return {
      object: archiveObjectRefSchema.parse({
        ...object,
        versionId: aliased ? object.versionId : read.version,
      }),
      sizeBytes: read.size,
      mediaType: read.httpMetadata?.contentType ?? "application/octet-stream",
      body: read.body,
    };
  }
  async function get(object: ArchiveObjectRef) {
    const read = await getStream(object);
    if (!read) return null;
    if (read.sizeBytes > MAX_ARCHIVE_BYTES) {
      await read.body.cancel().catch(() => undefined);
      throw new DomainError("BYTE_API_LIMIT_EXCEEDED");
    }
    return {
      object: read.object,
      bytes: await readBoundedBytes(
        read.body,
        MAX_ARCHIVE_BYTES,
        read.sizeBytes,
      ),
    };
  }
  async function putImmutable(
    input: ArchivePutInput,
  ): Promise<ArchivePutResult> {
    const key = storageKey(input.object);
    demand(input.object.versionId === null, "WRITE_REQUIRES_LOGICAL_IDENTITY");
    demand(
      input.bytes.byteLength <= MAX_ARCHIVE_BYTES,
      "BYTE_API_LIMIT_EXCEEDED",
    );
    await verifyBytes(input, input.bytes);
    let created: R2Object | null = null;
    let failed = false;
    try {
      created = await bucket.put(key, input.bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: {
          contentType:
            input.hashPurpose === "blob"
              ? "application/octet-stream"
              : "application/json",
        },
      });
    } catch {
      failed = true;
    }
    const read = await get({
      ...input.object,
      versionId: created?.version ?? null,
    });
    demand(read, failed ? "PRIMARY_WRITE_FAILED" : "ARCHIVE_OBJECT_MISSING");
    demand(
      read.bytes.length === input.bytes.length &&
        read.bytes.every((byte, index) => byte === input.bytes[index]),
      "INTEGRITY_MISMATCH",
    );
    await verifyBytes(input, read.bytes);
    return {
      object: read.object,
      outcome: created ? "created" : "matched_existing",
    };
  }
  async function verifyStoredStream(
    object: ArchiveObjectRef,
    input: ArchiveStreamPutInput,
  ): Promise<ArchiveObjectRef> {
    const read = await getStream(object);
    demand(read, "ARCHIVE_OBJECT_MISSING");
    if (read.sizeBytes !== input.sizeBytes) {
      await read.body.cancel().catch(() => undefined);
      throw new DomainError("INTEGRITY_MISMATCH");
    }
    const inspected = await inspectArtifactStream(read.body, input.sizeBytes);
    demand(
      inspected.digest === input.digest &&
        inspected.rawSha256 === input.transportSha256,
      "INTEGRITY_MISMATCH",
    );
    return read.object;
  }
  async function putImmutableStream(
    input: ArchiveStreamPutInput,
  ): Promise<ArchivePutResult> {
    const key = storageKey(input.object);
    demand(input.object.versionId === null, "WRITE_REQUIRES_LOGICAL_IDENTITY");
    demand(
      input.hashPurpose === "blob" &&
        /^[a-f0-9]{64}$/.test(input.digest) &&
        /^[a-f0-9]{64}$/.test(input.transportSha256),
      "INVALID_STREAM_DIGEST",
    );
    demand(
      Number.isSafeInteger(input.sizeBytes) &&
        input.sizeBytes >= 0 &&
        input.sizeBytes <= MAX_ORIGINAL_BYTES,
      "INVALID_ORIGINAL_SIZE",
    );
    // A preflight is only an optimization. Creation itself remains atomic/create-only.
    if (await bucket.head(key)) {
      const source = await inspectArtifactStream(input.body, input.sizeBytes);
      demand(
        source.digest === input.digest &&
          source.rawSha256 === input.transportSha256,
        "INTEGRITY_MISMATCH",
      );
      return {
        object: await verifyStoredStream(input.object, input),
        outcome: "matched_existing",
      };
    }
    const fixed = new FixedLengthStream(input.sizeBytes);
    const writer = fixed.writable.getWriter();
    const cancellation = new AbortController();
    let sinkSkipped = false;
    let sinkFailed = false;
    const pump = (async () => {
      let count = 0;
      const digest = createArtifactHash();
      const raw = createHash("sha256");
      try {
        for await (const bytes of readStreamChunks(
          input.body,
          cancellation.signal,
        )) {
          count += bytes.length;
          digest.update(bytes);
          raw.update(bytes);
          demand(count <= input.sizeBytes, "STREAM_LENGTH_MISMATCH");
          demand(!sinkFailed, "PRIMARY_WRITE_FAILED");
          if (!sinkSkipped) {
            try {
              await writer.write(bytes);
            } catch (error) {
              if (!sinkSkipped) throw error;
            }
          }
        }
        demand(count === input.sizeBytes, "STREAM_LENGTH_MISMATCH");
        demand(
          digest.digest("hex") === input.digest &&
            raw.digest("hex") === input.transportSha256,
          "INTEGRITY_MISMATCH",
        );
        if (!sinkSkipped) await writer.close();
      } catch (error) {
        await writer.abort(error).catch(() => undefined);
        throw error;
      } finally {
        writer.releaseLock();
      }
    })();
    const sink = bucket
      .put(key, fixed.readable, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: input.transportSha256,
        httpMetadata: { contentType: "application/octet-stream" },
      })
      .then(
        async (result) => {
          if (result === null) {
            sinkSkipped = true;
            await fixed.readable.cancel().catch(() => undefined);
          }
          return result;
        },
        async () => {
          sinkFailed = true;
          cancellation.abort(new DomainError("PRIMARY_WRITE_FAILED"));
          await fixed.readable.cancel().catch(() => undefined);
          throw new DomainError("PRIMARY_WRITE_FAILED");
        },
      );
    const [pumped, stored] = await Promise.allSettled([pump, sink]);
    if (pumped.status === "rejected")
      throw pumped.reason instanceof DomainError
        ? pumped.reason
        : new DomainError("STREAM_LENGTH_OR_WRITE_MISMATCH");
    // A lost response may have left a complete immutable object. Reconcile by full
    // pinned readback, never overwrite or infer completion from a provider response.
    const created = stored.status === "fulfilled" ? stored.value : null;
    const object = await verifyStoredStream(
      { ...input.object, versionId: created?.version ?? null },
      input,
    );
    return { object, outcome: created ? "created" : "matched_existing" };
  }
  return {
    capabilities: {
      conditionalCreate: "atomic",
      exactVersionRead: "immutable_key_checked_identity",
      retentionObservation: "unavailable",
    },
    get,
    getStream,
    putImmutable,
    putImmutableStream,
    async list(input) {
      demand(
        input.prefix === "" ||
          /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*\/?$/.test(input.prefix),
        "INVALID_ARCHIVE_PREFIX",
      );
      storageKey({
        provider: "primary",
        namespace: input.namespace,
        key: input.prefix.replace(/\/$/, "") || "placeholder",
        versionId: null,
      });
      demand(
        input.cursor === null ||
          (typeof input.cursor === "string" && input.cursor.length <= 2048),
        "INVALID_ARCHIVE_CURSOR",
      );
      const page = await bucket.list({
        prefix: `${input.namespace}/${input.prefix}`,
        limit: 100,
        ...(input.cursor === null ? {} : { cursor: input.cursor }),
      });
      return {
        items: page.objects.map((object) =>
          archiveObjectRefSchema.parse({
            provider: "primary",
            namespace: input.namespace,
            key: object.key.slice(input.namespace.length + 1),
            versionId: object.version,
          }),
        ),
        nextCursor: page.truncated ? page.cursor : null,
      };
    },
  };
}
