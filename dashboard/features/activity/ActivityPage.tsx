import { useState } from "react";
import { EmptyState, errorMessage, NotEnabled, Skeleton } from "../../components/Feedback";
import { PageHeader } from "../../components/Layout";
import { QueryView } from "../../components/QueryView";
import { label } from "../../lib/api";
import { formatTime } from "../../lib/format";
import { useMutationRecords, useQuery, useWorkspace } from "../../lib/hooks";
import type { MutationRecord } from "../../lib/mutations";
import { reads } from "../../lib/queries";

export default function ActivityPage() {
  const records = useMutationRecords();
  return (
    <>
      <PageHeader eyebrow="ACTIVITY" title="Activity">
        <p>Changes made from this browser tab for the selected grant, with their request keys and durable results.</p>
      </PageHeader>
      <NotEnabled title="Workspace audit trail">
        The shared catalog exposes no audit-trail read, so this page cannot show changes made elsewhere. This list covers this tab
        only and is cleared when authority ends or the grant changes.
      </NotEnabled>
      <section className="panel" aria-labelledby="activity-changes">
        <h2 id="activity-changes">Changes from this tab</h2>
        {records.length === 0 ? (
          <EmptyState title="No changes yet">Changes you make in this session appear here with their request keys.</EmptyState>
        ) : (
          <ul className="activity-list">
            {records.map((record) => (
              <ActivityItem key={record.id} record={record} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

const STATUS: Record<MutationRecord["status"], string> = {
  queued: "Queued",
  running: "Saving",
  success: "Saved",
  error: "Not saved",
  cancelled: "Cancelled",
};

function ActivityItem({ record }: { record: MutationRecord }) {
  const workspace = useWorkspace();
  const [checking, setChecking] = useState(false);
  return (
    <li className="activity-item">
      <div>
        <span className="badge">{STATUS[record.status]}</span> <strong>{record.label}</strong>
        <p className="muted">
          {label(record.operation.replace(/^job_stack_/, ""))} · started {formatTime(record.createdAt)} · attempts {record.attempts}
        </p>
        <p className="muted mono">Request key {record.requestKey}</p>
        {record.status === "error" && <p className="field-error">{errorMessage(record.error)}</p>}
        {record.status === "cancelled" && record.cancelReason && <p className="muted">{record.cancelReason}</p>}
      </div>
      <div className="actions">
        {record.status === "error" && record.retryable && (
          <button type="button" onClick={() => workspace.mutations.retry(record.id)}>
            Retry with the same request key
          </button>
        )}
        {record.status !== "queued" && record.status !== "running" && !checking && (
          <button type="button" onClick={() => setChecking(true)}>
            Check durable result
          </button>
        )}
      </div>
      {checking && <DurableResult requestKey={record.requestKey} />}
    </li>
  );
}

function DurableResult({ requestKey }: { requestKey: string }) {
  const state = useQuery(reads.requestResult(requestKey));
  return (
    <div className="durable" aria-live="polite">
      <QueryView state={state} loading={<Skeleton label="Checking the durable result…" lines={1} />}>
        {(data) =>
          data.result ? (
            <p>
              Saved to primary storage as version <span className="mono">{data.result.versionId}</span>. Independent protection is
              pending.
            </p>
          ) : (
            <p>No durable result is recorded for this request key.</p>
          )
        }
      </QueryView>
    </div>
  );
}
