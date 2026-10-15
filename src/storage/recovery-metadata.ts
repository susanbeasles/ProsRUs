import type {
  ArchiveReader,
  PrimaryArchive,
} from "../application/recovery-ports";
import type {
  ArchiveMetadataDescriptor,
  ArchiveObjectRef,
  RecoveryPurpose,
} from "../domain/recovery";
import {
  canonicalizeEnvelope,
  hashEnvelope,
  MAX_ENVELOPE_BYTES,
  parseEnvelopeJson,
} from "../domain/recovery-canonical";
import { demand, DomainError } from "../domain/model";
import { readBoundedBytes, sameArchiveObject } from "./recovery-streams";

export function logicalObject(
  namespace: string,
  key: string,
): ArchiveObjectRef {
  return { provider: "primary", namespace, key, versionId: null };
}
export async function readMetadata(
  archive: Pick<ArchiveReader, "getStream">,
  object: ArchiveObjectRef,
  purpose: RecoveryPurpose,
  expected?: ArchiveMetadataDescriptor,
): Promise<Readonly<{
  value: unknown;
  descriptor: ArchiveMetadataDescriptor;
}> | null> {
  const read = await archive.getStream(object);
  if (!read) return null;
  if (read.sizeBytes > MAX_ENVELOPE_BYTES) {
    await read.body.cancel().catch(() => undefined);
    throw new DomainError("ENVELOPE_TOO_LARGE");
  }
  if (object.versionId !== null && !sameArchiveObject(read.object, object)) {
    await read.body.cancel().catch(() => undefined);
    throw new DomainError("ARCHIVE_IDENTITY_MISMATCH");
  }
  const bytes = await readBoundedBytes(
    read.body,
    MAX_ENVELOPE_BYTES,
    read.sizeBytes,
  );
  let value: unknown;
  try {
    value = parseEnvelopeJson(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    const canonical = canonicalizeEnvelope(value);
    demand(
      canonical.length === bytes.length &&
        canonical.every((byte, index) => byte === bytes[index]),
      "NONCANONICAL_ARCHIVE_METADATA",
    );
  } catch (error) {
    if (expected) throw new DomainError("INTEGRITY_MISMATCH");
    throw error;
  }
  const descriptor: ArchiveMetadataDescriptor = {
    formatVersion: 1,
    hashPurpose: purpose,
    digest: await hashEnvelope(purpose, value),
    sizeBytes: bytes.length,
    mediaType: "application/json",
    object: read.object,
  };
  if (expected)
    demand(equalMetadata(descriptor, expected), "INTEGRITY_MISMATCH");
  return { value, descriptor };
}
export function equalMetadata(left: unknown, right: unknown): boolean {
  const a = canonicalizeEnvelope(left),
    b = canonicalizeEnvelope(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
export async function writeMetadata(
  archive: PrimaryArchive,
  object: ArchiveObjectRef,
  purpose: RecoveryPurpose,
  value: unknown,
): Promise<ArchiveMetadataDescriptor> {
  const bytes = canonicalizeEnvelope(value);
  const digest = await hashEnvelope(purpose, value);
  // Request identities are not archived through this storage port.
  demand(purpose !== "request", "INVALID_RECOVERY_PURPOSE");
  const stored = await archive.putImmutable({
    object,
    bytes,
    digest,
    hashPurpose: purpose,
  });
  const descriptor: ArchiveMetadataDescriptor = {
    formatVersion: 1,
    hashPurpose: purpose,
    digest,
    sizeBytes: bytes.length,
    mediaType: "application/json",
    object: stored.object,
  };
  demand(
    await readMetadata(archive, stored.object, purpose, descriptor),
    "ARCHIVE_OBJECT_MISSING",
  );
  return descriptor;
}
