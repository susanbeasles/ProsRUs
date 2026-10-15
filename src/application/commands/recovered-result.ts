import { z } from "zod";
import { demand, id } from "../../domain/model";
import { saveVersionResultSchema } from "../../domain/recovery";
import { createRecoveryStore } from "../../storage/recovery-store";
import type { CommandKind } from "./registry";

/** Local-writes release only through a recovery transaction; this names it. */
export function recoveryTransactionOf(
  kind: CommandKind,
  output: unknown,
): string | null {
  if (kind === "version-save")
    return saveVersionResultSchema.parse(output).transactionId;
  if (kind === "domain")
    return z
      .object({ save: saveVersionResultSchema })
      .passthrough()
      .parse(output).save.transactionId;
  return null;
}

/** Replay of a committed local-write reads the authoritative
 * recovery_request_results row (written in the commit batch) and the committed
 * result version, never a second copy kept by the ledger. */
export async function recoveredOutput(
  db: D1Database,
  workspace: Readonly<{ ownerId: string; workspaceId: string }>,
  kind: CommandKind,
  requestKey: string,
  transactionId: string,
): Promise<unknown> {
  const committed = await db
    .prepare(
      "SELECT workspace_id,transaction_id FROM recovery_request_results WHERE owner=? AND request_key=?",
    )
    .bind(workspace.ownerId, requestKey)
    .first();
  const row = z
    .object({ workspace_id: id, transaction_id: id })
    .nullable()
    .parse(committed);
  demand(
    row?.workspace_id === workspace.workspaceId &&
      row.transaction_id === transactionId,
    "COMMAND_LEDGER_CONFLICT",
    409,
  );
  const store = createRecoveryStore(db, workspace.ownerId);
  const save = await store.findRequest(requestKey);
  demand(save?.transactionId === transactionId, "COMMAND_LEDGER_CONFLICT", 409);
  if (kind === "version-save") return save;
  demand(kind === "domain", "COMMAND_LEDGER_CONFLICT", 409);
  const manifest = await store.getVersion(save.versionId);
  demand(
    manifest?.workspace.workspaceId === workspace.workspaceId &&
      manifest.transactionId === transactionId,
    "COMMAND_LEDGER_CONFLICT",
    409,
  );
  const snapshot = z
    .object({ entityId: id, revision: z.number().int().positive() })
    .passthrough()
    .parse(manifest.recordSnapshot);
  return {
    entityId: snapshot.entityId,
    revision: String(snapshot.revision),
    save,
  };
}
