import { label } from "../../lib/api";
import { combine, type MutationSpec } from "../../lib/mutations";
import { cachedRevision, insertRecord, patchBody, pendingId, settleInsert, settleRevision } from "../../lib/optimistic";
import { anyOf, recordDetail, recordKind } from "../../lib/queries";
import { opportunityEntity } from "../packets/specs";

export { opportunityEntity };

export type Terms = {
  employment: "full_time" | "contract";
  baseUsd: number | null;
  hourlyUsd: number | null;
  remote: boolean | null;
  match401k: boolean | null;
  zeroPremium: boolean | null;
  affordableCare: boolean | null;
};
export type CaptureValues = { company: string; role: string; sourceUrl: string; description: string; terms: Terms };
export type TransitionValues = { id: string; revision: number; state: string; evidence: string; confirmed: boolean };
export type AssessValues = { id: string; revision: number; terms: Terms };
export type OfferValues = {
  opportunityId: string;
  baseUsd: number;
  bonusUsd: number;
  equityUsd: number;
  equityType: "liquid" | "private" | "none";
  notes: string;
};

export function captureSpec(values: CaptureValues): MutationSpec<CaptureValues> {
  return {
    operation: "job_stack_capture_opportunity",
    entity: "opportunity:capture",
    label: `Capture ${values.role} at ${values.company}`,
    values,
    body: (v) => ({ company: v.company, role: v.role, sourceUrl: v.sourceUrl, description: v.description, terms: v.terms }),
    optimistic: (cache, v, context) =>
      insertRecord(
        cache,
        "opportunity",
        pendingId(context.requestKey),
        { company: v.company, role: v.role, sourceUrl: v.sourceUrl, description: v.description, terms: v.terms },
        context.at,
      ),
    reconcile: (cache, result, _v, context) => settleInsert(cache, "opportunity", pendingId(context.requestKey), result),
    invalidate: recordKind("opportunity"),
  };
}

/**
 * Optimistically shows the new state; the request carries the newest revision known when it runs
 * (after earlier writes to the same opportunity), and the server's revision replaces it on success.
 */
export function transitionSpec(values: TransitionValues): MutationSpec<TransitionValues> {
  return {
    operation: "job_stack_transition_opportunity",
    entity: opportunityEntity(values.id),
    label: `Move to ${label(values.state)}`,
    values,
    body: (v, cache) => ({
      id: v.id,
      revision: cachedRevision(cache, "opportunity", v.id) ?? v.revision,
      state: v.state,
      evidence: v.evidence,
      confirmed: v.confirmed,
    }),
    optimistic: (cache, v) => patchBody(cache, "opportunity", v.id, { state: v.state }),
    reconcile: (cache, result) => settleRevision(cache, "opportunity", result.entityId, result.revision),
    invalidate: anyOf(recordDetail("opportunity", values.id), (key) => key[0] === "records" && key[1] === "opportunity"),
  };
}

export function assessSpec(values: AssessValues): MutationSpec<AssessValues> {
  return {
    operation: "job_stack_assess_opportunity",
    entity: opportunityEntity(values.id),
    label: "Assess terms",
    values,
    body: (v, cache) => ({ id: v.id, revision: cachedRevision(cache, "opportunity", v.id) ?? v.revision, terms: v.terms }),
    optimistic: (cache, v) => patchBody(cache, "opportunity", v.id, { terms: v.terms }),
    reconcile: (cache, result) => settleRevision(cache, "opportunity", result.entityId, result.revision),
    invalidate: recordDetail("opportunity", values.id),
  };
}

export function offerSpec(values: OfferValues): MutationSpec<OfferValues> {
  return {
    operation: "job_stack_record_offer",
    entity: opportunityEntity(values.opportunityId),
    label: "Record offer",
    values,
    body: (v) => ({
      opportunityId: v.opportunityId,
      baseUsd: v.baseUsd,
      bonusUsd: v.bonusUsd,
      equityUsd: v.equityUsd,
      equityType: v.equityType,
      notes: v.notes,
    }),
    optimistic: (cache, v, context) =>
      combine(insertRecord(cache, "offer", pendingId(context.requestKey), { ...v }, context.at)),
    reconcile: (cache, result, _v, context) => settleInsert(cache, "offer", pendingId(context.requestKey), result),
    invalidate: anyOf(recordKind("offer"), recordDetail("opportunity", values.opportunityId)),
  };
}
