import { useId } from "react";
import { RECOVERY_STATUS_READ } from "../lib/api";
import { formatTime } from "../lib/format";
import { useQuery, useVisiblePolling, useWorkspace } from "../lib/hooks";
import { reads } from "../lib/queries";
import { backupStatusUnavailable, humanDuration, pendingAge, RECOVERY_POLL_MS, type RecoveryStatus } from "../lib/recoveryStatus";
import { ErrorState, errorMessage, Skeleton } from "./Feedback";

type Presentation = {
  readonly tone: "protected" | "progress" | "warning" | "error" | "neutral";
  readonly badge: string;
  readonly message: string;
};

function plural(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The only place a recovery state becomes words: "Protected" exists solely for state === "protected". */
export function presentRecovery(status: RecoveryStatus): Presentation {
  const pending = status.lag.pendingTransactions;
  switch (status.state) {
    case "protected":
      return {
        tone: "protected",
        badge: "Protected",
        message: "Every committed change is replicated and verified, and a verified checkpoint exists within 26 hours.",
      };
    case "protection_pending": {
      const age = pendingAge(status);
      return {
        tone: "progress",
        badge: "Backup in progress",
        message: `Backup in progress — ${plural(pending, "change")} pending${age ? ` (oldest ${age} ago)` : ""}.`,
      };
    }
    case "delayed": {
      const lag = status.lag.seconds !== null ? humanDuration(status.lag.seconds) : (pendingAge(status) ?? "an unknown time");
      return {
        tone: "warning",
        badge: "Backup delayed",
        message: `Replication is ${lag} behind with ${plural(pending, "change")} pending. Recent changes are not yet independently backed up.`,
      };
    }
    case "failed":
      return {
        tone: "error",
        badge: "Backup failed",
        message: `${plural(status.deadLetters, "change")} could not be replicated (dead-lettered) and need operator attention. Recent changes are not independently backed up.`,
      };
    case "degraded":
      return {
        tone: "neutral",
        badge: "Backup degraded",
        message: "Some backup checks did not complete, so recent changes are not counted as independently backed up.",
      };
    case "unavailable":
      return {
        tone: "neutral",
        badge: "Unavailable",
        message: "The backup destination could not be observed. Nothing is counted as independently backed up.",
      };
  }
}

function lagText(status: RecoveryStatus): string {
  const pending = status.lag.pendingTransactions;
  if (pending === 0) return "none (no changes pending)";
  const lag = status.lag.seconds !== null ? humanDuration(status.lag.seconds) : pendingAge(status);
  return `${lag ?? "unknown"} (${plural(pending, "change")} pending)`;
}

export function RecoveryStatusView({ status }: { status: RecoveryStatus }) {
  const view = presentRecovery(status);
  const empty = status.head === null && status.latestVerified === null;
  return (
    <div className={"recovery-status " + view.tone}>
      <p>
        <span className={"badge recovery-badge " + view.tone}>{view.badge}</span> <span role="status">{view.message}</span>
      </p>
      {empty && <p className="muted">No changes have been committed in this workspace yet, so there is nothing to back up.</p>}
      <p>
        Latest verified recoverable point:{" "}
        {status.latestVerified
          ? `change #${status.latestVerified.sequence}, verified ${formatTime(status.latestVerified.verifiedAt)}`
          : "none yet"}
      </p>
      <p>Replication lag: {lagText(status)}</p>
      {status.latestCheckpoint && (
        <p>
          Latest checkpoint: {status.latestCheckpoint.kind} {formatTime(status.latestCheckpoint.verifiedAt)}
        </p>
      )}
      {status.head && (
        <p className="muted">
          Newest committed change: #{status.head.sequence} at {formatTime(status.head.committedAt)}
        </p>
      )}
      <p className="muted">
        Observed {formatTime(status.observedAt)}. D1 Time Travel is a separate platform layer and is never counted as independent
        backup.
      </p>
    </div>
  );
}

/**
 * Workspace backup status from `job_stack_recovery_status`. Lazily loaded; polls at most every 60 s
 * while the page is visible; a 501 operation-unavailable is the explicit "Backup status unavailable".
 */
export default function RecoveryStatusPanel() {
  const workspace = useWorkspace();
  const headingId = useId();
  const workspaceId = workspace.workspaceId;
  const allowed = workspaceId !== null && workspace.allows(RECOVERY_STATUS_READ.scope);
  const state = useQuery(allowed && workspaceId ? reads.recoveryStatus(workspaceId) : null);
  const unavailable = state.status === "error" && backupStatusUnavailable(state.error);
  useVisiblePolling(state.refetch, state.updatedAt, RECOVERY_POLL_MS, allowed && !unavailable);
  let body;
  if (!allowed)
    body = (
      <p role="note" className="muted">
        Backup status is not available to this grant: it does not include {RECOVERY_STATUS_READ.scope}. Nothing is reported as
        protected.
      </p>
    );
  else if (state.data) body = <RecoveryStatusView status={state.data} />;
  else if (unavailable)
    body = (
      <div role="note" className="recovery-unavailable">
        <p>
          <strong>Backup status unavailable.</strong> The server does not provide backup status yet (operation-unavailable), so
          nothing is reported as protected.
        </p>
      </div>
    );
  else if (state.status === "error") body = <ErrorState message={errorMessage(state.error)} onRetry={state.refetch} />;
  else body = <Skeleton label="Loading backup status…" lines={2} />;
  return (
    <section className="panel recovery" aria-labelledby={headingId}>
      <h2 id={headingId}>Backup status</h2>
      {body}
      {state.data && state.status === "error" && (
        <ErrorState message={"Showing the last observed status. " + errorMessage(state.error)} onRetry={state.refetch} />
      )}
    </section>
  );
}
