import { z } from "zod";
import type { RestoredVersionResolver } from "./primary-archive";

const row = z.object({ restored_version_id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) });
/** Reads the immutable restore aliases written by the operator restore into a
 * new database. In a database that was never restored the table is empty. */
export function restoredVersionResolver(db: D1Database): RestoredVersionResolver {
  return async (storageKey, versionId) => {
    const raw = await db
      .prepare("SELECT restored_version_id FROM recovery_restored_objects WHERE storage_key=? AND original_version_id=?")
      .bind(storageKey, versionId)
      .first();
    return raw === null ? null : row.parse(raw).restored_version_id;
  };
}
