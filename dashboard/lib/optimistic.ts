import { objectFields, type ReadRecord, type ReadSummary, type RecordPage } from "./api";
import { patchQuery, type Rollback } from "./mutations";
import { keys } from "./queries";
import type { QueryCache } from "./queryCache";

/** Optimistic records use ids outside the catalog pattern's server namespace and are never linked. */
export const PENDING_PREFIX = "pending-";
export function pendingId(requestKey: string): string {
  return PENDING_PREFIX + requestKey;
}
export function isPendingId(entityId: string): boolean {
  return entityId.startsWith(PENDING_PREFIX);
}

/** Inserts a provisional row at the top of the first cached page and seeds its detail. */
export function insertRecord(
  cache: QueryCache,
  kind: string,
  entityId: string,
  body: Record<string, unknown>,
  now: number,
): Rollback {
  const summary = {
    origin: "domain_record",
    history: "legacy_unversioned",
    kind,
    entityId,
    revision: "1",
    updatedAt: now,
  } as ReadSummary;
  const list = patchQuery<RecordPage>(cache, keys.records(kind, null), (page) => ({
    ...page,
    items: [summary, ...page.items.filter((item) => item.entityId !== entityId)],
  }));
  const detail = keys.record(kind, entityId);
  cache.setData<ReadRecord>(detail, () => ({ ...summary, body, bodyStatus: "available", provenance: null }) as ReadRecord);
  return () => {
    list();
    cache.setData<ReadRecord>(detail, () => undefined);
  };
}

/** Replaces a provisional row with the server's entity id and revision (the server wins). */
export function settleInsert(cache: QueryCache, kind: string, provisional: string, result: { entityId: string; revision: string }) {
  cache.setData<RecordPage>(keys.records(kind, null), (page) =>
    page
      ? {
          ...page,
          items: page.items.map((item) =>
            item.entityId === provisional ? ({ ...item, entityId: result.entityId, revision: result.revision } as ReadSummary) : item,
          ),
        }
      : page,
  );
  const seeded = cache.peek<ReadRecord>(keys.record(kind, provisional));
  cache.setData<ReadRecord>(keys.record(kind, provisional), () => undefined);
  if (seeded)
    cache.setData<ReadRecord>(keys.record(kind, result.entityId), (current) =>
      current ?? ({ ...seeded, entityId: result.entityId, revision: result.revision } as ReadRecord),
    );
}

/** Optimistically merges fields into an available domain record body. */
export function patchBody(cache: QueryCache, kind: string, entityId: string, patch: Record<string, unknown>): Rollback {
  return patchQuery<ReadRecord>(cache, keys.record(kind, entityId), (row) =>
    row.bodyStatus === "available" ? ({ ...row, body: { ...objectFields(row.body), ...patch } } as ReadRecord) : row,
  );
}

/** Applies the revision returned by a write to the cached detail. */
export function settleRevision(cache: QueryCache, kind: string, entityId: string, revision: string) {
  cache.setData<ReadRecord>(keys.record(kind, entityId), (row) =>
    row && row.revision !== null ? ({ ...row, revision } as ReadRecord) : row,
  );
}

/** The newest known integer revision of a cached domain record. */
export function cachedRevision(cache: QueryCache, kind: string, entityId: string): number | null {
  const row = cache.peek<ReadRecord>(keys.record(kind, entityId));
  const revision = row?.revision === null || row?.revision === undefined ? NaN : Number(row.revision);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}
