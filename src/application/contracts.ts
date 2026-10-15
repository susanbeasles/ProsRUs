import { z } from "zod";
import { id, text, termsSchema, settingsSchema, states } from "../domain/model";
export const schemas = {
  reschedule_interview: z
    .object({
      interviewId: id,
      start: z.number(),
      end: z.number(),
      reason: text,
      confirmed: z.literal(true),
      intentId: id,
    })
    .strict(),
  cancel_interview: z
    .object({
      interviewId: id,
      reason: text,
      confirmed: z.literal(true),
      intentId: id,
    })
    .strict(),
  associate_thread: z.object({ questionId: id, opportunityId: id }).strict(),
  resolve_profile_conflict: z
    .object({ questionId: id, value: text, reason: text })
    .strict(),
  add_claim: z
    .object({
      field: text.max(80),
      text,
      sourceIds: z.array(id).max(30),
      permitted: z.boolean(),
    })
    .strict(),
  review_claim: z
    .object({
      id,
      revision: z.number().int().positive(),
      status: z.enum([
        "user_confirmed",
        "source_supported",
        "disputed",
        "unverified",
      ]),
      permitted: z.boolean(),
    })
    .strict(),
  capture_opportunity: z
    .object({
      company: text.max(200),
      role: text.max(200),
      sourceUrl: z.url(),
      description: text,
      terms: termsSchema,
    })
    .strict(),
  assess_opportunity: z
    .object({ id, revision: z.number().int().positive(), terms: termsSchema })
    .strict(),
  transition_opportunity: z
    .object({
      id,
      revision: z.number().int().positive(),
      state: z.enum(states),
      evidence: text,
      confirmed: z.boolean(),
    })
    .strict(),
  create_packet: z
    .object({ opportunityId: id, claimIds: z.array(id).min(1).max(100) })
    .strict(),
  record_submission: z
    .object({
      opportunityId: id,
      packetId: id,
      receipt: text,
      submittedAt: z.number(),
      confirmed: z.literal(true),
    })
    .strict(),
  capture_thread: z
    .object({
      opportunityId: id,
      recipient: z.email(),
      subject: text.max(300),
      message: text,
    })
    .strict(),
  save_draft: z
    .object({ threadId: id, revision: z.number().int().positive(), body: text })
    .strict(),
  send_reply: z
    .object({
      threadId: id,
      revision: z.number().int().positive(),
      intentId: id,
    })
    .strict(),
  schedule_interview: z
    .object({
      opportunityId: id,
      threadId: id,
      start: z.number(),
      end: z.number(),
      title: text.max(200),
      intentId: id,
    })
    .strict(),
  record_offer: z
    .object({
      opportunityId: id,
      baseUsd: z.number().nonnegative(),
      bonusUsd: z.number().nonnegative(),
      equityUsd: z.number().nonnegative(),
      equityType: z.enum(["liquid", "private", "none"]),
      notes: text,
    })
    .strict(),
  prepare_interview: z.object({ interviewId: id }).strict(),
  update_settings: settingsSchema
    .extend({ revision: z.number().int().nonnegative() })
    .strict(),
  reconcile_action: z.object({ intentId: id }).strict(),
  discover: z.object({}).strict(),
  sync_mail: z.object({}).strict(),
  import_document: z.object({ fileId: id }).strict(),
};
export type Operation = keyof typeof schemas;
export type OperationInput<K extends Operation> = z.infer<(typeof schemas)[K]>;
export const threadSchema = z.object({
  id,
  opportunityId: id,
  recipient: z.email(),
  subject: text,
  messages: z.array(z.object({ text, at: z.number() })),
  draft: z.string(),
  status: z.enum(["needs_reply", "draft", "queued", "sent", "blocked"]),
  providerThreadId: z.string().optional(),
  providerLastSentId: z.string().optional(),
  replyMessageId: z.string().optional(),
  flags: z.array(z.string()),
  nextAction: z.string(),
  dueAt: z.number(),
});
export const interviewSchema = z.object({
  id,
  opportunityId: id,
  threadId: id,
  start: z.number(),
  end: z.number(),
  title: z.string(),
  attendee: z.email(),
  eventId: z.string(),
  status: z.enum(["scheduled", "cancelled"]),
  calendarId: z.string(),
});
