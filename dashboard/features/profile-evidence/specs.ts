import type { MutationSpec } from "../../lib/mutations";
import { cachedRevision, insertRecord, patchBody, pendingId, settleInsert, settleRevision } from "../../lib/optimistic";
import { anyOf, recordDetail, recordKind } from "../../lib/queries";

export type AddClaimValues = { field: string; text: string; sourceIds: string[]; permitted: boolean };
export type ReviewClaimValues = {
  id: string;
  revision: number;
  status: "user_confirmed" | "source_supported" | "disputed" | "unverified";
  permitted: boolean;
};
export type ResolveConflictValues = { questionId: string; value: string; reason: string };

export const claimEntity = (id: string) => "claim:" + id;

/** Claims begin unverified in the domain; the provisional row says so until the server confirms. */
export function addClaimSpec(values: AddClaimValues): MutationSpec<AddClaimValues> {
  return {
    operation: "job_stack_add_claim",
    entity: "claim:add",
    label: `Add claim “${values.field}”`,
    values,
    body: (v) => ({ field: v.field, text: v.text, sourceIds: v.sourceIds, permitted: v.permitted }),
    optimistic: (cache, v, context) =>
      insertRecord(cache, "claim", pendingId(context.requestKey), { ...v, status: "unverified" }, context.at),
    reconcile: (cache, result, _v, context) => settleInsert(cache, "claim", pendingId(context.requestKey), result),
    invalidate: recordKind("claim"),
  };
}

export function reviewClaimSpec(values: ReviewClaimValues): MutationSpec<ReviewClaimValues> {
  return {
    operation: "job_stack_review_claim",
    entity: claimEntity(values.id),
    label: "Review claim",
    values,
    body: (v, cache) => ({
      id: v.id,
      revision: cachedRevision(cache, "claim", v.id) ?? v.revision,
      status: v.status,
      permitted: v.permitted,
    }),
    optimistic: (cache, v) => patchBody(cache, "claim", v.id, { status: v.status, permitted: v.permitted }),
    reconcile: (cache, result) => settleRevision(cache, "claim", result.entityId, result.revision),
    invalidate: anyOf(recordDetail("claim", values.id), (key) => key[0] === "records" && key[1] === "claim"),
  };
}

export function resolveConflictSpec(values: ResolveConflictValues): MutationSpec<ResolveConflictValues> {
  return {
    operation: "job_stack_resolve_profile_conflict",
    entity: "question:" + values.questionId,
    label: "Resolve profile conflict",
    values,
    body: (v) => ({ questionId: v.questionId, value: v.value, reason: v.reason }),
    // The domain decides the resolved shape; the pending entry is the optimistic state.
    invalidate: anyOf(recordKind("question"), recordKind("claim")),
  };
}
