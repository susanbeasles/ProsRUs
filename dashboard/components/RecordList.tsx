import { RouteLink, useRoute, useRouter } from "../app/context";
import type { Route } from "../app/router";
import { label, objectFields, type ReadRecord, type ReadSummary, type RecordPage } from "../lib/api";
import { formatTime } from "../lib/format";
import { usePeek } from "../lib/hooks";
import { isPendingId } from "../lib/optimistic";
import { keys } from "../lib/queries";
import { Pagination } from "./Pagination";

export type RowDescription = { readonly title: string; readonly detail?: string | null; readonly badge?: string | null };
export type Describe = (summary: ReadSummary, body: Record<string, unknown> | null) => RowDescription;

function originText(item: ReadSummary): string {
  if (item.origin === "legacy_import") return "Imported observation";
  if (item.origin === "generic_archive") return "Immutable archive";
  return item.history === "versioned" ? "Versioned record" : "Stored record";
}

/**
 * One server page of record summaries. Summaries carry no bodies, so a row is enriched only from
 * details already in the cache; opening a row loads its detail (no per-row reads).
 */
export function RecordList({
  page,
  describe,
  linkTo,
  label: listLabel,
}: {
  page: RecordPage;
  describe: Describe;
  linkTo: (item: ReadSummary) => Route;
  label: string;
}) {
  const router = useRouter();
  const route = useRoute();
  return (
    <>
      <ul className="record-list" aria-label={listLabel}>
        {page.items.map((item) => (
          <RecordRow key={item.kind + ":" + item.entityId} item={item} describe={describe} to={linkTo(item)} />
        ))}
      </ul>
      <Pagination
        canPrevious={route.cursor !== null}
        canNext={page.nextCursor !== null}
        onPrevious={() => router.previousPage()}
        onNext={() => {
          if (page.nextCursor) router.nextPage(page.nextCursor);
        }}
        summary={`Page ${router.trail().length + 1}${page.nextCursor ? "; more records exist" : ""}`}
      />
    </>
  );
}

function RecordRow({ item, describe, to }: { item: ReadSummary; describe: Describe; to: Route }) {
  const detail = usePeek<ReadRecord>(keys.record(item.kind, item.entityId));
  const body = detail?.bodyStatus === "available" ? objectFields(detail.body) : null;
  const row = describe(item, body);
  const pending = isPendingId(item.entityId);
  return (
    <li className={pending ? "record-row pending-row" : "record-row"}>
      <div className="record-main">
        {pending ? (
          <strong>{row.title}</strong>
        ) : (
          <RouteLink className="record-link" to={to}>
            {row.title}
          </RouteLink>
        )}
        {row.detail && <span className="muted">{row.detail}</span>}
        {!body && !pending && <span className="muted">Details load when opened.</span>}
      </div>
      <div className="chips">
        {pending ? <span className="badge pending">Saving…</span> : row.badge && <span className="badge">{label(row.badge)}</span>}
        <span className="badge subtle">{originText(item)}</span>
      </div>
      <small className="muted">
        {pending ? "Not yet confirmed by the server" : `Updated ${formatTime(item.updatedAt)} · revision ${item.revision ?? "none"}`}
      </small>
    </li>
  );
}
