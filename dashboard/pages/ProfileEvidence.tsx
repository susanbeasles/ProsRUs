import type { PageProps } from "../pageTypes";
import { fields } from "../api";
import { label } from "../api";
import { request } from "../api";
import { cards } from "../views";
export function ProfileEvidence({
  data,
  open,
  setModal,
  refresh,
}: Pick<PageProps, "data" | "value" | "open" | "setModal" | "refresh">) {
  return (
    <>
      <div className="actions">
        <button
          onClick={() =>
            open(
              "Add a career claim",
              [
                {
                  name: "field",
                  label:
                    "Field (achievement, phone, education, employment dates…)",
                },
                {
                  name: "text",
                  label: "Exact claim",
                  kind: "textarea",
                },
                {
                  name: "sourceIds",
                  label: "Evidence IDs (comma separated)",
                  required: false,
                },
                {
                  name: "permitted",
                  label: "Permitted in applications?",
                  kind: "select",
                  options: ["false", "true"],
                },
              ],
              "add_claim",
              (v) => ({
                ...v,
                sourceIds:
                  v.sourceIds
                    ?.split(",")
                    .map((x) => x.trim())
                    .filter(Boolean) ?? [],
                permitted: v.permitted === "true",
              }),
            )
          }
        >
          + Add claim
        </button>
        <button
          onClick={() =>
            setModal({
              title: "Add source evidence",
              fields: [
                { name: "name", label: "Document name" },
                {
                  name: "text",
                  label: "Plain text evidence",
                  kind: "textarea",
                },
              ],
              submit: async (v) => {
                await request("/api/upload", v);
                await refresh();
              },
            })
          }
        >
          + Add evidence
        </button>
      </div>
      <p className="notice">
        Claims begin unverified. Review source conflicts before allowing a claim
        in an application.
      </p>
      {cards(data.claim, (r) => {
        const v = fields(r);
        return (
          <>
            <span className="badge">{label(v.status)}</span>
            <h3>{label(v.field)}</h3>
            <p>{label(v.text)}</p>
            <small className="muted">Claim ID: {r.id}</small>
            <button
              onClick={() =>
                open(
                  "Review career claim",
                  [
                    {
                      name: "status",
                      label: "Evidence status",
                      kind: "select",
                      options: [
                        "user_confirmed",
                        "source_supported",
                        "disputed",
                        "unverified",
                      ],
                      value: String(v.status),
                    },
                    {
                      name: "permitted",
                      label: "Permitted disclosure",
                      kind: "select",
                      options: ["true", "false"],
                      value: String(v.permitted),
                    },
                  ],
                  "review_claim",
                  (v) => ({
                    ...v,
                    id: r.id,
                    revision: r.revision,
                    permitted: v.permitted === "true",
                  }),
                )
              }
            >
              Review claim
            </button>
          </>
        );
      })}
      <h2>Profile conflicts</h2>
      {cards(
        data.question.filter((r) => fields(r).type === "profile_conflict"),
        (r) => (
          <>
            <h3>{label(fields(r).field)}</h3>
            <span className="badge">{label(fields(r).status)}</span>
            <pre>{JSON.stringify(fields(r).values, null, 2)}</pre>
            <button
              onClick={() =>
                open(
                  "Resolve profile conflict",
                  [
                    { name: "value", label: "Authoritative value" },
                    {
                      name: "reason",
                      label: "Why this is correct",
                      kind: "textarea",
                    },
                  ],
                  "resolve_profile_conflict",
                  (v) => ({ ...v, questionId: r.id }),
                )
              }
            >
              Confirm correct value
            </button>
          </>
        ),
      )}
      <h2>Source evidence</h2>
      <button
        onClick={() =>
          open(
            "Import a selected Google Doc",
            [{ name: "fileId", label: "Google Doc file ID" }],
            "import_document",
          )
        }
      >
        Import selected Google Doc
      </button>
      {cards(data.artifact, (r) => (
        <>
          <h3>{label(fields(r).name)}</h3>
          <p>ID: {r.id}</p>
          <p>{label(fields(r).status)}</p>
          <pre>{JSON.stringify(fields(r).flags)}</pre>
          <a href={`/owner/job-stack/api/artifacts/${r.id}`}>Download source</a>
        </>
      ))}
    </>
  );
}
