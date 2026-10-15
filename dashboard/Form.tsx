import { useState, type FormEvent } from "react";
export type Field = {
  name: string;
  label: string;
  kind?: "text" | "number" | "textarea" | "select" | "email" | "datetime-local";
  options?: string[];
  value?: string;
  required?: boolean;
};
export function Form({
  title,
  fields,
  onSubmit,
  onClose,
}: {
  title: string;
  fields: Field[];
  onSubmit: (values: Record<string, string>) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const values = Object.fromEntries(
      [...data.entries()].map(([k, v]) => [k, String(v)]),
    );
    try {
      await onSubmit(values);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="overlay">
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <form onSubmit={submit}>
          {fields.map((f) => (
            <label key={f.name}>
              {f.label}
              {f.kind === "textarea" ? (
                <textarea
                  name={f.name}
                  defaultValue={f.value ?? ""}
                  required={f.required !== false}
                  rows={5}
                />
              ) : f.kind === "select" ? (
                <select name={f.name} defaultValue={f.value ?? f.options?.[0]}>
                  {f.options?.map((o) => (
                    <option key={o} value={o}>
                      {o.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  name={f.name}
                  type={f.kind ?? "text"}
                  defaultValue={f.value ?? ""}
                  required={f.required !== false}
                />
              )}
            </label>
          ))}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <footer>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
