import { PendingChanges, Unavailable, useWriteAvailability } from "../../components/Actions";
import { ErrorState, Skeleton } from "../../components/Feedback";
import { SchemaForm } from "../../components/Form";
import { PageHeader } from "../../components/Layout";
import { QueryView } from "../../components/QueryView";
import { RecordIdentity } from "../../components/RecordBody";
import { domainBodySchemas } from "../../../integration/shared-contract.mjs";
import { objectFields, type ReadRecord } from "../../lib/api";
import { useIntent, useQuery } from "../../lib/hooks";
import type { MutationSpec } from "../../lib/mutations";
import { cachedRevision, patchBody, settleRevision } from "../../lib/optimistic";
import { recordRevision } from "../../lib/opportunity";
import { reads, recordKind } from "../../lib/queries";
import type { Overrides } from "../../lib/schemaForm";

type SettingsValues = Record<string, unknown> & { revision: number };
const ENTITY = "settings";

/** Revision-aware: the body carries the revision it was based on; a newer server revision conflicts. */
export function updateSettingsSpec(values: SettingsValues, entityId: string | null): MutationSpec<SettingsValues> {
  return {
    operation: "job_stack_update_settings",
    entity: ENTITY,
    label: "Update workspace settings",
    values,
    body: (v, cache) => ({ ...v, revision: entityId ? (cachedRevision(cache, "settings", entityId) ?? v.revision) : v.revision }),
    optimistic: entityId
      ? (cache, v) => {
          const { revision: _revision, ...fields } = v;
          void _revision;
          return patchBody(cache, "settings", entityId, fields);
        }
      : undefined,
    reconcile: (cache, result) => settleRevision(cache, "settings", result.entityId, result.revision),
    invalidate: recordKind("settings"),
  };
}

const OVERRIDES_BASE: Overrides = {
  sendingEnabled: {
    help: "A stored preference only. No send operation is enabled in this dashboard, so nothing is delivered regardless of this value.",
  },
  approvedRecipients: { help: "Email addresses, one per line." },
  "interviewWindows.*.start": { widget: "datetime" },
  "interviewWindows.*.end": { widget: "datetime" },
  "boards.*.company": { help: "The board's company slug (letters, digits, - or _)." },
};

export default function SettingsPage() {
  const list = useQuery(reads.records("settings", null));
  const entityId = list.data?.items[0]?.entityId ?? null;
  const record = useQuery(entityId ? reads.record("settings", entityId) : null);
  return (
    <>
      <PageHeader eyebrow="WORKSPACE" title="Settings">
        <p>Discovery, correspondence and reminders have separate switches. Saving is revision-aware: a change made elsewhere first is reported, never overwritten.</p>
      </PageHeader>
      <QueryView state={list} loading={<Skeleton label="Loading settings…" />}>
        {(page) =>
          page.items.length === 0 ? (
            <SettingsEditor row={null} />
          ) : record.data ? (
            <SettingsEditor row={record.data} />
          ) : record.status === "error" ? (
            <ErrorState message="Settings could not be read." onRetry={record.refetch} />
          ) : (
            <Skeleton label="Loading settings…" />
          )
        }
      </QueryView>
    </>
  );
}

function SettingsEditor({ row }: { row: ReadRecord | null }) {
  const availability = useWriteAvailability("job_stack_update_settings");
  const submit = useIntent();
  const revision = row ? recordRevision(row) : 0;
  const body = row && row.bodyStatus === "available" ? objectFields(row.body) : null;
  return (
    <section className="panel" aria-labelledby="settings-form">
      <h2 id="settings-form">Workspace settings</h2>
      {row ? (
        <RecordIdentity row={row} />
      ) : (
        <p className="notice">No settings have been saved yet. The form starts from empty values: every switch off and no addresses.</p>
      )}
      {!availability.available ? (
        <>
          <Unavailable label="Update settings" reason={availability.reason} />
          {body && <pre>{JSON.stringify(body, null, 2)}</pre>}
        </>
      ) : revision === null || (row && !body) ? (
        <Unavailable label="Update settings" reason="the stored settings have no available body or current revision." />
      ) : (
        <SchemaForm
          key={String(revision)}
          schema={domainBodySchemas.update_settings}
          overrides={{ ...OVERRIDES_BASE, revision: { fixed: revision } }}
          initial={body ?? {}}
          submitLabel="Save settings"
          onSubmit={(value) => submit(updateSettingsSpec(value as SettingsValues, row?.entityId ?? null))}
        />
      )}
      <PendingChanges entity={ENTITY} />
    </section>
  );
}
