import type { Row } from "./api";
import { fields, label } from "./api";
export function idValue(v: string | undefined) {
  return v?.split("|")[0] ?? "";
}
export function cards(rows: Row[], render?: (row: Row) => React.ReactNode) {
  return rows.length ? (
    <div className="cards">
      {rows.map((row) => (
        <article className="card" key={row.id}>
          {render ? (
            render(row)
          ) : (
            <>
              <h3>
                {label(
                  fields(row).name ??
                    fields(row).title ??
                    fields(row).subject ??
                    fields(row).role ??
                    fields(row).provider ??
                    fields(row).status,
                )}
              </h3>
              <pre>{JSON.stringify(row.body, null, 2)}</pre>
            </>
          )}
        </article>
      ))}
    </div>
  ) : (
    <div className="empty">
      <span>↗</span>
      <h3>Nothing here yet</h3>
      <p>Your recruiting work will appear here as you add it.</p>
    </div>
  );
}
