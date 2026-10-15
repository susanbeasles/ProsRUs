import { denyLegacyOperation } from "../application/commands/registry";
import { z } from "zod";
import {
  demand,
  DomainError,
  type Settings,
  opportunitySchema,
} from "../domain/model";
import { validateSlot, inspectText } from "../domain/rules";
import type { Store, Intent } from "../storage/store";
import type { Google } from "../providers/google";
import { ProviderFailure } from "../providers/http";
import { digest } from "../identity/vault";
import { threadSchema, interviewSchema } from "../application/contracts";
import { failureDisposition } from "./failure";
import { syncMail } from "./mail";
export type ActionDependencies = {
  store: Store;
  owner: string;
  google: () => Promise<Google>;
  settings: () => Promise<{ value: Settings }>;
  now: () => number;
};
const sendSchema = z.object({
  threadId: z.string(),
  revision: z.number(),
  recipient: z.email(),
  subject: z.string(),
  body: z.string(),
  from: z.email(),
  providerThreadId: z.string().optional(),
  replyMessageId: z.string().optional(),
});
const scheduleSchema = z.object({
  opportunityId: z.string(),
  threadId: z.string(),
  start: z.number(),
  end: z.number(),
  title: z.string(),
  attendee: z.email(),
  calendarId: z.string(),
});
export function createActions(deps: ActionDependencies) {
  const { store, owner } = deps;
  async function send(intent: Intent, google: Google, config: Settings) {
    const input = sendSchema.parse(JSON.parse(intent.payload));
    demand(
      config.sendingEnabled &&
        config.correspondenceEnabled &&
        config.profileResolved &&
        config.integrationVerified &&
        config.sender === input.from &&
        config.approvedRecipients.includes(input.recipient),
      "SENDING_DISABLED",
    );
    const r = await store.get("thread", input.threadId);
    demand(r && r.revision === input.revision, "STALE_DRAFT");
    const thread = threadSchema.parse(r.body);
    demand(
      !thread.flags.length && !inspectText(input.body).length,
      "REVIEW_REQUIRED",
    );
    return google.send({
      from: input.from,
      to: input.recipient,
      subject: input.subject,
      body: input.body,
      messageId: `${intent.id}@job-stack.invalid`,
      threadId: input.providerThreadId,
      inReplyTo: input.replyMessageId,
    });
  }
  async function schedule(intent: Intent, google: Google, config: Settings) {
    const input = scheduleSchema.parse(JSON.parse(intent.payload));
    demand(
      config.integrationVerified &&
        config.calendarId === input.calendarId &&
        config.approvedRecipients.includes(input.attendee),
      "SCHEDULING_DISABLED",
    );
    const local = (await store.list("interview"))
      .map((r) => interviewSchema.parse(r.body))
      .filter((interview) => interview.status !== "cancelled");
    const busy = await google.freeBusy(
      input.calendarId,
      input.start,
      input.end,
    );
    validateSlot({
      ...input,
      windows: config.interviewWindows,
      busy: [...busy, ...local],
      now: deps.now(),
    });
    return google.createInterview({
      ...input,
      eventId: (await digest(`${owner}:${intent.id}`)).slice(0, 40),
      owner,
      remindersEnabled: config.remindersEnabled,
    });
  }
  async function project(intent: Intent, receipt: unknown) {
    if (intent.kind === "send") {
      const input = sendSchema.parse(JSON.parse(intent.payload));
      const saved = z
        .object({ id: z.string(), threadId: z.string() })
        .parse(receipt);
      const r = await store.get("thread", input.threadId);
      demand(r, "THREAD_NOT_FOUND");
      const thread = threadSchema.parse(r.body);
      // Preserve a newer draft while repairing the receipt projection.
      if (thread.providerLastSentId !== saved.id)
        await store.update(
          "thread",
          r.id,
          {
            ...thread,
            providerLastSentId: saved.id,
            providerThreadId: saved.threadId,
            ...(r.revision === input.revision
              ? { status: "sent", draft: "", nextAction: "Await reply" }
              : {}),
          },
          r.revision,
          owner,
          deps.now(),
        );
    } else if (intent.kind === "schedule") {
      const input = scheduleSchema.parse(JSON.parse(intent.payload));
      const saved = z.object({ id: z.string() }).parse(receipt);
      if (!(await store.get("interview", intent.id)))
        await store.add(
          "interview",
          intent.id,
          { ...input, id: intent.id, eventId: saved.id, status: "scheduled" },
          owner,
          deps.now(),
        );
      const { value: config } = await deps.settings();
      if (config.remindersEnabled)
        for (const minutes of [1440, 60, 10]) {
          const id = `${intent.id}-${minutes}`;
          if (!(await store.get("reminder", id)))
            await store.add(
              "reminder",
              id,
              {
                interviewId: intent.id,
                dueAt: input.start - minutes * 60000,
                minutes,
                status: minutes === 1440 ? "pending" : "provider_configured",
                delivery: "unverified",
                provider:
                  minutes === 1440 ? "job_stack_email" : "google_calendar",
              },
              owner,
              deps.now(),
            );
        }
      const op = await store.get("opportunity", input.opportunityId);
      if (op) {
        const value = opportunitySchema.parse(op.body);
        if (["submitted", "recruiter_screen"].includes(value.state))
          await store.update(
            "opportunity",
            op.id,
            {
              ...value,
              state: "interviewing",
              nextAction: "Prepare for scheduled interview",
            },
            op.revision,
            owner,
            deps.now(),
          );
      }
    } else if (intent.kind === "cancel" || intent.kind === "reschedule") {
      const input = z
        .object({
          interviewId: z.string(),
          start: z.number().optional(),
          end: z.number().optional(),
        })
        .parse(JSON.parse(intent.payload));
      const r = await store.get("interview", input.interviewId);
      demand(r, "NOT_FOUND");
      const interview = interviewSchema.parse(r.body);
      await store.update(
        "interview",
        r.id,
        {
          ...interview,
          ...(intent.kind === "cancel"
            ? { status: "cancelled" }
            : { start: input.start, end: input.end }),
        },
        r.revision,
        owner,
        deps.now(),
      );
      for (const reminder of await store.list("reminder")) {
        const body = z
          .object({ interviewId: z.string(), minutes: z.number() })
          .passthrough()
          .parse(reminder.body);
        if (body.interviewId === r.id)
          await store.update(
            "reminder",
            reminder.id,
            {
              ...body,
              ...(intent.kind === "cancel"
                ? { status: "cancelled" }
                : {
                    dueAt: Number(input.start) - body.minutes * 60000,
                    status:
                      body.minutes === 1440 ? "pending" : "provider_configured",
                  }),
            },
            reminder.revision,
            owner,
            deps.now(),
          );
      }
    } else if (intent.kind === "notify") {
      const { reminderId } = z
        .object({ reminderId: z.string() })
        .parse(JSON.parse(intent.payload));
      const r = await store.get("reminder", reminderId);
      if (r) {
        const body = z.record(z.string(), z.unknown()).parse(r.body);
        await store.update(
          "reminder",
          r.id,
          { ...body, status: "sent", delivery: "provider_receipt", receipt },
          r.revision,
          owner,
          deps.now(),
        );
      }
    }
  }
  async function reconcile(intent: Intent, google: Google) {
    const { intentId } = z
      .object({ intentId: z.string() })
      .parse(JSON.parse(intent.payload));
    const target = await store.intent(intentId);
    demand(target, "INTENT_NOT_FOUND");
    demand(
      ["ambiguous", "failed", "running"].includes(target.state),
      "NOT_RECONCILABLE",
    );
    let receipt: unknown;
    if (target.receipt) receipt = JSON.parse(target.receipt);
    else if (target.kind === "send") {
      const found = await google.findSent(`${intentId}@job-stack.invalid`);
      demand(found.messages?.length === 1, "PROVIDER_OUTCOME_UNRESOLVED", 409);
      receipt = found.messages[0];
    } else if (target.kind === "schedule") {
      const input = scheduleSchema.parse(JSON.parse(target.payload));
      const event = z
        .object({
          id: z.string(),
          extendedProperties: z.object({
            private: z.object({ jobStackOwner: z.string() }),
          }),
        })
        .passthrough()
        .parse(
          await google.event(
            input.calendarId,
            (await digest(`${owner}:${intentId}`)).slice(0, 40),
          ),
        );
      demand(
        event.extendedProperties.private.jobStackOwner === owner,
        "EVENT_NOT_OWNED",
      );
      receipt = event;
    } else throw new DomainError("MANUAL_RECONCILIATION_REQUIRED");
    await store.saveReceipt(target.id, JSON.stringify(receipt), deps.now());
    await store.claimIntent(target.id, deps.now());
    await project(target, receipt);
    await store.finishIntent(
      target.id,
      "succeeded",
      deps.now(),
      JSON.stringify(receipt),
    );
    return { target: target.id, receipt };
  }
  async function changeInterview(
    intent: Intent,
    google: Google,
    config: Settings,
  ) {
    const input = z
      .object({
        interviewId: z.string(),
        revision: z.number(),
        calendarId: z.string(),
        eventId: z.string(),
        start: z.number().optional(),
        end: z.number().optional(),
      })
      .parse(JSON.parse(intent.payload));
    const r = await store.get("interview", input.interviewId);
    demand(r && r.revision === input.revision, "STALE_INTERVIEW");
    const event = z
      .object({
        id: z.string(),
        etag: z.string(),
        extendedProperties: z.object({
          private: z.object({ jobStackOwner: z.string() }),
        }),
      })
      .parse(await google.event(input.calendarId, input.eventId));
    demand(
      event.extendedProperties.private.jobStackOwner === owner,
      "EVENT_NOT_OWNED",
    );
    if (intent.kind === "cancel")
      return google.changeInterview({
        ...input,
        etag: event.etag,
        body: { status: "cancelled" },
      });
    demand(input.start && input.end, "INVALID_SLOT");
    const busy = await google.freeBusy(
      input.calendarId,
      input.start,
      input.end,
    );
    validateSlot({
      start: input.start,
      end: input.end,
      windows: config.interviewWindows,
      busy,
      now: deps.now(),
    });
    return google.changeInterview({
      ...input,
      etag: event.etag,
      body: {
        start: { dateTime: new Date(input.start).toISOString() },
        end: { dateTime: new Date(input.end).toISOString() },
      },
    });
  }
  async function notify(intent: Intent, google: Google, config: Settings) {
    demand(
      config.remindersEnabled &&
        config.integrationVerified &&
        config.notificationEmail &&
        config.sender,
      "NOTIFICATIONS_DISABLED",
    );
    const input = z
      .object({
        reminderId: z.string(),
        interviewId: z.string(),
        body: z.string(),
      })
      .parse(JSON.parse(intent.payload));
    return google.send({
      from: config.sender,
      to: config.notificationEmail,
      subject: "Interview preparation reminder",
      body: input.body,
      messageId: `${intent.id}@job-stack.invalid`,
    });
  }
  async function perform(id: string): Promise<Intent | null> {
    denyLegacyOperation("queue");
    const intent = await store.intent(id);
    demand(intent, "INTENT_NOT_FOUND");
    if (!(await store.claimIntent(id, deps.now()))) return intent;
    let receipt: unknown = intent.receipt
      ? JSON.parse(intent.receipt)
      : undefined;
    try {
      if (receipt === undefined) {
        const { value: config } = await deps.settings();
        const google = await deps.google();
        switch (intent.kind) {
          case "send":
            receipt = await send(intent, google, config);
            break;
          case "schedule":
            receipt = await schedule(intent, google, config);
            break;
          case "cancel":
          case "reschedule":
            receipt = await changeInterview(intent, google, config);
            break;
          case "notify":
            receipt = await notify(intent, google, config);
            break;
          case "sync":
            demand(config.correspondenceEnabled, "CORRESPONDENCE_PAUSED");
            receipt = await syncMail(google, store, owner, deps.now());
            break;
          case "reconcile":
            receipt = await reconcile(intent, google);
            break;
          default:
            throw new DomainError("UNKNOWN_ACTION");
        }
        await store.saveReceipt(id, JSON.stringify(receipt), deps.now());
      }
      await project(intent, receipt);
      await store.finishIntent(
        id,
        "succeeded",
        deps.now(),
        JSON.stringify(receipt),
      );
      await store.audit(
        owner,
        `${intent.kind}.completed`,
        id,
        "allow",
        deps.now(),
      );
    } catch (error) {
      const disposition = failureDisposition(
        error instanceof z.ZodError &&
          ["send", "schedule", "cancel", "reschedule", "notify"].includes(
            intent.kind,
          )
          ? new ProviderFailure("INVALID_PROVIDER_RECEIPT", true)
          : error,
        intent.attempts + 1,
        receipt !== undefined,
      );
      if (disposition === "retry" || disposition === "reproject") {
        if (receipt !== undefined)
          await store.saveReceipt(id, JSON.stringify(receipt), deps.now());
        await store.retryIntent(id, deps.now());
      } else {
        await store.finishIntent(
          id,
          disposition,
          deps.now(),
          null,
          error instanceof DomainError || error instanceof ProviderFailure
            ? error.code
            : "ACTION_FAILED",
        );
      }
      await store.audit(owner, "action.failed", id, disposition, deps.now());
    }
    return store.intent(id);
  }
  return { perform };
}
