import { z } from "zod";
import { ApiError } from "./api";

/**
 * Local strict schema for `recovery-status-v1` (delivery contracts section 10). The catalog
 * operation is added by another workstream; until the backend serves it, its 501
 * operation-unavailable renders as "Backup status unavailable" and protection is never inferred.
 *
 * Encodings follow the existing catalog: sequences are decimal strings (as in version manifests),
 * times are epoch milliseconds, ids use the artifact id pattern and digests are lowercase SHA-256.
 */
export const PROTECTED_CHECKPOINT_MS = 26 * 60 * 60 * 1000;
/** Recovery status is polled at most this often, and only while the page is visible. */
export const RECOVERY_POLL_MS = 60_000;

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const sequence = z.string().max(100).regex(/^(0|[1-9][0-9]*)$/);
const time = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const RECOVERY_STATES = ["protected", "protection_pending", "delayed", "degraded", "failed", "unavailable"] as const;

export const recoveryStatusSchema = z
  .object({
    format: z.literal("recovery-status-v1"),
    workspaceId: id,
    state: z.enum(RECOVERY_STATES),
    head: z.object({ sequence, committedAt: time }).strict().nullable(),
    latestVerified: z.object({ sequence, transactionDigest: digest, verifiedAt: time }).strict().nullable(),
    latestCheckpoint: z
      .object({
        checkpointId: id,
        kind: z.enum(["daily", "monthly"]),
        position: z.object({ sequence }).strict(),
        verifiedAt: time,
      })
      .strict()
      .nullable(),
    lag: z
      .object({ pendingTransactions: count, oldestPendingAt: time.nullable(), seconds: z.number().min(0).nullable() })
      .strict(),
    deadLetters: count,
    observedAt: time,
  })
  .strict()
  .superRefine((status, context) => {
    // `protected` is accepted only with its defining evidence; a contradicting payload is an error,
    // never a badge.
    if (status.state !== "protected") return;
    const checkpoint = status.latestCheckpoint;
    if (
      !status.head ||
      !status.latestVerified ||
      status.latestVerified.sequence !== status.head.sequence ||
      !checkpoint ||
      status.observedAt - checkpoint.verifiedAt > PROTECTED_CHECKPOINT_MS ||
      status.lag.pendingTransactions !== 0 ||
      status.deadLetters !== 0
    )
      context.addIssue({ code: "custom", message: "protected-without-evidence" });
  });
export type RecoveryStatus = z.infer<typeof recoveryStatusSchema>;

export const RECOVERY_STATUS_INVALID = "Recovery status does not match recovery-status-v1, so no protection state is shown.";

export function parseRecoveryStatus(value: unknown, workspaceId: string): RecoveryStatus {
  const parsed = recoveryStatusSchema.safeParse(value);
  if (!parsed.success) throw Error(RECOVERY_STATUS_INVALID);
  if (parsed.data.workspaceId !== workspaceId)
    throw Error("Recovery status belongs to a different workspace, so no protection state is shown.");
  return parsed.data;
}

/** The backend does not serve recovery status yet: an explicit state, not an error. */
export function backupStatusUnavailable(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 501 || error.code === "operation-unavailable");
}

/** Human units for a lag or age in seconds. */
export function humanDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60),
    rest = minutes % 60;
  if (hours < 48) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/** Age of the oldest pending change at observation time (falls back to the reported lag). */
export function pendingAge(status: RecoveryStatus): string | null {
  if (status.lag.oldestPendingAt !== null) return humanDuration((status.observedAt - status.lag.oldestPendingAt) / 1000);
  return status.lag.seconds === null ? null : humanDuration(status.lag.seconds);
}
