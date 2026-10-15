import { CardsSkeleton, EmptyState, errorMessage, ErrorState, Skeleton } from "../../components/Feedback";
import { BackLink, DetailHeading, PageHeader, ViewTabs } from "../../components/Layout";
import { QueryView } from "../../components/QueryView";
import { RecordIdentity } from "../../components/RecordBody";
import { RecordList } from "../../components/RecordList";
import { RouteLink, useRoute } from "../../app/context";
import { HISTORY_KINDS } from "../../app/router";
import { label, objectFields, type ReadProtection, type ReadRecord, type VersionManifest } from "../../lib/api";
import { firstText, formatTime } from "../../lib/format";
import { useQuery } from "../../lib/hooks";
import { reads } from "../../lib/queries";

export default function HistoryPage() {
  const route = useRoute();
  const kind = route.view ?? "opportunity";
  if (route.record) return <HistoryDetail kind={kind} entityId={route.record} />;
  return (
    <>
      <PageHeader eyebrow="SIGNED HISTORY" title="History">
        <p>
          Versions, their raw evidence, their historical approval and their independent protection are separate facts. None of them
          implies the others, and none implies current pursuit or action approval.
        </p>
      </PageHeader>
      <ViewTabs label="Record kinds" labels={Object.fromEntries(HISTORY_KINDS.map((k) => [k, label(k)]))} />
      <KindList kind={kind} />
    </>
  );
}

function KindList({ kind }: { kind: string }) {
  const route = useRoute();
  const state = useQuery(reads.records(kind, route.cursor));
  return (
    <QueryView
      state={state}
      loading={<CardsSkeleton label={`Loading ${label(kind)} records…`} />}
      isEmpty={(page) => page.items.length === 0}
      empty={<EmptyState title={`No ${label(kind)} records`}>Records of this kind appear here with their history status.</EmptyState>}
    >
      {(page) => (
        <RecordList
          page={page}
          label={`${label(kind)} records`}
          linkTo={(item) => ({ ...route, record: item.entityId, versionId: null })}
          describe={(item, body) => ({
            title: firstText(body, ["role", "subject", "field", "title", "name"]) ?? item.entityId,
            detail: item.history === "versioned" ? "Signed history available" : "No signed history",
          })}
        />
      )}
    </QueryView>
  );
}

function HistoryDetail({ kind, entityId }: { kind: string; entityId: string }) {
  const route = useRoute();
  const record = useQuery(reads.record(kind, entityId));
  const versioned = record.data?.history === "versioned" ? record.data : null;
  const versions = useQuery(versioned ? reads.versions(versioned.lineageId) : null);
  const version = useQuery(versioned && route.versionId ? reads.version(route.versionId, versioned) : null);
  const protectionId = versioned ? (route.versionId ? (version.data ? route.versionId : null) : versioned.versionId) : null;
  const protection = useQuery(protectionId ? reads.protection(protectionId) : null);
  return (
    <QueryView state={record} loading={<Skeleton label="Loading the selected record…" />}>
      {(row) => (
        <section className="panel detail">
          <BackLink>All {label(kind)} records</BackLink>
          <DetailHeading eyebrow={label(kind).toUpperCase()}>{row.entityId}</DetailHeading>
          <RecordIdentity row={row} />
          {row.history !== "versioned" ? (
            <p role="note" className="notice">
              No signed history: this record has not been archived, so it has no versions and no independent protection.
            </p>
          ) : (
            <>
              <section aria-labelledby="history-versions">
                <h3 id="history-versions">Versions</h3>
                <QueryView state={versions} loading={<Skeleton label="Loading versions…" lines={2} />}>
                  {(list) => (
                    <>
                      <ul className="version-list">
                        {list.items.map((item) => (
                          <li key={item.versionId}>
                            <RouteLink
                              to={{ ...route, versionId: item.versionId }}
                              aria-current={(route.versionId ?? row.versionId) === item.versionId ? "true" : undefined}
                            >
                              <span className="mono">{item.versionId}</span>
                            </RouteLink>{" "}
                            · {formatTime(item.createdAt)} · historical approval {label(item.approval)}
                            {item.versionId === row.versionId && <span className="badge subtle">current</span>}
                          </li>
                        ))}
                      </ul>
                      {list.truncated && <p className="muted">Only the first 1000 versions are listed.</p>}
                    </>
                  )}
                </QueryView>
              </section>
              {route.versionId && version.status === "error" ? (
                <ErrorState message={errorMessage(version.error)} onRetry={version.refetch} />
              ) : (
                <VersionFacts
                  row={row}
                  versionId={route.versionId ?? row.versionId}
                  manifest={route.versionId ? (version.data ?? null) : null}
                  protection={protection.data ?? null}
                  protectionError={protection.status === "error" ? errorMessage(protection.error) : null}
                />
              )}
            </>
          )}
        </section>
      )}
    </QueryView>
  );
}

/** Raw evidence, historical approval and independent protection, each with its own honest wording. */
export function VersionFacts({
  row,
  versionId,
  manifest,
  protection,
  protectionError,
}: {
  row: ReadRecord;
  versionId: string;
  manifest: VersionManifest | null;
  protection: ReadProtection | null;
  protectionError: string | null;
}) {
  const approval = manifest ? objectFields(objectFields(manifest).approval) : null;
  return (
    <div className="facts">
      <section className="fact" aria-labelledby="fact-evidence">
        <h3 id="fact-evidence">Raw evidence</h3>
        <p className="muted">
          The stored version exactly as read, with its digests. Evidence is observational: it records what was saved, not that it
          is correct, approved or protected.
        </p>
        {manifest ? (
          <details>
            <summary>Version manifest for {versionId}</summary>
            <pre>{JSON.stringify(manifest, null, 2)}</pre>
          </details>
        ) : (
          <p>
            Current version <span className="mono">{versionId}</span>
            {row.history === "versioned" && <> · manifest digest <span className="mono">{row.manifestDigest}</span></>}. Select a
            version to read its manifest.
          </p>
        )}
      </section>
      <section className="fact" aria-labelledby="fact-approval">
        <h3 id="fact-approval">Approval</h3>
        <p className="muted">
          Historical document approval of this version. It is not current pursuit, sending or action approval.
        </p>
        <p>Manifest approval: {approval && typeof approval.state === "string" ? label(approval.state) : "not loaded"}</p>
        <p>Historical document approval (protection record): {protection ? label(protection.documentApproval) : "not loaded"}</p>
      </section>
      <section className="fact" aria-labelledby="fact-protection">
        <h3 id="fact-protection">Protection</h3>
        <p className="muted">
          Independent protection as last observed. Pending or unknown values mean this version is not yet independently protected;
          a successful save or connectivity alone proves nothing.
        </p>
        {protection ? (
          <dl className="fields">
            <div>
              <dt>Primary save</dt>
              <dd>{label(protection.primarySave)}</dd>
            </div>
            <div>
              <dt>Replication</dt>
              <dd>{label(protection.replication)}</dd>
            </div>
            <div>
              <dt>Integrity</dt>
              <dd>{label(protection.integrity)}</dd>
            </div>
            <div>
              <dt>Freshness</dt>
              <dd>{protection.freshnessKnown ? "known" : "unknown"}</dd>
            </div>
            <div>
              <dt>Last checked</dt>
              <dd>{protection.lastCheckedAt === null ? "never" : formatTime(protection.lastCheckedAt)}</dd>
            </div>
            <div>
              <dt>Retention evidence</dt>
              <dd>{protection.retentionEvidence.length ? `${protection.retentionEvidence.length} item(s)` : "none"}</dd>
            </div>
          </dl>
        ) : protectionError ? (
          <p role="status">Protection unavailable or denied for {versionId}.</p>
        ) : (
          <Skeleton label={`Loading protection for ${versionId}…`} lines={2} />
        )}
      </section>
    </div>
  );
}
