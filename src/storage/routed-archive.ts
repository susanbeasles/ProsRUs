import type { PrimaryArchive } from "../application/recovery-ports";
import type { ArchiveObjectRef } from "../domain/recovery";
import { createPrimaryArchive, type RestoredVersionResolver } from "./primary-archive";

/** Temporary upload state lives only under this key prefix (ADR 0004). */
const UPLOAD_PREFIX = "uploads/";

/** One primary archive over two private buckets: upload sessions, receipts and
 * chunks go to the short-lived UPLOADS bucket (lifecycle-expired, never locked
 * or backed up); promoted originals, packages and preparations go to the
 * retained ORIGINALS bucket. Every invariant of the underlying adapter holds
 * per bucket; routing depends only on the logical key. */
export function createRoutedArchive(
  buckets: Readonly<{ originals: R2Bucket; uploads: R2Bucket }>,
  restored: RestoredVersionResolver | null = null,
): PrimaryArchive {
  const originals = createPrimaryArchive(buckets.originals, restored);
  const uploads = createPrimaryArchive(buckets.uploads);
  const route = (key: string) => (key.startsWith(UPLOAD_PREFIX) ? uploads : originals);
  const at = (object: ArchiveObjectRef) => route(object.key);
  return {
    capabilities: originals.capabilities,
    get: (object) => at(object).get(object),
    getStream: (object) => at(object).getStream(object),
    putImmutable: (input) => at(input.object).putImmutable(input),
    putImmutableStream: (input) => at(input.object).putImmutableStream(input),
    list: (input) => route(input.prefix).list(input),
  };
}
