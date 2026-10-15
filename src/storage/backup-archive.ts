import { createHash } from "node:crypto";
import { demand, DomainError } from "../domain/model";
import { sha256Schema } from "../domain/backup";
import { MAX_ORIGINAL_BYTES, readStreamChunks } from "./recovery-streams";

/** Largest JSON or NDJSON object the replicator buffers in memory. */
export const MAX_BACKUP_DOCUMENT_BYTES = 64 * 1024 * 1024;
const keyPattern = /^(changes|receipts|checkpoints|objects)\/[A-Za-z0-9_./-]+$/;

export type BackupPutOutcome = "created" | "matched_existing";
export type BackupListing = Readonly<{
  objects: readonly Readonly<{ key: string; sizeBytes: number; uploadedAt: number }>[];
  cursor: string | null;
}>;
/** The replicator's only view of the independent destination. Every write is
 * create-only with an R2-enforced SHA-256, and an existing object counts only
 * when its bytes re-hash to the expected digest. Deletion exists solely for the
 * retention pass; bucket locks reject it while an object is still locked. */
export type BackupArchive = Readonly<{
  putBytes: (key: string, bytes: Uint8Array, contentType: string) => Promise<Readonly<{ outcome: BackupPutOutcome; sha256: string }>>;
  putStream: (
    key: string,
    body: ReadableStream<Uint8Array>,
    sizeBytes: number,
    sha256: string,
  ) => Promise<BackupPutOutcome>;
  verify: (key: string, sha256: string, sizeBytes: number) => Promise<void>;
  readBytes: (key: string, maxBytes?: number) => Promise<Readonly<{ bytes: Uint8Array; sha256: string }> | null>;
  exists: (key: string) => Promise<boolean>;
  list: (prefix: string, cursor: string | null) => Promise<BackupListing>;
  remove: (key: string) => Promise<void>;
}>;

function checkedKey(key: string): string {
  demand(
    key.length <= 1000 &&
      keyPattern.test(key) &&
      key.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "INVALID_BACKUP_KEY",
  );
  return key;
}
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashStream(
  body: ReadableStream<Uint8Array>,
  expectedSize: number,
): Promise<Readonly<{ sha256: string; sizeBytes: number }>> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of readStreamChunks(body)) {
    size += chunk.byteLength;
    demand(size <= expectedSize, "BACKUP_INTEGRITY_FAULT");
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), sizeBytes: size };
}

export function createBackupArchive(bucket: R2Bucket): BackupArchive {
  async function verify(key: string, sha256: string, sizeBytes: number) {
    checkedKey(key);
    sha256Schema.parse(sha256);
    const read = await bucket.get(key);
    if (read === null) throw new DomainError("BACKUP_OBJECT_MISSING", 503);
    if (read.size !== sizeBytes) {
      await read.body.cancel().catch(() => undefined);
      throw new DomainError("BACKUP_INTEGRITY_FAULT", 500);
    }
    const observed = await hashStream(read.body, sizeBytes);
    demand(
      observed.sizeBytes === sizeBytes && observed.sha256 === sha256,
      "BACKUP_INTEGRITY_FAULT",
      500,
    );
  }
  async function putBytes(key: string, bytes: Uint8Array, contentType: string) {
    checkedKey(key);
    demand(bytes.byteLength <= MAX_BACKUP_DOCUMENT_BYTES, "BACKUP_DOCUMENT_TOO_LARGE", 500);
    const sha256 = sha256Hex(bytes);
    let created: R2Object | null = null;
    try {
      created = await bucket.put(key, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256,
        httpMetadata: { contentType },
      });
    } catch {
      // A lost response may still have created the object: reconcile by readback.
    }
    await verify(key, sha256, bytes.byteLength);
    return { outcome: created ? ("created" as const) : ("matched_existing" as const), sha256 };
  }
  async function putStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    sizeBytes: number,
    sha256: string,
  ): Promise<BackupPutOutcome> {
    checkedKey(key);
    sha256Schema.parse(sha256);
    demand(
      Number.isSafeInteger(sizeBytes) && sizeBytes >= 0 && sizeBytes <= MAX_ORIGINAL_BYTES,
      "INVALID_ORIGINAL_SIZE",
    );
    if (await bucket.head(key)) {
      await body.cancel().catch(() => undefined);
      await verify(key, sha256, sizeBytes);
      return "matched_existing";
    }
    const fixed = new FixedLengthStream(sizeBytes);
    const writer = fixed.writable.getWriter();
    let skipped = false;
    const pump = (async () => {
      const hash = createHash("sha256");
      let count = 0;
      try {
        for await (const chunk of readStreamChunks(body)) {
          count += chunk.byteLength;
          demand(count <= sizeBytes, "BACKUP_INTEGRITY_FAULT", 500);
          hash.update(chunk);
          if (!skipped) await writer.write(chunk).catch((error: unknown) => {
            if (!skipped) throw error;
          });
        }
        demand(count === sizeBytes && hash.digest("hex") === sha256, "BACKUP_INTEGRITY_FAULT", 500);
        if (!skipped) await writer.close();
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
        sha256,
        httpMetadata: { contentType: "application/octet-stream" },
      })
      .then(async (result) => {
        if (result === null) {
          skipped = true;
          await fixed.readable.cancel().catch(() => undefined);
        }
        return result;
      });
    const [pumped, stored] = await Promise.allSettled([pump, sink]);
    if (pumped.status === "rejected")
      throw pumped.reason instanceof DomainError ? pumped.reason : new DomainError("BACKUP_WRITE_FAILED", 503);
    await verify(key, sha256, sizeBytes);
    return stored.status === "fulfilled" && stored.value !== null ? "created" : "matched_existing";
  }
  return {
    putBytes,
    putStream,
    verify,
    async readBytes(key, maxBytes = MAX_BACKUP_DOCUMENT_BYTES) {
      checkedKey(key);
      const read = await bucket.get(key);
      if (read === null) return null;
      if (read.size > maxBytes) {
        await read.body.cancel().catch(() => undefined);
        throw new DomainError("BACKUP_DOCUMENT_TOO_LARGE", 500);
      }
      const bytes = new Uint8Array(await read.arrayBuffer());
      demand(bytes.byteLength === read.size, "BACKUP_INTEGRITY_FAULT", 500);
      return { bytes, sha256: sha256Hex(bytes) };
    },
    async exists(key) {
      return (await bucket.head(checkedKey(key))) !== null;
    },
    async list(prefix, cursor) {
      demand(/^(changes|receipts|checkpoints|objects)\/[A-Za-z0-9_./-]*$/.test(prefix), "INVALID_BACKUP_PREFIX");
      const page = await bucket.list({ prefix, limit: 1000, ...(cursor === null ? {} : { cursor }) });
      return {
        objects: page.objects.map((object) => ({
          key: object.key,
          sizeBytes: object.size,
          uploadedAt: object.uploaded.getTime(),
        })),
        cursor: page.truncated ? page.cursor : null,
      };
    },
    async remove(key) {
      demand(checkedKey(key).startsWith("objects/sha256/"), "BACKUP_DELETE_FORBIDDEN", 403);
      await bucket.delete(key);
    },
  };
}
