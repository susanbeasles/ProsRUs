import type { PageProps } from "../pageTypes";
import { label } from "../api";
export function Activity({ data, open }: Pick<PageProps, "data" | "open">) {
  return (
    <>
      <h2>Action receipts and failures</h2>
      {data.intents.map((x) => (
        <section className="panel" key={String(x.id)}>
          <span className="badge">{label(x.state)}</span>
          <h3>{label(x.kind)}</h3>
          <p>{label(x.failure ?? x.receipt)}</p>
          {x.state === "ambiguous" && (
            <button
              onClick={() =>
                open("Reconcile with provider", [], "reconcile_action", () => ({
                  intentId: x.id,
                }))
              }
            >
              Check provider receipt
            </button>
          )}
        </section>
      ))}
      <section className="panel">
        <h2>Audit trail</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Operation</th>
                <th>Decision</th>
                <th>Actor</th>
              </tr>
            </thead>
            <tbody>
              {data.activity.map((x, i) => (
                <tr key={i}>
                  <td>{new Date(Number(x.created_at)).toLocaleString()}</td>
                  <td>{label(x.operation)}</td>
                  <td>{label(x.decision)}</td>
                  <td>{label(x.actor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
