import type { PageProps } from "../pageTypes";
import { fields } from "../api";
import { label } from "../api";
export function Overview({
  data,
  opportunities,
  setSelected,
  setSection,
  capture,
}: Pick<
  PageProps,
  "data" | "opportunities" | "setSelected" | "setSection" | "capture"
>) {
  return (
    <>
      <div className="stats">
        {[
          [
            "Active opportunities",
            opportunities.filter(
              (r) =>
                !["rejected", "declined", "withdrawn"].includes(
                  String(fields(r).state),
                ),
            ).length,
          ],
          ["Conversations", data.thread.length],
          [
            "Upcoming interviews",
            data.interview.filter((r) => Number(fields(r).start) > Date.now())
              .length,
          ],
          ["Offers", data.offer.length],
        ].map(([name, n]) => (
          <article key={name}>
            <span>{name}</span>
            <strong>{n}</strong>
            <small>From your recruiting records</small>
          </article>
        ))}
      </div>
      <div className="overviewgrid">
        <section className="panel">
          <div className="panelheading">
            <h2>Opportunity pipeline</h2>
            <button onClick={() => setSection("Opportunities")}>
              View all ↗
            </button>
          </div>
          {opportunities.length ? (
            opportunities.slice(0, 5).map((r) => {
              const v = fields(r);
              return (
                <button
                  className="opportunityrow"
                  key={r.id}
                  onClick={() => {
                    setSelected(r.id);
                    setSection("Opportunities");
                  }}
                >
                  <span className="companymark">
                    {String(v.company).slice(0, 2).toUpperCase()}
                  </span>
                  <span>
                    <strong>{label(v.role)}</strong>
                    <small>{label(v.company)}</small>
                  </span>
                  <span className="badge">{label(v.state)}</span>
                </button>
              );
            })
          ) : (
            <div className="empty">
              <span>↗</span>
              <h3>Make room for the right role.</h3>
              <p>
                Add a listing to assess the fit, build a truthful application,
                and track what happens next.
              </p>
              <button onClick={capture}>Add your first opportunity</button>
            </div>
          )}
        </section>
        <section className="target">
          <p className="eyebrow">TARGETING CONFIGURATION</p>
          <h2>Your selected requirements</h2>
          <p>
            {data.settings.value.targetingProfile
              ? "Private targeting is configured. Assessments use your selected requirements."
              : "Targeting is unconfigured. Compensation, benefits and fit remain unknown."}
          </p>
          <small>
            Undisclosed compensation and benefits stay unknown until verified.
          </small>
        </section>
      </div>
      <section className="panel">
        <h2>Needs your attention</h2>
        {data.question.length +
          data.intents.filter((x) =>
            ["blocked", "failed", "ambiguous"].includes(String(x.state)),
          ).length ===
        0 ? (
          <p className="muted">
            No blocked actions or unresolved recruiting messages.
          </p>
        ) : (
          <>
            <p>{data.question.length} recruiting messages need association.</p>
            {data.intents
              .filter((x) =>
                ["blocked", "failed", "ambiguous"].includes(String(x.state)),
              )
              .map((x) => (
                <p key={String(x.id)}>
                  <span className="badge warning">{label(x.state)}</span>{" "}
                  {label(x.kind)} — {label(x.failure)}
                </p>
              ))}
          </>
        )}
      </section>
    </>
  );
}
