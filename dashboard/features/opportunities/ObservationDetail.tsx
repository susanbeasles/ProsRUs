import type { ReactNode, Ref } from "react";
import { label, objectFields, type ProtectionState, type ReadRecord } from "../../lib/api";

export type ObservationDetailProps = {
  current: ReadRecord;
  history: boolean;
  versions: readonly { versionId: string; createdAt: number }[];
  versionsTruncated?: boolean;
  versionsError?: string | null;
  version: unknown;
  versionError?: string | null;
  selectedVersion: string | null;
  protection: ProtectionState | null;
  select: (id: string | null, history?: boolean) => void;
  selectVersion: (id: string | null) => void;
  headingRef?: Ref<HTMLHeadingElement>;
  actions?: ReactNode;
  pendingState?: boolean;
};

/** Presentational record detail; identity, revision, history and protection are shown separately. */
export function ObservationDetail(p: ObservationDetailProps) {
  const row = p.current,
    b = objectFields(row.body),
    v = row.origin === "legacy_import" ? objectFields(b.display) : b,
    source = objectFields(b.source);
  const protectionVersion =
    row.history === "versioned" ? (p.history && p.selectedVersion ? p.selectedVersion : row.versionId) : null;
  const protection =
    p.protection?.status === "available" && p.protection.view.versionId === protectionVersion ? p.protection.view : null;
  return (
    <section className="panel detail">
      <button type="button" onClick={() => p.select(null)}>
        ← All observations
      </button>
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
          <h2 className="detail-title" tabIndex={-1} ref={p.headingRef}>
            Record body unavailable
          </h2>
          <p>{row.bodyStatus === "invalid_json" ? "Stored content is not valid JSON." : "Stored content exceeds the read size limit."}</p>
          <p>Recorded at: {new Date(row.updatedAt).toISOString()}</p>
        </section>
      ) : (
        <>
          <p className="eyebrow">{label(v.company)}</p>
          <h2 className="detail-title" tabIndex={-1} ref={p.headingRef}>
            {label(v.role)}
          </h2>
          <span className="badge">{label(v.stage ?? v.state)}</span>
          {p.pendingState && <span className="badge pending">Saving…</span>}
          <p>{label(v.summary ?? v.nextAction)}</p>
          <p className="muted">
            Source checked: {label(v.verifiedAt)} · Local observation: {new Date(row.updatedAt).toISOString()}
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
      {p.actions}
      {row.history === "versioned" ? (
        <>
          <button type="button" onClick={() => p.select(row.entityId, !p.history)}>
            {p.history ? "Back to record" : "Version history"}
          </button>
          {p.history && (
            <section aria-label="Version history">
              <h3>Version history</h3>
              {p.versionsError && (
                <p className="error" role="alert">
                  {p.versionsError}
                </p>
              )}
              <ul>
                {p.versions.map((item) => (
                  <li key={item.versionId}>
                    <button type="button" aria-pressed={p.selectedVersion === item.versionId} onClick={() => p.selectVersion(item.versionId)}>
                      {item.versionId}
                    </button>{" "}
                    · {new Date(item.createdAt).toISOString()}
                  </li>
                ))}
              </ul>
              {p.versionsTruncated && <p className="muted">Only the first 1000 versions are listed.</p>}
              {p.selectedVersion && (
                <section>
                  <button type="button" onClick={() => p.selectVersion(null)}>
                    Back to version list
                  </button>
                  {p.versionError ? (
                    <p className="error" role="alert">
                      {p.versionError}
                    </p>
                  ) : p.version ? (
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
        <p role="note">Version history unavailable: this observation has not been archived.</p>
      )}
      {protectionVersion && !(p.history && p.selectedVersion && p.versionError) && (
        <section aria-label="Version protection">
          {protection ? (
            <>
              <h3>Protection for {protection.versionId}</h3>
              <p>Primary save: {label(protection.primarySave)}</p>
              <p>Replication: {label(protection.replication)}</p>
              <p>Integrity: {label(protection.integrity)}</p>
              <p>Freshness: {protection.freshnessKnown ? "known" : "unknown"}</p>
              <p>
                Last checked: {protection.lastCheckedAt === null ? "never" : new Date(protection.lastCheckedAt).toISOString()}
              </p>
              <p>Historical document approval: {label(protection.documentApproval)}</p>
              {protection.retentionEvidence.length ? (
                <details>
                  <summary>Retention evidence</summary>
                  <pre>{JSON.stringify(protection.retentionEvidence, null, 2)}</pre>
                </details>
              ) : (
                <p>No retention evidence</p>
              )}
            </>
          ) : p.protection?.status === "loading" && p.protection.versionId === protectionVersion ? (
            <p role="status">Loading protection for {protectionVersion}…</p>
          ) : (
            <p role="status">Protection unavailable or denied for {protectionVersion}.</p>
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
          <summary>Audit sources, exclusions and non-role classifications</summary>
          <pre>{JSON.stringify(row.provenance, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}
