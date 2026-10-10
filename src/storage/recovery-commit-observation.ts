import { z } from "zod";
import { demand } from "../domain/model";
import {
  preparedEnvelopeSchema,
  saveVersionResultSchema,
  workspaceRefSchema,
  type WorkspaceRef,
} from "../domain/recovery";
import {
  hashEnvelope,
  parseEnvelopeJson,
  canonicalizeEnvelope,
} from "../domain/recovery-canonical";
import { equalMetadata } from "./recovery-metadata";
import type { CommittedRecovery } from "../application/recovery-ports";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const observationSchema = z.object({
  observed_at_ms: time,
  clock: z.literal("d1-unixepoch-subsec-v1"),
  precision_ms: z.literal(1),
  preparation_digest: digest,
  transaction_digest: digest,
  result_digest: digest,
});

export async function readCommittedRecovery(
  db: D1Database,
  owner: string,
  input: Readonly<{ workspace: WorkspaceRef; transactionId: string }>,
): Promise<CommittedRecovery | null> {
  const selection = z
    .object({
      workspace: workspaceRefSchema,
      transactionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    })
    .strict()
    .parse(
      parseEnvelopeJson(new TextDecoder().decode(canonicalizeEnvelope(input))),
    );
  const workspace = selection.workspace;
  demand(workspace.ownerId === owner, "RECOVERY_OWNER_MISMATCH", 403);
  z.string()
    .regex(/^[A-Za-z0-9_-]{1,100}$/)
    .parse(input.transactionId);
  const raw = await db
    .prepare(
      "SELECT prepared,transaction_digest FROM recovery_transactions WHERE owner=? AND workspace_id=? AND transaction_id=?",
    )
    .bind(owner, workspace.workspaceId, input.transactionId)
    .first();
  if (raw === null) return null;
  const row = z
    .object({ prepared: z.string(), transaction_digest: digest })
    .parse(raw);
  const prepared = preparedEnvelopeSchema.parse(
    parseEnvelopeJson(row.prepared),
  );
  demand(
    equalMetadata(prepared.workspace, workspace) &&
      prepared.transactionId === input.transactionId,
    "RECOVERY_COMMIT_MISMATCH",
  );
  const { signature, ...unsigned } = prepared;
  void signature;
  const transactionDigest = await hashEnvelope("transaction", unsigned);
  demand(
    transactionDigest === row.transaction_digest,
    "RECOVERY_COMMIT_MISMATCH",
  );
  const resultRow = await db
    .prepare(
      "SELECT request_digest,result FROM recovery_request_results WHERE owner=? AND workspace_id=? AND transaction_id=? AND request_key=?",
    )
    .bind(
      owner,
      workspace.workspaceId,
      input.transactionId,
      prepared.requestKey,
    )
    .first();
  demand(resultRow, "RECOVERY_COMMIT_RESULT_MISSING");
  const retained = z
    .object({ request_digest: digest, result: z.string() })
    .parse(resultRow);
  const result = saveVersionResultSchema.parse(
    parseEnvelopeJson(retained.result),
  );
  demand(
    retained.request_digest === prepared.requestDigest &&
      equalMetadata(result, prepared.result),
    "RECOVERY_COMMIT_MISMATCH",
  );
  const observed = await db
    .prepare(
      "SELECT observed_at_ms,clock,precision_ms,preparation_digest,transaction_digest,result_digest FROM recovery_commit_observations WHERE owner=? AND workspace_id=? AND transaction_id=?",
    )
    .bind(owner, workspace.workspaceId, input.transactionId)
    .first();
  if (observed === null) return { prepared, result, observation: null };
  const observation = observationSchema.parse(observed);
  const now = z
    .object({ now_ms: time })
    .parse(
      await db
        .prepare(
          "SELECT CAST(ROUND(unixepoch('subsec')*1000) AS INTEGER) AS now_ms",
        )
        .first(),
    );
  demand(
    observation.preparation_digest ===
      (await hashEnvelope("preparation", unsigned)) &&
      observation.transaction_digest === transactionDigest &&
      observation.result_digest === result.digest &&
      observation.observed_at_ms >= prepared.createdAt &&
      observation.observed_at_ms <= now.now_ms,
    "RECOVERY_COMMIT_OBSERVATION_CONFLICT",
  );
  return {
    prepared,
    result,
    observation: {
      kind: "atomic_batch_statement",
      clock: observation.clock,
      precisionMs: observation.precision_ms,
      observedAt: observation.observed_at_ms,
      preparationDigest: observation.preparation_digest,
      transactionDigest: observation.transaction_digest,
      resultDigest: observation.result_digest,
    },
  };
}
