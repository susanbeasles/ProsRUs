import type { MutationSpec } from "../../lib/mutations";
import { cachedRevision, insertRecord, patchBody, pendingId, settleInsert, settleRevision } from "../../lib/optimistic";
import { anyOf, recordDetail, recordKind } from "../../lib/queries";

export type CaptureConversationValues = { opportunityId: string; recipient: string; subject: string; message: string };
export type DraftValues = { threadId: string; revision: number; body: string };
export type AssociateValues = { questionId: string; opportunityId: string };

export const threadEntity = (id: string) => "thread:" + id;
export const questionEntity = (id: string) => "question:" + id;

export function captureConversationSpec(values: CaptureConversationValues): MutationSpec<CaptureConversationValues> {
  return {
    operation: "job_stack_capture_conversation",
    entity: "thread:capture",
    label: `Capture conversation “${values.subject}”`,
    values,
    body: (v) => ({ opportunityId: v.opportunityId, recipient: v.recipient, subject: v.subject, message: v.message }),
    optimistic: (cache, v, context) => insertRecord(cache, "thread", pendingId(context.requestKey), { ...v }, context.at),
    reconcile: (cache, result, _v, context) => settleInsert(cache, "thread", pendingId(context.requestKey), result),
    invalidate: recordKind("thread"),
  };
}

export function saveDraftSpec(values: DraftValues): MutationSpec<DraftValues> {
  return {
    operation: "job_stack_save_draft",
    entity: threadEntity(values.threadId),
    label: "Save draft reply",
    values,
    body: (v, cache) => ({ threadId: v.threadId, revision: cachedRevision(cache, "thread", v.threadId) ?? v.revision, body: v.body }),
    optimistic: (cache, v) => patchBody(cache, "thread", v.threadId, { draft: v.body }),
    reconcile: (cache, result) => settleRevision(cache, "thread", result.entityId, result.revision),
    invalidate: recordDetail("thread", values.threadId),
  };
}

export function associateSpec(values: AssociateValues): MutationSpec<AssociateValues> {
  return {
    operation: "job_stack_associate_conversation",
    entity: questionEntity(values.questionId),
    label: "Associate message with an opportunity",
    values,
    body: (v) => ({ questionId: v.questionId, opportunityId: v.opportunityId }),
    optimistic: (cache, v) => patchBody(cache, "question", v.questionId, { status: "associated", opportunityId: v.opportunityId }),
    invalidate: anyOf(recordKind("question"), recordKind("thread")),
  };
}
