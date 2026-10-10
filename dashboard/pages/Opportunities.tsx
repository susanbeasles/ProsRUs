import {
  label,
  objectFields,
  type ReadRecord,
  type ProtectionState,
} from "../api";
export type PipelineProps = {
  records: readonly ReadRecord[];
  current: ReadRecord | null;
  selected: string | null;
  complete: boolean;
  loaded: number;
  total: number;
  query: string;
  setQuery: (v: string) => void;
  all: boolean;
  setAll: (v: boolean) => void;
  select: (id: string | null, history?: boolean) => void;
  history: boolean;
  versions: readonly { versionId: string; createdAt: number }[];
  version: unknown;
  selectedVersion: string | null;
  protection: ProtectionState | null;
  selectVersion: (id: string | null) => void;
};
export function Opportunities(p: PipelineProps) {
  const view = (row: ReadRecord) => {
    const body = objectFields(row.body);
    return row.origin === "legacy_import" ? objectFields(body.display) : body;
  };
  if (p.selected) {
    if (!p.current) return <p role="status">Loading the selected record…</p>;
    const row = p.current,
      b = objectFields(row.body),
      v = view(row),
      source = objectFields(b.source);
    const protectionVersion =
      row.history === "versioned"
        ? p.history && p.selectedVersion
          ? p.selectedVersion
          : row.versionId
        : null;
    const protection =
      p.protection?.status === "available" &&
      p.protection.view.versionId === protectionVersion
        ? p.protection.view
        : null;
    return (
      <section className="panel detail">
        <button onClick={() => p.select(null)}>← All observations</button>
        <p>
          Record: {row.kind} / {row.entityId}
        </p>
        <p>
          {row.origin === "generic_archive"
            ? "Row revision: unavailable for generic archive"
            : `${row.origin === "legacy_import" ? "Local observation revision" : "Row revision"}: ${row.revision}`}
        </p>
        {row.bodyStatus !== "available" ? (
          <section role="note" aria-label="Unavailable record body">
            <h2>Record body unavailable</h2>
            <p>
              {row.bodyStatus === "invalid_json"
                ? "Stored content is not valid JSON."
                : "Stored content exceeds the read size limit."}
            </p>
            <p>Recorded at: {new Date(row.updatedAt).toISOString()}</p>
          </section>
        ) : (
          <>
            <p className="eyebrow">{label(v.company)}</p>
            <h2>{label(v.role)}</h2>
            <span className="badge">{label(v.stage ?? v.state)}</span>
            <p>{label(v.summary ?? v.nextAction)}</p>
            <p className="muted">
              Source checked: {label(v.verifiedAt)} · Local observation:{" "}
              {new Date(row.updatedAt).toISOString()}
            </p>
          </>
        )}
        <p>
          {row.origin === "legacy_import"
            ? "Imported legacy observation. Signed history and independent protection are pending."
            : row.origin === "generic_archive"
              ? "Immutable archive; no business row revision."
              : "Stored domain record."}
        </p>
        <p>No current pursuit or action approval is inferred.</p>
        {row.history === "versioned" ? (
          <>
            <button onClick={() => p.select(row.entityId, !p.history)}>
              {p.history ? "Back to record" : "Version history"}
            </button>
            {p.history && (
              <section aria-label="Version history">
                <h3>Version history</h3>
                <ul>
                  {p.versions.map((v) => (
                    <li key={v.versionId}>
                      <button onClick={() => p.selectVersion(v.versionId)}>
                        {v.versionId}
                      </button>{" "}
                      · {new Date(v.createdAt).toISOString()}
                    </li>
                  ))}
                </ul>
                {p.selectedVersion && (
                  <section>
                    <button onClick={() => p.selectVersion(null)}>
                      Back to version list
                    </button>
                    {p.version ? (
                      <pre>{JSON.stringify(p.version, null, 2)}</pre>
                    ) : (
                      <p role="status">Loading the selected version…</p>
                    )}
                  </section>
                )}
              </section>
            )}
          </>
        ) : (
          <p role="note">
            Version history unavailable: this observation has not been archived.
          </p>
        )}
        {protectionVersion && (
          <section aria-label="Version protection">
            {protection ? (
              <>
                <h3>Protection for {protection.versionId}</h3>
                <p>Primary save: {label(protection.primarySave)}</p>
                <p>Replication: {label(protection.replication)}</p>
                <p>Integrity: {label(protection.integrity)}</p>
                <p>
                  Freshness: {protection.freshnessKnown ? "known" : "unknown"}
                </p>
                <p>
                  Last checked:{" "}
                  {protection.lastCheckedAt === null
                    ? "never"
                    : new Date(protection.lastCheckedAt).toISOString()}
                </p>
                <p>
                  Historical document approval:{" "}
                  {label(protection.documentApproval)}
                </p>
                {protection.retentionEvidence.length ? (
                  <details>
                    <summary>Retention evidence</summary>
                    <pre>
                      {JSON.stringify(protection.retentionEvidence, null, 2)}
                    </pre>
                  </details>
                ) : (
                  <p>No retention evidence</p>
                )}
              </>
            ) : p.protection?.status === "loading" &&
              p.protection.versionId === protectionVersion ? (
              <p role="status">Loading protection for {protectionVersion}…</p>
            ) : (
              <p role="status">
                Protection unavailable or denied for {protectionVersion}.
              </p>
            )}
          </section>
        )}
        {row.bodyStatus === "available" && (
          <>
            <h3>Source identity</h3>
            <p>
              {label(source.sourceId)} · {label(source.classification)}
            </p>
            <pre>{JSON.stringify(source, null, 2)}</pre>
            <details>
              <summary>Original role fields and unknowns</summary>
              <pre>{JSON.stringify(b.raw ?? row.body, null, 2)}</pre>
            </details>
            <details>
              <summary>Observed receipts and prior states</summary>
              <pre>{JSON.stringify(b.relatedEvidence ?? [], null, 2)}</pre>
            </details>
          </>
        )}
        {row.provenance && (
          <details>
            <summary>
              Audit sources, exclusions and non-role classifications
            </summary>
            <pre>{JSON.stringify(row.provenance, null, 2)}</pre>
          </details>
        )}
      </section>
    );
  }
  const pipeline = p.records.filter((r) => view(r).inPipeline === true);
  const visible = (p.all ? p.records : pipeline).filter((r) =>
    JSON.stringify(r.body).toLowerCase().includes(p.query.toLowerCase()),
  );
  return (
    <>
      <div className="actions">
        <button aria-pressed={!p.all} onClick={() => p.setAll(false)}>
          Historical relationships {p.complete ? pipeline.length : "…"}
        </button>
        <button aria-pressed={p.all} onClick={() => p.setAll(true)}>
          All observations {p.complete ? p.records.length : "…"}
        </button>
      </div>
      <input
        className="search"
        placeholder="Search company, role or observed state"
        aria-label="Search observations"
        value={p.query}
        onChange={(e) => p.setQuery(e.target.value)}
      />
      {!p.complete && (
        <p role="status">
          Loading verified pages and details: {p.loaded} of {p.total || "…"}{" "}
          observations. Counts are not complete yet.
        </p>
      )}
      {p.complete && visible.length === 0 && (
        <p role="status">No observations match this view.</p>
      )}
      <div className="cards">
        {visible.map((row) => {
          const v = view(row),
            source = objectFields(objectFields(row.body).source);
          return (
            <article className="panel" key={row.entityId}>
              <p className="eyebrow">{label(v.company)}</p>
              <h2>{label(v.role)}</h2>
              <span className="badge">{label(v.status ?? v.state)}</span>
              <p>{label(v.stage ?? v.nextAction)}</p>
              <p className="muted">
                {label(source.sourceId)} · Source checked {label(v.verifiedAt)}
              </p>
              <button onClick={() => p.select(row.entityId)}>
                Open observation
              </button>
            </article>
          );
        })}
      </div>
    </>
  );
}
