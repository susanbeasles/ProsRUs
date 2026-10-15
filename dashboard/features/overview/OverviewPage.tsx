import { CardsSkeleton, EmptyState, errorMessage } from "../../components/Feedback";
import { PageHeader } from "../../components/Layout";
import { LazyRecoveryStatus } from "../../components/LazyRecoveryStatus";
import { RouteLink, useRoute } from "../../app/context";
import { pageRoute, type PageId } from "../../app/router";
import { label, objectFields, type ReadRecord, type ReadSummary, type RecordPage } from "../../lib/api";
import { firstText, formatTime } from "../../lib/format";
import { useMutationRecords, usePeek, useQuery, type QueryState } from "../../lib/hooks";
import { isPendingId } from "../../lib/optimistic";
import { keys, reads } from "../../lib/queries";

const KIND_PAGES: Readonly<Record<string, { page: PageId; view?: string; title: string }>> = {
  opportunity: { page: "opportunities", view: "tracked", title: "Opportunity records" },
  thread: { page: "conversations", title: "Conversations" },
  interview: { page: "interviews", title: "Interviews" },
  offer: { page: "history", view: "offer", title: "Offers" },
};

function pageCount(state: QueryState<RecordPage>): string {
  if (!state.data) return state.status === "error" ? "Unavailable" : "…";
  return state.data.items.length + (state.data.nextCursor ? "+" : "");
}

export default function OverviewPage() {
  const route = useRoute();
  const pipeline = useQuery(reads.pipeline("relationships", null));
  const opportunities = useQuery(reads.records("opportunity", null));
  const threads = useQuery(reads.records("thread", null));
  const interviews = useQuery(reads.records("interview", null));
  const offers = useQuery(reads.records("offer", null));
  const changes = useMutationRecords().slice(0, 5);
  const available = pipeline.data?.status === "available" ? pipeline.data : null;
  const lists = [
    ["opportunity", opportunities],
    ["thread", threads],
    ["interview", interviews],
    ["offer", offers],
  ] as const;
  const recent = lists
    .flatMap(([, state]) => state.data?.items ?? [])
    .filter((item) => !isPendingId(item.entityId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8);
  const loading = lists.some(([, state]) => !state.data && state.status !== "error");
  const failed = [pipeline, ...lists.map(([, state]) => state)].filter((state) => state.status === "error" && !state.data);
  return (
    <>
      <PageHeader eyebrow="OVERVIEW" title="Your recruiting workspace">
        <p>Counts come from the first page of each record list and from the verified pipeline page. Totals are labelled as such.</p>
      </PageHeader>
      {failed.length > 0 && (
        <div className="error" role="alert">
          <p>Some figures could not be read: {errorMessage(failed[0]?.error)}</p>
          <button type="button" onClick={() => failed.forEach((state) => state.refetch())}>
            Try again
          </button>
        </div>
      )}
      <div className="stats">
        <Stat
          title="Historical relationships"
          value={available ? String(available.historicalRelationships) : pipeline.data ? "Unavailable" : pipeline.status === "error" ? "Unavailable" : "…"}
          note={available ? `of ${available.totalObservations} source observations (verified totals)` : "Verified pipeline page"}
          to={pageRoute(route.grant, "opportunities")}
        />
        {lists.map(([kind, state]) => {
          const meta = KIND_PAGES[kind];
          return meta ? (
            <Stat
              key={kind}
              title={meta.title}
              value={pageCount(state)}
              note={state.data?.nextCursor ? "first page; more exist" : "from your records"}
              to={pageRoute(route.grant, meta.page, { view: meta.view ?? null })}
            />
          ) : null;
        })}
      </div>
      <LazyRecoveryStatus />
      <div className="overviewgrid">
        <section className="panel" aria-labelledby="recent-activity">
          <h2 id="recent-activity">Recently updated records</h2>
          {loading && recent.length === 0 ? (
            <CardsSkeleton label="Loading recent records…" count={2} />
          ) : recent.length === 0 ? (
            <EmptyState title="Nothing recorded yet">Capture an opportunity or a conversation to start.</EmptyState>
          ) : (
            <ul className="record-list">
              {recent.map((item) => (
                <RecentRow key={item.kind + item.entityId} item={item} grant={route.grant} />
              ))}
            </ul>
          )}
        </section>
        <section className="panel" aria-labelledby="recent-changes">
          <h2 id="recent-changes">Your changes in this tab</h2>
          {changes.length === 0 ? (
            <p className="muted">No changes yet. Changes you make appear here and in Activity.</p>
          ) : (
            <ul className="plain-list">
              {changes.map((change) => (
                <li key={change.id}>
                  <span className="badge">{label(change.status)}</span> {change.label}
                </li>
              ))}
            </ul>
          )}
          <RouteLink to={pageRoute(route.grant, "activity")}>Open activity</RouteLink>
        </section>
      </div>
    </>
  );
}

function Stat({ title, value, note, to }: { title: string; value: string; note: string; to: ReturnType<typeof pageRoute> }) {
  return (
    <article className="stat">
      <RouteLink to={to} className="stat-link">
        <span>{title}</span>
        <strong>{value}</strong>
        <small>{note}</small>
      </RouteLink>
    </article>
  );
}

function RecentRow({ item, grant }: { item: ReadSummary; grant: string }) {
  const detail = usePeek<ReadRecord>(keys.record(item.kind, item.entityId));
  const body = detail?.bodyStatus === "available" ? objectFields(detail.body) : null;
  const meta = KIND_PAGES[item.kind];
  const title = firstText(body, ["role", "subject", "title"]) ?? item.entityId;
  return (
    <li className="record-row">
      <div className="record-main">
        {meta ? (
          <RouteLink className="record-link" to={pageRoute(grant, meta.page, { view: meta.view ?? null, record: item.entityId })}>
            {title}
          </RouteLink>
        ) : (
          <strong>{title}</strong>
        )}
        <span className="muted">{label(item.kind)}</span>
      </div>
      <small className="muted">Updated {formatTime(item.updatedAt)}</small>
    </li>
  );
}
