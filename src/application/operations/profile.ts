import { z } from "zod";
import { claimSchema, demand } from "../../domain/model";
import { inspectText } from "../../domain/rules";
import { schemas } from "../contracts";
import type { OperationDependencies, OperationRequest } from "../dependencies";
export async function resolveProfileConflict(
  { actor, raw, now }: OperationRequest,
  { store }: Pick<OperationDependencies, "store">,
) {
  demand(actor.kind === "user", "USER_REQUIRED");
  const input = schemas.resolve_profile_conflict.parse(raw);
  const r = await store.get("question", input.questionId);
  demand(r, "NOT_FOUND");
  const body = z
    .object({ type: z.literal("profile_conflict") })
    .passthrough()
    .parse(r.body);
  return store.update(
    "question",
    r.id,
    {
      ...body,
      status: "resolved",
      confirmedValue: input.value,
      reason: input.reason,
    },
    r.revision,
    actor.id,
    now,
  );
}
export async function addClaim(
  { actor, raw, now }: OperationRequest,
  { store }: Pick<OperationDependencies, "store">,
) {
  const input = schemas.add_claim.parse(raw);
  const id = crypto.randomUUID();
  const flags = inspectText(input.text);
  return store.add(
    "claim",
    id,
    { ...input, id, status: "unverified", flags },
    actor.id,
    now,
  );
}
export async function reviewClaim(
  { actor, raw, now }: OperationRequest,
  { store }: Pick<OperationDependencies, "store">,
) {
  const input = schemas.review_claim.parse(raw);
  demand(actor.kind === "user", "USER_CONFIRMATION_REQUIRED");
  const record = await store.get("claim", input.id);
  demand(record, "NOT_FOUND", 404);
  const c = claimSchema.parse(record.body);
  demand(
    input.status !== "source_supported" || c.sourceIds.length > 0,
    "MISSING_EVIDENCE",
  );
  for (const sourceId of c.sourceIds)
    demand(await store.get("artifact", sourceId), "SOURCE_NOT_FOUND");
  return store.update(
    "claim",
    input.id,
    { ...c, status: input.status, permitted: input.permitted },
    input.revision,
    actor.id,
    now,
  );
}
