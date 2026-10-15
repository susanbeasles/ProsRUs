import { useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { validateSchema } from "../../integration/shared-contract.mjs";
import {
  coerce,
  describeSchema,
  getRaw,
  initialRaw,
  setRaw,
  type FieldErrors,
  type FieldSpec,
  type ObjectField,
  type Overrides,
  type Raw,
  type RawObject,
} from "../lib/schemaForm";

/**
 * Form generated from a catalog body schema. Client validation mirrors the schema; the submitted
 * value contains only declared properties and is checked again with the shared validator.
 */
export function SchemaForm({
  schema,
  overrides,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  validate,
  children,
}: {
  schema: unknown;
  overrides?: Overrides;
  initial?: unknown;
  submitLabel: string;
  onSubmit: (value: Record<string, unknown>) => void;
  onCancel?: () => void;
  /** Extra domain rules (for example confirmation for withdrawals); returns path -> message. */
  validate?: (value: Record<string, unknown>) => FieldErrors;
  children?: ReactNode;
}) {
  const spec = useMemo(() => describeSchema(schema, overrides), [schema, overrides]);
  const [raw, setRawState] = useState<RawObject>(() => initialRaw(spec, initial) as RawObject);
  const [errors, setErrors] = useState<FieldErrors>({});
  const formId = useId();
  const summaryRef = useRef<HTMLDivElement>(null);
  const idFor = (path: string) => formId + "-" + path.replaceAll(".", "-");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = coerce(spec, raw);
    let found: FieldErrors = result.errors;
    if (result.value && validate) found = validate(result.value);
    if (result.value && !Object.keys(found).length) {
      try {
        validateSchema(schema as Record<string, unknown>, result.value);
      } catch {
        found = { "": "This change does not match the operation schema." };
      }
    }
    setErrors(found);
    if (result.value && !Object.keys(found).length) {
      onSubmit(result.value);
      return;
    }
    const first = Object.keys(found)[0];
    const target = first ? document.getElementById(idFor(first)) : null;
    (target ?? summaryRef.current)?.focus();
  }

  function update(path: string, value: Raw) {
    setRawState((current) => setRaw(current, path, value));
  }

  const entries = Object.entries(errors);
  return (
    <form className="schema-form" onSubmit={submit} noValidate>
      {entries.length > 0 && (
        <div className="error form-summary" role="alert" tabIndex={-1} ref={summaryRef}>
          <p>Please correct {entries.length === 1 ? "this field" : `these ${entries.length} fields`}:</p>
          <ul>
            {entries.map(([path, message]) => (
              <li key={path}>
                {path ? <a href={"#" + idFor(path)}>{labelFor(spec, path)}: {message}</a> : message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {spec.fields.map((field) => (
        <Field key={field.path} field={field} raw={raw} errors={errors} idFor={idFor} update={update} />
      ))}
      {children}
      <footer className="form-actions">
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="primary">
          {submitLabel}
        </button>
      </footer>
    </form>
  );
}

function labelFor(spec: ObjectField, path: string): string {
  const parts = path.split(".");
  let fields: readonly FieldSpec[] = spec.fields,
    label = path;
  for (const part of parts) {
    if (/^\d+$/.test(part)) continue;
    const found = fields.find((f) => f.name === part);
    if (!found) break;
    label = found.label;
    fields = found.type === "object" ? found.fields : found.type === "objectArray" ? found.item.fields : [];
  }
  return label;
}

type FieldProps = {
  field: FieldSpec;
  raw: RawObject;
  errors: FieldErrors;
  idFor: (path: string) => string;
  update: (path: string, value: Raw) => void;
  path?: string;
};

function Field({ field, raw, errors, idFor, update, path = field.path }: FieldProps) {
  if (field.fixed) return null;
  const id = idFor(path),
    error = errors[path],
    value = getRaw(raw, path);
  const helpId = field.help ? id + "-help" : undefined,
    errorId = error ? id + "-error" : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;
  const messages = (
    <>
      {field.help && (
        <p id={helpId} className="field-help">
          {field.help}
        </p>
      )}
      {error && (
        <p id={errorId} className="field-error">
          {error}
        </p>
      )}
    </>
  );
  const common = { id, name: path, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy };
  switch (field.type) {
    case "object":
      return (
        <fieldset className="field-group">
          <legend>{field.label}</legend>
          {field.fields.map((child) => (
            <Field
              key={child.path}
              field={child}
              raw={raw}
              errors={errors}
              idFor={idFor}
              update={update}
              path={path + "." + child.name}
            />
          ))}
        </fieldset>
      );
    case "objectArray": {
      const rows = Array.isArray(value) ? (value as RawObject[]) : [];
      const atMax = field.maxItems !== undefined && rows.length >= field.maxItems;
      return (
        <fieldset className="field-group" aria-describedby={describedBy}>
          <legend>{field.label}</legend>
          {rows.length === 0 && <p className="muted">None.</p>}
          {rows.map((_, index) => (
            <fieldset key={index} className="field-row">
              <legend>
                {field.label} {index + 1}
              </legend>
              {field.item.fields.map((child) => (
                <Field
                  key={child.path}
                  field={child}
                  raw={raw}
                  errors={errors}
                  idFor={idFor}
                  update={update}
                  path={`${path}.${index}.${child.name}`}
                />
              ))}
              <button
                type="button"
                onClick={() => update(path, rows.filter((__, i) => i !== index))}
              >
                Remove {field.label.toLowerCase()} {index + 1}
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            id={id}
            disabled={atMax}
            onClick={() => update(path, [...rows, initialRaw(field.item) as RawObject])}
          >
            Add {field.label.toLowerCase()}
          </button>
          {messages}
        </fieldset>
      );
    }
    case "array":
      if (field.checkboxes) {
        const selected = Array.isArray(value) ? (value as string[]) : [];
        return (
          <fieldset className="field-group" aria-describedby={describedBy}>
            <legend>{field.label}</legend>
            {field.checkboxes.length === 0 && <p className="muted">No choices are available.</p>}
            {field.checkboxes.map((option, index) => (
              <label key={option.value} className="check">
                <input
                  type="checkbox"
                  id={index === 0 ? id : undefined}
                  checked={selected.includes(option.value)}
                  onChange={(event) =>
                    update(
                      path,
                      event.target.checked ? [...selected, option.value] : selected.filter((v) => v !== option.value),
                    )
                  }
                />
                {option.label}
              </label>
            ))}
            {messages}
          </fieldset>
        );
      }
      return (
        <div className="field">
          <label htmlFor={id}>
            {field.label} <span className="muted">(one per line)</span>
          </label>
          <textarea {...common} rows={4} value={typeof value === "string" ? value : ""} onChange={(e) => update(path, e.target.value)} />
          {messages}
        </div>
      );
    case "boolean":
      if (field.nullable)
        return (
          <div className="field">
            <label htmlFor={id}>{field.label}</label>
            <select {...common} value={typeof value === "string" ? value : "unknown"} onChange={(e) => update(path, e.target.value)}>
              <option value="unknown">Unknown</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
            {messages}
          </div>
        );
      return (
        <div className="field">
          <label className="check" htmlFor={id}>
            <input {...common} type="checkbox" checked={value === true} onChange={(e) => update(path, e.target.checked)} />
            {field.label}
          </label>
          {messages}
        </div>
      );
    case "enum":
      return (
        <div className="field">
          <label htmlFor={id}>{field.label}</label>
          <select {...common} value={typeof value === "string" ? value : ""} onChange={(e) => update(path, e.target.value)}>
            {field.nullable && <option value="">Unknown</option>}
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {messages}
        </div>
      );
    case "number":
      return (
        <div className="field">
          <label htmlFor={id}>
            {field.label}
            {field.nullable && <span className="muted"> (blank if unknown)</span>}
          </label>
          <input
            {...common}
            type={field.datetime ? "datetime-local" : "number"}
            inputMode={field.datetime ? undefined : field.integer ? "numeric" : "decimal"}
            step={field.datetime ? undefined : field.integer ? 1 : "any"}
            min={field.datetime ? undefined : field.minimum}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => update(path, e.target.value)}
          />
          {messages}
        </div>
      );
    case "string": {
      const text = typeof value === "string" ? value : "";
      return (
        <div className="field">
          <label htmlFor={id}>
            {field.label}
            {field.nullable && <span className="muted"> (blank for none)</span>}
          </label>
          {field.options ? (
            <select {...common} value={text} onChange={(e) => update(path, e.target.value)}>
              {field.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : field.multiline ? (
            <textarea {...common} rows={5} maxLength={field.maxLength} value={text} onChange={(e) => update(path, e.target.value)} />
          ) : (
            <input
              {...common}
              type={field.format === "email" ? "email" : field.format === "uri" ? "url" : "text"}
              maxLength={field.maxLength}
              autoComplete="off"
              value={text}
              onChange={(e) => update(path, e.target.value)}
            />
          )}
          {messages}
        </div>
      );
    }
  }
}
