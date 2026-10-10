import type { PageProps } from "../pageTypes";
import { request } from "../api";
import { cards } from "../views";
export function Connections({
  data,
  open,
  setModal,
}: Pick<PageProps, "data" | "value" | "open" | "setModal">) {
  return (
    <>
      <section className="panel">
        <h2>Autonomy and connections</h2>
        <p>
          Discovery, correspondence, and reminders have separate controls.
          Sending begins disabled.
        </p>
        <div className="actions">
          <button
            onClick={() =>
              setModal({
                title: "Connect Google",
                fields: [],
                submit: async () => {
                  const result = await request("/google/connect", {});
                  if (
                    typeof result === "object" &&
                    result !== null &&
                    "url" in result &&
                    typeof result.url === "string"
                  )
                    location.assign(result.url);
                },
              })
            }
          >
            Connect Google
          </button>
          <button
            onClick={() =>
              open(
                "Workspace settings",
                [
                  {
                    name: "settings",
                    label: "Settings (JSON)",
                    kind: "textarea",
                    value: JSON.stringify(data.settings.value, null, 2),
                  },
                ],
                "update_settings",
                (v) => ({
                  ...JSON.parse(v.settings ?? "{}"),
                  revision: data.settings.revision,
                }),
              )
            }
          >
            Edit settings
          </button>
        </div>
        <p className="notice">
          Google grants can cover your mailbox. Job Stack exposes recruiting
          queries and linked threads only. Calendar access is used for free/busy
          and Job Stack interview events.
        </p>
        <pre>{JSON.stringify(data.settings.value, null, 2)}</pre>
      </section>
      {cards(data.connection)}
    </>
  );
}
