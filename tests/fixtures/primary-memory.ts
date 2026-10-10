import type {
  ArchivePutInput,
  ArchivePutResult,
  PrimaryArchive,
} from "../../src/application/recovery-ports";
import {
  canonicalizeEnvelope,
  hashEnvelope,
  parseEnvelopeJson,
} from "../../src/domain/recovery-canonical";
import {
  artifactDigest,
  readBoundedBytes,
} from "../../src/storage/recovery-streams";
import { DomainError, demand } from "../../src/domain/model";
import type { ArchiveObjectRef } from "../../src/domain/recovery";

/** Small synthetic archive seam. Conditional/pinning behavior is separately tested
 * against real R2. This fixture must never be imported by production assembly. */
export function memoryArchive() {
  const objects = new Map<
    string,
    { object: ArchiveObjectRef; bytes: Uint8Array }
  >();
  let serial = 0;
  let failAfterKey: string | null = null;
  const key = (object: ArchiveObjectRef) => `${object.namespace}/${object.key}`;
  const resolve = (object: ArchiveObjectRef) => {
    const value = objects.get(key(object));
    demand(
      !value ||
        object.versionId === null ||
        value.object.versionId === object.versionId,
      "ARCHIVE_IDENTITY_MISMATCH",
    );
    return value;
  };
  async function putImmutable(
    input: ArchivePutInput,
  ): Promise<ArchivePutResult> {
    const digest =
      input.hashPurpose === "blob"
        ? artifactDigest(input.bytes)
        : await hashEnvelope(
            input.hashPurpose,
            parseEnvelopeJson(new TextDecoder().decode(input.bytes)),
          );
    demand(digest === input.digest, "INTEGRITY_MISMATCH");
    const current = objects.get(key(input.object));
    if (current) {
      demand(
        current.bytes.length === input.bytes.length &&
          current.bytes.every((b, i) => b === input.bytes[i]),
        "INTEGRITY_MISMATCH",
      );
      return { object: current.object, outcome: "matched_existing" };
    }
    const object = { ...input.object, versionId: `synthetic-${++serial}` };
    objects.set(key(object), { object, bytes: input.bytes.slice() });
    if (failAfterKey !== null && object.key.includes(failAfterKey)) {
      failAfterKey = null;
      throw new DomainError("SYNTHETIC_LOST_RESPONSE");
    }
    return { object, outcome: "created" };
  }
  const archive: PrimaryArchive = {
    capabilities: {
      conditionalCreate: "atomic",
      exactVersionRead: "immutable_key_checked_identity",
      retentionObservation: "unavailable",
    },
    putImmutable,
    async putImmutableStream(input) {
      const bytes = await readBoundedBytes(
        input.body,
        8 * 1024 * 1024,
        input.sizeBytes,
      );
      return putImmutable({ ...input, bytes });
    },
    async get(object) {
      const value = resolve(object);
      return value
        ? { object: value.object, bytes: value.bytes.slice() }
        : null;
    },
    async getStream(object) {
      const value = resolve(object);
      if (!value) return null;
      return {
        object: value.object,
        sizeBytes: value.bytes.length,
        mediaType: "application/octet-stream",
        body: new Blob([new Uint8Array(value.bytes)]).stream(),
      };
    },
    async list(input) {
      const values = [...objects.values()].filter(
        (value) =>
          value.object.namespace === input.namespace &&
          value.object.key.startsWith(input.prefix),
      );
      return { items: values.map((value) => value.object), nextCursor: null };
    },
  };
  return {
    archive,
    objects,
    failNextAfter(key: string) {
      failAfterKey = key;
    },
    corrupt(object: ArchiveObjectRef) {
      const value = resolve(object);
      if (!value) throw new Error("fixture object missing");
      const bytes = value.bytes.slice();
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      objects.set(key(object), { object: value.object, bytes });
    },
    replaceJson(object: ArchiveObjectRef, value: unknown) {
      objects.set(key(object), { object, bytes: canonicalizeEnvelope(value) });
    },
  };
}
