import type { PageProps } from "../pageTypes";
import { fields } from "../api";
import { label } from "../api";
import { cards } from "../views";
import { idValue } from "../views";
export function Conversations({
  data,
  open,
  opportunityField,
}: Pick<PageProps, "data" | "value" | "open" | "opportunityField">) {
  return (
    <>
      <div className="actions">
        <button
          onClick={() =>
            open(
              "Add a recruiting conversation",
              [
                opportunityField,
                {
                  name: "recipient",
                  label: "Recruiter email",
                  kind: "email",
                },
                { name: "subject", label: "Subject" },
                {
                  name: "message",
                  label: "Recruiter message",
                  kind: "textarea",
                },
              ],
              "capture_thread",
              (v) => ({
                ...v,
                opportunityId: idValue(v.opportunityId),
              }),
            )
          }
        >
          + Add conversation
        </button>
        <button
          onClick={() => open("Reconcile recruiting mail", [], "sync_mail")}
        >
          Sync mail
        </button>
      </div>
      {cards(data.thread, (r) => {
        const v = fields(r);
        return (
          <>
            <span className="badge">{label(v.status)}</span>
            <h3>{label(v.subject)}</h3>
            <p>{label(v.recipient)}</p>
            <pre>{JSON.stringify(v.messages, null, 2)}</pre>
            {!!v.draft && <blockquote>{String(v.draft)}</blockquote>}
            <div className="actions">
              <button
                onClick={() =>
                  open(
                    "Compose reply",
                    [
                      {
                        name: "body",
                        label: "Reply",
                        kind: "textarea",
                        value: String(v.draft ?? ""),
                      },
                    ],
                    "save_draft",
                    (v) => ({
                      ...v,
                      threadId: r.id,
                      revision: r.revision,
                    }),
                  )
                }
              >
                Compose
              </button>
              <button
                onClick={() =>
                  open("Send this recruiting reply", [], "send_reply", () => ({
                    threadId: r.id,
                    revision: r.revision,
                    intentId: crypto.randomUUID(),
                  }))
                }
              >
                Send reply
              </button>
            </div>
          </>
        );
      })}
      <h2>Unassociated recruiting messages</h2>
      {cards(
        data.question.filter((r) => fields(r).status !== "associated"),
        (r) => {
          const v = fields(r);
          return (
            <>
              <h3>{label(v.subject ?? v.field)}</h3>
              <p>{label(v.preview ?? v.nextAction)}</p>
              {!!v.providerThreadId && (
                <button
                  onClick={() =>
                    open(
                      "Associate recruiting message",
                      [opportunityField],
                      "associate_thread",
                      (values) => ({
                        questionId: r.id,
                        opportunityId: idValue(values.opportunityId),
                      }),
                    )
                  }
                >
                  Associate with opportunity
                </button>
              )}
            </>
          );
        },
      )}
    </>
  );
}
