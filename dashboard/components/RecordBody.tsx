import { label, objectFields, type ReadRecord } from "../lib/api";
import { formatTime } from "../lib/format";

/** Exact identity and revision of a record, with absence kept distinct from a value. */
export function RecordIdentity({ row }: { row: ReadRecord }) {
  return (
    <p className="muted identity">
      Record: {row.kind} / {row.entityId} ·{" "}
      {row.origin === "generic_archive"
        ? "Row revision: unavailable for generic archive"
        : `${row.origin === "legacy_import" ? "Local observation revision" : "Row revision"}: ${row.revision}`}{" "}
      · Recorded at {formatTime(row.updatedAt)}
    </p>
  );
}

/** Selected body fields as inert text, plus the complete stored body on request. */
export type Formatters = Readonly<Record<string, (value: unknown) => string>>;
export const asTime = (value: unknown) => (typeof value === "number" ? formatTime(value) : label(value));

export function RecordBody({
  row,
  fields,
  formatters = {},
}: {
  row: ReadRecord;
  fields: readonly (readonly [name: string, title: string])[];
  formatters?: Formatters;
}) {
  if (row.bodyStatus !== "available")
    return (
      <section role="note" aria-label="Unavailable record body">
        <h3>Record body unavailable</h3>
        <p>
          {row.bodyStatus === "invalid_json" ? "Stored content is not valid JSON." : "Stored content exceeds the read size limit."}
        </p>
      </section>
    );
  const body = objectFields(row.body);
  return (
    <>
      <dl className="fields">
        {fields.map(([name, title]) => (
          <div key={name}>
            <dt>{title}</dt>
            <dd className="preserve">{Object.hasOwn(body, name) ? (formatters[name] ?? display)(body[name]) : "Not recorded"}</dd>
          </div>
        ))}
      </dl>
      <details>
        <summary>All stored fields</summary>
        <pre>{JSON.stringify(body, null, 2)}</pre>
      </details>
    </>
  );
}

function display(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.length ? value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ") : "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return label(value);
}
