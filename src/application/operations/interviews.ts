import { claimSchema, demand } from "../../domain/model";
import { interviewSchema, schemas, threadSchema } from "../contracts";
import type { OperationDependencies, OperationRequest } from "../dependencies";
export async function rescheduleInterview(
  { actor, raw, operation }: OperationRequest,
  { store, reserve }: Pick<OperationDependencies, "store" | "reserve">,
) {
  demand(actor.kind === "user", "USER_CONFIRMATION_REQUIRED");
  const input =
    operation === "reschedule_interview"
      ? schemas.reschedule_interview.parse(raw)
      : schemas.cancel_interview.parse(raw);
  const record = await store.get("interview", input.interviewId);
  demand(record, "NOT_FOUND");
  const interview = interviewSchema.parse(record.body);
  demand(interview.status === "scheduled", "INTERVIEW_NOT_ACTIVE");
  return reserve(
    operation === "cancel_interview" ? "cancel" : "reschedule",
    input.intentId,
    {
      interviewId: record.id,
      revision: record.revision,
      calendarId: interview.calendarId,
      eventId: interview.eventId,
      reason: input.reason,
      ...("start" in input && "end" in input
        ? { start: input.start, end: input.end }
        : {}),
    },
  );
}
export async function scheduleInterview(
  { raw }: OperationRequest,
  {
    store,
    settings,
    opportunity,
    reserve,
  }: Pick<
    OperationDependencies,
    "store" | "settings" | "opportunity" | "reserve"
  >,
) {
  const input = schemas.schedule_interview.parse(raw);
  await opportunity(input.opportunityId);
  const r = await store.get("thread", input.threadId);
  demand(r, "THREAD_NOT_FOUND");
  const thread = threadSchema.parse(r.body);
  demand(thread.opportunityId === input.opportunityId, "THREAD_MISMATCH");
  const { value: config } = await settings();
  demand(
    config.calendarId &&
      config.integrationVerified &&
      config.approvedRecipients.includes(thread.recipient),
    "SCHEDULING_DISABLED",
  );
  return reserve("schedule", input.intentId, {
    opportunityId: input.opportunityId,
    threadId: input.threadId,
    start: input.start,
    end: input.end,
    title: input.title,
    attendee: thread.recipient,
    calendarId: config.calendarId,
  });
}
export async function prepareInterview(
  { actor, raw, now }: OperationRequest,
  { store, opportunity }: Pick<OperationDependencies, "store" | "opportunity">,
) {
  const { interviewId } = schemas.prepare_interview.parse(raw);
  const r = await store.get("interview", interviewId);
  demand(r, "NOT_FOUND", 404);
  const interview = interviewSchema.parse(r.body);
  const { value } = await opportunity(interview.opportunityId);
  const claims = (await store.list("claim"))
    .map((x) => claimSchema.parse(x.body))
    .filter(
      (x) =>
        x.permitted &&
        ["source_supported", "user_confirmed"].includes(x.status),
    );
  const prep = {
    interviewId,
    company: value.company,
    role: value.role,
    sourceUrl: value.sourceUrl,
    roleBrief: value.description,
    examples: claims.map((x) => ({
      claim: x.text,
      sources: x.sourceIds,
    })),
    questions: [
      "What outcomes define success in the first six months?",
      "How are technical decisions owned and reviewed?",
      "What recurring meetings and on-call responsibilities are expected?",
      ...value.fit.rationale
        .filter((x) => x.endsWith("unknown"))
        .map((x) => `Please clarify ${x.replace(": unknown", "")}.`),
    ],
    assumptions: [
      "Company information comes from the captured listing; independent research has not been verified.",
    ],
    createdAt: now,
  };
  const existing = await store.get("prep", interviewId);
  return existing ?? store.add("prep", interviewId, prep, actor.id, now);
}
