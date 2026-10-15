import type {
  PipelinePage,
  ReadClient,
  ReadRecord,
  ReadSession,
  RecordPage,
  ReadProtection,
  RequestResult,
  VersionManifest,
  VersionSummary,
} from "./api";
import type { QueryKey } from "./queryCache";

/** A read bound to the selected grant by the workspace; its key must capture every input of run(). */
export type ReadQuery<T> = {
  readonly key: QueryKey;
  readonly run: (client: ReadClient) => Promise<T>;
  readonly staleMs?: number;
};

export const keys = {
  session: () => ["session"] as const,
  pipeline: (view: "relationships" | "all", cursor: string | null) => ["pipeline", view, cursor] as const,
  records: (kind: string, cursor: string | null) => ["records", kind, cursor] as const,
  record: (kind: string, entityId: string) => ["record", kind, entityId] as const,
  profile: (cursor: string | null) => ["profile", cursor] as const,
  versions: (lineageId: string) => ["versions", lineageId] as const,
  version: (versionId: string, lineageId: string, entityId: string) => ["version", versionId, lineageId, entityId] as const,
  protection: (versionId: string) => ["protection", versionId] as const,
  requestResult: (requestKey: string) => ["request", requestKey] as const,
};

/** Matches every cached list page and detail of one record kind. */
export function recordKind(kind: string) {
  return (key: QueryKey) => (key[0] === "records" || key[0] === "record") && key[1] === kind;
}
export function recordDetail(kind: string, entityId: string) {
  return (key: QueryKey) => key[0] === "record" && key[1] === kind && key[2] === entityId;
}
export function anyOf(...matchers: ((key: QueryKey) => boolean)[]) {
  return (key: QueryKey) => matchers.some((match) => match(key));
}

/** At most ten version pages (1000 versions) are collected for one lineage. */
export const MAX_VERSION_PAGES = 10;
export type VersionHistory = { readonly items: readonly VersionSummary[]; readonly truncated: boolean };

export const reads = {
  session: (): ReadQuery<ReadSession> => ({
    key: keys.session(),
    run: (client) => client.session(),
    staleMs: Number.POSITIVE_INFINITY,
  }),
  pipeline: (view: "relationships" | "all", cursor: string | null): ReadQuery<PipelinePage> => ({
    key: keys.pipeline(view, cursor),
    run: (client) => client.pipelinePage(view, cursor),
  }),
  records: (kind: string, cursor: string | null): ReadQuery<RecordPage> => ({
    key: keys.records(kind, cursor),
    run: (client) => client.page(kind, cursor),
  }),
  record: (kind: string, entityId: string): ReadQuery<ReadRecord> => ({
    key: keys.record(kind, entityId),
    run: async (client) => {
      const row = await client.detail(kind, entityId);
      if (!row) throw Error(kind === "opportunity" ? "Observation no longer available." : "Record no longer available.");
      return row;
    },
  }),
  profile: (cursor: string | null): ReadQuery<RecordPage> => ({
    key: keys.profile(cursor),
    run: (client) => client.profile(cursor),
  }),
  versions: (lineageId: string): ReadQuery<VersionHistory> => ({
    key: keys.versions(lineageId),
    run: async (client) => {
      const items: VersionSummary[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_VERSION_PAGES; page++) {
        const result: Awaited<ReturnType<ReadClient["versions"]>> = await client.versions(lineageId, cursor);
        if (result.items.some((item) => item.lineageId !== lineageId)) throw Error("Version list does not belong to the selected record.");
        items.push(...result.items);
        cursor = result.nextCursor;
        if (!cursor) return { items, truncated: false };
      }
      return { items, truncated: true };
    },
  }),
  version: (versionId: string, record: { lineageId: string; entityId: string }): ReadQuery<VersionManifest> => ({
    key: keys.version(versionId, record.lineageId, record.entityId),
    run: async (client) => {
      const selected = await client.version(versionId);
      if (
        selected.versionId !== versionId ||
        selected.lineageId !== record.lineageId ||
        selected.entityId !== record.entityId
      )
        throw Error("Version does not belong to the selected record.");
      return selected;
    },
    staleMs: Number.POSITIVE_INFINITY,
  }),
  protection: (versionId: string): ReadQuery<ReadProtection> => ({
    key: keys.protection(versionId),
    run: (client) => client.protection(versionId),
  }),
  requestResult: (requestKey: string): ReadQuery<RequestResult> => ({
    key: keys.requestResult(requestKey),
    run: (client) => client.requestResult(requestKey),
  }),
};
