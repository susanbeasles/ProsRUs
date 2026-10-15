import type { MutationSpec } from "../../lib/mutations";
import { insertRecord, pendingId, settleInsert } from "../../lib/optimistic";
import { anyOf, recordDetail, recordKind } from "../../lib/queries";

export type CreatePacketValues = { opportunityId: string; claimIds: string[] };
export type SubmissionValues = {
  opportunityId: string;
  packetId: string;
  receipt: string;
  submittedAt: number;
  confirmed: true;
};

/** Packet and submission writes serialize with the other writes on their opportunity. */
export function opportunityEntity(entityId: string): string {
  return "opportunity:" + entityId;
}

export function createPacketSpec(values: CreatePacketValues): MutationSpec<CreatePacketValues> {
  return {
    operation: "job_stack_create_packet",
    entity: opportunityEntity(values.opportunityId),
    label: `Create packet with ${values.claimIds.length} claim${values.claimIds.length === 1 ? "" : "s"}`,
    values,
    body: (v) => ({ opportunityId: v.opportunityId, claimIds: v.claimIds }),
    optimistic: (cache, v, context) =>
      insertRecord(cache, "packet", pendingId(context.requestKey), { opportunityId: v.opportunityId, claimIds: v.claimIds }, context.at),
    reconcile: (cache, result, _v, context) => settleInsert(cache, "packet", pendingId(context.requestKey), result),
    invalidate: anyOf(recordKind("packet"), recordDetail("opportunity", values.opportunityId)),
  };
}

export function recordSubmissionSpec(values: SubmissionValues): MutationSpec<SubmissionValues> {
  return {
    operation: "job_stack_record_submission",
    entity: opportunityEntity(values.opportunityId),
    label: "Record submission",
    values,
    body: (v) => ({
      opportunityId: v.opportunityId,
      packetId: v.packetId,
      receipt: v.receipt,
      submittedAt: v.submittedAt,
      confirmed: true,
    }),
    // The visible optimistic state is the pending entry on the opportunity and packet; the domain
    // decides any resulting state change, so no state is guessed here.
    invalidate: anyOf(recordDetail("opportunity", values.opportunityId), recordKind("packet")),
  };
}
