import type { PageProps } from "../pageTypes";
import { fields } from "../api";
import { label } from "../api";
import { cards } from "../views";
import { idValue } from "../views";
export function Interviews({
  data,
  open,
  opportunityField,
  threadField,
}: Pick<PageProps, "data" | "open" | "opportunityField" | "threadField">) {
  return (
    <>
      <button
        onClick={() =>
          open(
            "Schedule interview",
            [
              opportunityField,
              threadField,
              { name: "title", label: "Interview title" },
              {
                name: "start",
                label: "Start (your browser timezone)",
                kind: "datetime-local",
              },
              {
                name: "end",
                label: "End (your browser timezone)",
                kind: "datetime-local",
              },
            ],
            "schedule_interview",
            (v) => ({
              ...v,
              opportunityId: idValue(v.opportunityId),
              threadId: idValue(v.threadId),
              start: Date.parse(v.start ?? ""),
              end: Date.parse(v.end ?? ""),
              intentId: crypto.randomUUID(),
            }),
          )
        }
      >
        + Schedule interview
      </button>
      {cards(data.interview, (r) => {
        const v = fields(r);
        return (
          <>
            <h3>{label(v.title)}</h3>
            <p>{new Date(Number(v.start)).toLocaleString()}</p>
            <p>{label(v.attendee)}</p>
            <span className="badge">{label(v.status)}</span>
            <button
              onClick={() =>
                open("Prepare for interview", [], "prepare_interview", () => ({
                  interviewId: r.id,
                }))
              }
            >
              Build preparation sheet
            </button>
            <div className="actions">
              <button
                onClick={() =>
                  open(
                    "Reschedule interview",
                    [
                      {
                        name: "start",
                        label: "New start",
                        kind: "datetime-local",
                      },
                      {
                        name: "end",
                        label: "New end",
                        kind: "datetime-local",
                      },
                      {
                        name: "reason",
                        label: "Confirmed recruiting instruction",
                        kind: "textarea",
                      },
                    ],
                    "reschedule_interview",
                    (v) => ({
                      ...v,
                      start: Date.parse(v.start ?? ""),
                      end: Date.parse(v.end ?? ""),
                      interviewId: r.id,
                      confirmed: true,
                      intentId: crypto.randomUUID(),
                    }),
                  )
                }
              >
                Reschedule
              </button>
              <button
                onClick={() =>
                  open(
                    "Cancel interview",
                    [
                      {
                        name: "reason",
                        label: "Confirmed cancellation instruction",
                        kind: "textarea",
                      },
                    ],
                    "cancel_interview",
                    (v) => ({
                      ...v,
                      interviewId: r.id,
                      confirmed: true,
                      intentId: crypto.randomUUID(),
                    }),
                  )
                }
              >
                Cancel interview
              </button>
            </div>
          </>
        );
      })}
      <h2>Preparation</h2>
      {cards(data.prep)}
      <h2>Reminder status</h2>
      {cards(data.reminder)}
    </>
  );
}
