import { useEffect, useRef } from "react";
import { errorMessage } from "../components/Feedback";
import { useToasts } from "../components/Toasts";
import { useMutationRecords, useWorkspace } from "../lib/hooks";
import type { MutationStatus } from "../lib/mutations";
import type { Workspace } from "../lib/workspace";

/** Announces settled writes; failures that may be retried offer a same-key retry. */
export function MutationToasts() {
  const records = useMutationRecords();
  const workspace = useWorkspace();
  const toasts = useToasts();
  const seen = useRef<{ workspace: Workspace | null; statuses: Map<string, MutationStatus> }>({
    workspace: null,
    statuses: new Map(),
  });
  useEffect(() => {
    if (seen.current.workspace !== workspace) seen.current = { workspace, statuses: new Map() };
    const statuses = seen.current.statuses;
    for (const record of records) {
      const before = statuses.get(record.id);
      statuses.set(record.id, record.status);
      if (before === record.status) continue;
      if (record.status === "success")
        toasts.push({ tone: "success", message: `Saved: ${record.label}. Independent protection is pending.` });
      else if (record.status === "error")
        toasts.push({
          tone: "error",
          message: `${record.label} was not saved. ${errorMessage(record.error)}`,
          action: record.retryable ? { label: "Retry", run: () => workspace.mutations.retry(record.id) } : undefined,
        });
    }
  }, [records, toasts, workspace]);
  return null;
}
