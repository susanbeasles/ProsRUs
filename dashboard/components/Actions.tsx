import { useState, type ComponentType, type ReactNode } from "react";
import { domainBodySchemas } from "../../integration/shared-contract.mjs";
import { ApiError, ELEVATION_URL, needsElevation, writeOperation, type WriteOperation } from "../lib/api";
import { useEntityMutations, useIntent, useMutationRecords, useWorkspace } from "../lib/hooks";
import type { MutationRecord, MutationSpec } from "../lib/mutations";
import type { FieldErrors, Overrides } from "../lib/schemaForm";
import { Dialog } from "./Dialog";
import { errorMessage } from "./Feedback";
import { SchemaForm } from "./Form";

export type Availability = { readonly available: true } | { readonly available: false; readonly reason: string };

function serverUnavailable(record: MutationRecord): boolean {
  return (
    record.status === "error" &&
    record.error instanceof ApiError &&
    (record.error.code === "operation-unavailable" || record.error.status === 501)
  );
}

/** Whether this session may invoke a write, with the exact reason when it may not. */
export function useWriteAvailability(operation: WriteOperation): Availability {
  const workspace = useWorkspace();
  const records = useMutationRecords();
  const meta = writeOperation(operation);
  if (!meta) return { available: false, reason: "This operation is not part of the shared catalog." };
  if (!workspace.workspaceId) return { available: false, reason: "The current session does not identify a workspace." };
  if (!workspace.allows(meta.scope)) return { available: false, reason: `This grant does not include ${meta.scope}.` };
  if (records.some((record) => record.operation === operation && serverUnavailable(record)))
    return { available: false, reason: "The server reported this action as not enabled (operation-unavailable)." };
  return { available: true };
}

export function bodySchema(operation: WriteOperation): unknown {
  const meta = writeOperation(operation);
  return meta?.domainOperation ? domainBodySchemas[meta.domainOperation] : undefined;
}

export function OwnerOnlyBadge({ operation }: { operation: WriteOperation }) {
  if (!writeOperation(operation)?.ownerOnly) return null;
  return (
    <span className="badge owner" title="Available only from this owner presentation, never through MCP clients.">
      Owner only
    </span>
  );
}

export function Unavailable({ label, reason }: { label: string; reason: string }) {
  return (
    <p className="action-unavailable" role="note">
      <strong>{label}</strong> is not available: {reason}
    </p>
  );
}

/**
 * A write behind a button: availability is explained instead of hidden, the dialog is generated from
 * the catalog body schema and the submission becomes one intent with its own request key.
 */
export function WriteAction<V extends Record<string, unknown>>({
  operation,
  label,
  title,
  description,
  overrides,
  initial,
  validate,
  spec,
  primary = false,
  submitLabel = "Save",
  Loader,
}: {
  operation: WriteOperation;
  label: string;
  title: string;
  description?: ReactNode;
  overrides?: Overrides;
  initial?: unknown;
  validate?: (value: V) => FieldErrors;
  spec: (values: V) => MutationSpec<V>;
  primary?: boolean;
  submitLabel?: string;
  /** Loads choices (claims, packets, opportunities) only once the dialog opens. */
  Loader?: ComponentType<{ children: (extra: Overrides) => ReactNode }>;
}) {
  const availability = useWriteAvailability(operation);
  const [open, setOpen] = useState(false);
  const submit = useIntent();
  if (!availability.available) return <Unavailable label={label} reason={availability.reason} />;
  const form = (formOverrides: Overrides | undefined) => (
    <SchemaForm
      schema={bodySchema(operation)}
      overrides={formOverrides}
      initial={initial}
      submitLabel={submitLabel}
      validate={validate as ((value: Record<string, unknown>) => FieldErrors) | undefined}
      onCancel={() => setOpen(false)}
      onSubmit={(value) => {
        submit(spec(value as V));
        setOpen(false);
      }}
    />
  );
  return (
    <>
      <button type="button" className={primary ? "primary" : undefined} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {label}
        <OwnerOnlyBadge operation={operation} />
      </button>
      {open && (
        <Dialog title={title} description={description} onClose={() => setOpen(false)}>
          {Loader ? <Loader>{(extra) => form({ ...overrides, ...extra })}</Loader> : form(overrides)}
        </Dialog>
      )}
    </>
  );
}

const STATUS_TEXT: Record<MutationRecord["status"], string> = {
  queued: "Waiting for an earlier change",
  running: "Saving…",
  success: "Saved",
  error: "Not saved",
  cancelled: "Cancelled",
};

/** Optimistic status of the writes that target one entity, with retry for ambiguous failures. */
export function PendingChanges({ entity }: { entity: string }) {
  const records = useEntityMutations(entity).slice(0, 5);
  const workspace = useWorkspace();
  if (!records.length) return null;
  return (
    <section className="pending" aria-label="Changes to this record">
      <h3>Changes from this session</h3>
      <ul>
        {records.map((record) => (
          <li key={record.id} className={"pending-" + record.status}>
            <span className="badge">{STATUS_TEXT[record.status]}</span> {record.label}
            {record.status === "success" && record.result && (
              <span className="muted"> · revision {record.result.revision}, primary save {record.result.save.status.replaceAll("_", " ")}, protection pending</span>
            )}
            {record.status === "error" && <span className="muted"> · {errorMessage(record.error)}</span>}
            {record.status === "cancelled" && record.cancelReason && <span className="muted"> · {record.cancelReason}</span>}
            {record.status === "error" && record.retryable && (
              <button type="button" onClick={() => workspace.mutations.retry(record.id)}>
                Retry with the same request key
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Shown while the newest settled write was refused for missing hardware-key elevation. It is not
 * authority loss: reads stay visible, the optimistic change was rolled back, and a retry after
 * confirming reuses the same request key.
 */
export function ElevationNotice() {
  const records = useMutationRecords();
  const latest = records.find((record) => record.status !== "queued" && record.status !== "running");
  if (!latest || latest.status !== "error" || !needsElevation(latest.error)) return null;
  return (
    <div className="notice elevation" role="status">
      <p>
        <strong>Confirm with your security key to enable changes.</strong> Changes need a 15-minute hardware-key confirmation in
        Personal Control. “{latest.label}” was not applied and your view is unchanged.
      </p>
      <p>
        <a href={ELEVATION_URL}>Confirm with your security key</a> · then retry the change; the retry reuses the same request key.
      </p>
    </div>
  );
}
