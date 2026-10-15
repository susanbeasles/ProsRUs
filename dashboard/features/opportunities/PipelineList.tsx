import { label, type PipelineSummary } from "../../lib/api";
import { Pagination } from "../../components/Pagination";
import { CardsSkeleton } from "../../components/Feedback";

export type PipelineListProps = {
  records: readonly PipelineSummary[];
  historicalRelationships?: number;
  range?: { readonly start: number; readonly end: number };
  nextCursor?: string | null;
  canPrevious?: boolean;
  next?: () => void;
  previous?: () => void;
  unavailable?: string | null;
  complete: boolean;
  total: number;
  query: string;
  setQuery: (v: string) => void;
  select: (id: string) => void;
};

/** One verified page of imported observations with page-scoped search and source-observed totals. */
export function PipelineList(p: PipelineListProps) {
  if (p.unavailable)
    return (
      <section role="status" className="panel">
        <h2>Verified page unavailable</h2>
        <p>
          {p.unavailable === "page_capacity"
            ? "This dataset exceeds the supported page capacity. No observations have been omitted or loaded automatically."
            : "This dataset does not have the supported pending-import geometry."}
        </p>
      </section>
    );
  const visible = p.records.filter((row) =>
    JSON.stringify({ entityId: row.entityId, display: row.display }).toLowerCase().includes(p.query.toLowerCase()),
  );
  return (
    <>
      <label className="search-label">
        <span className="visually-hidden">Search this page</span>
        <input
          className="search"
          type="search"
          placeholder="Search this page by company, role or observed state"
          aria-label="Search this page"
          value={p.query}
          onChange={(e) => p.setQuery(e.target.value)}
        />
      </label>
      {!p.complete ? (
        <CardsSkeleton label="Loading one verified page…" />
      ) : (
        <>
          <p className="muted">
            Source-observed totals: {p.total} observations · {p.historicalRelationships ?? 0} historical relationships. Showing{" "}
            {p.range?.start ?? 0}–{p.range?.end ?? 0} in this view. Search covers this page only.
          </p>
          {visible.length === 0 && (
            <p role="status">
              {p.records.length ? "No observations on this page match your search." : "No source observations match this view."}
            </p>
          )}
        </>
      )}
      <div className="cards">
        {visible.map((row) => (
          <article className="panel" key={row.entityId}>
            {row.display.status === "available" ? (
              <>
                <p className="eyebrow">{row.display.company}</p>
                <h2>{row.display.role}</h2>
                <span className="badge">{label(row.display.observedStatus)}</span>
                <p>{row.display.stage}</p>
                <p>{row.display.nextAction}</p>
                <p className="muted">
                  {row.display.sourceLabel} · {row.display.sourceId} · Source checked {label(row.display.verifiedAt)}
                </p>
              </>
            ) : (
              <>
                <h2>{row.entityId}</h2>
                <p>
                  Display unavailable:{" "}
                  {row.display.reason === "too_large" ? "source fields exceed the display limit" : "source fields are unknown"}.
                </p>
              </>
            )}
            <p className="muted">Signed history and protection pending. No current pursuit or action approval.</p>
            <button type="button" onClick={() => p.select(row.entityId)}>
              Open observation
            </button>
          </article>
        ))}
      </div>
      <Pagination
        canPrevious={!!p.canPrevious}
        canNext={!!p.nextCursor}
        disabled={!p.complete}
        onPrevious={() => p.previous?.()}
        onNext={() => p.next?.()}
      />
    </>
  );
}
