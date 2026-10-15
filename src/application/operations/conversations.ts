import { z } from "zod";
import { demand } from "../../domain/model";
import { inspectText } from "../../domain/rules";
import { schemas, threadSchema } from "../contracts";
import type { OperationDependencies, OperationRequest } from "../dependencies";
export async function associateThread(
  { actor, raw, now }: OperationRequest,
  { store, opportunity }: Pick<OperationDependencies, "store" | "opportunity">,
) {
  const input = schemas.associate_thread.parse(raw);
  await opportunity(input.opportunityId);
  const r = await store.get("question", input.questionId);
  demand(r, "NOT_FOUND");
  const mail = z
    .object({
      providerThreadId: z.string(),
      recipient: z.email(),
      subject: z.string(),
      preview: z.string(),
      replyMessageId: z.string().optional(),
      flags: z.array(z.string()),
    })
    .parse(r.body);
  const threadId = `gmail-${mail.providerThreadId}`;
  const existing = await store.get("thread", threadId);
  if (existing) return existing;
  const thread = await store.add(
    "thread",
    threadId,
    {
      id: threadId,
      opportunityId: input.opportunityId,
      recipient: mail.recipient,
      subject: mail.subject,
      messages: [{ text: mail.preview, at: r.updatedAt }],
      draft: "",
      status: mail.flags.length ? "blocked" : "needs_reply",
      providerThreadId: mail.providerThreadId,
      replyMessageId: mail.replyMessageId,
      flags: mail.flags,
      nextAction: "Compose recruiting reply",
      dueAt: now + 86400000,
    },
    actor.id,
    now,
  );
  await store.update(
    "question",
    r.id,
    { ...mail, status: "associated", threadId },
    r.revision,
    actor.id,
    now,
  );
  return thread;
}
export async function captureThread(
  { actor, raw, now }: OperationRequest,
  { store, opportunity }: Pick<OperationDependencies, "store" | "opportunity">,
) {
  const input = schemas.capture_thread.parse(raw);
  await opportunity(input.opportunityId);
  const id = crypto.randomUUID();
  const flags = inspectText(input.message);
  return store.add(
    "thread",
    id,
    {
      id,
      opportunityId: input.opportunityId,
      recipient: input.recipient,
      subject: input.subject,
      messages: [{ text: input.message, at: now }],
      draft: "",
      status: flags.length ? "blocked" : "needs_reply",
      flags,
      nextAction: "Compose a recruiting reply",
      dueAt: now + 86400000,
    },
    actor.id,
    now,
  );
}
export async function saveDraft(
  { actor, raw, now }: OperationRequest,
  { store }: Pick<OperationDependencies, "store">,
) {
  const input = schemas.save_draft.parse(raw);
  const r = await store.get("thread", input.threadId);
  demand(r, "NOT_FOUND", 404);
  const thread = threadSchema.parse(r.body);
  demand(!inspectText(input.body).length, "DRAFT_REVIEW_REQUIRED");
  return store.update(
    "thread",
    r.id,
    { ...thread, draft: input.body, status: "draft" },
    input.revision,
    actor.id,
    now,
  );
}
export async function sendReply(
  { raw }: OperationRequest,
  {
    store,
    settings,
    reserve,
  }: Pick<OperationDependencies, "store" | "settings" | "reserve">,
) {
  const input = schemas.send_reply.parse(raw);
  const r = await store.get("thread", input.threadId);
  demand(r, "NOT_FOUND", 404);
  demand(r.revision === input.revision, "REVISION_CONFLICT", 409);
  const thread = threadSchema.parse(r.body);
  const { value: config } = await settings();
  demand(
    config.sendingEnabled &&
      config.correspondenceEnabled &&
      config.profileResolved &&
      config.integrationVerified &&
      config.sender,
    "SENDING_DISABLED",
  );
  demand(
    config.approvedRecipients.includes(thread.recipient) &&
      !thread.flags.length &&
      thread.draft.trim(),
    "REPLY_NOT_AUTHORIZED",
  );
  return reserve("send", input.intentId, {
    threadId: r.id,
    revision: r.revision,
    recipient: thread.recipient,
    subject: thread.subject,
    body: thread.draft,
    from: config.sender,
    providerThreadId: thread.providerThreadId,
    replyMessageId: thread.replyMessageId,
  });
}
