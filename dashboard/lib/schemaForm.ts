/**
 * Schema-driven forms over the catalog's closed JSON Schema vocabulary. describeSchema() turns a
 * domain body schema into field descriptors; coerce() converts raw input into exactly the declared
 * properties and reports per-field errors that mirror validateSchema() in the shared contract.
 */
type Schema = Readonly<Record<string, unknown>>;

export type Option = { readonly value: string; readonly label: string };
export type FieldOverride = {
  readonly label?: string;
  readonly help?: string;
  /** Always sent with this value and never rendered (ids, revisions, confirmations bound to context). */
  readonly fixed?: unknown;
  readonly widget?: "textarea" | "datetime" | "checkboxes" | "lines";
  readonly options?: readonly Option[];
};
export type Overrides = Readonly<Record<string, FieldOverride>>;

type Base = {
  readonly path: string;
  readonly name: string;
  readonly label: string;
  readonly help: string | undefined;
  readonly nullable: boolean;
  readonly optional: boolean;
  readonly fixed: { readonly value: unknown } | undefined;
};
export type StringField = Base & {
  readonly type: "string";
  readonly minLength: number;
  readonly maxLength: number | undefined;
  readonly pattern: string | undefined;
  readonly format: "email" | "uri" | undefined;
  readonly multiline: boolean;
  readonly options: readonly Option[] | undefined;
};
export type NumberField = Base & {
  readonly type: "number";
  readonly integer: boolean;
  readonly minimum: number | undefined;
  readonly maximum: number | undefined;
  readonly exclusiveMinimum: number | undefined;
  readonly datetime: boolean;
};
export type BooleanField = Base & { readonly type: "boolean"; readonly mustBeTrue: boolean };
export type EnumField = Base & { readonly type: "enum"; readonly options: readonly Option[] };
export type ArrayField = Base & {
  readonly type: "array";
  readonly item: StringField | EnumField;
  readonly minItems: number;
  readonly maxItems: number | undefined;
  readonly uniqueItems: boolean;
  readonly checkboxes: readonly Option[] | undefined;
};
export type ObjectField = Base & { readonly type: "object"; readonly fields: readonly FieldSpec[] };
export type ObjectArrayField = Base & {
  readonly type: "objectArray";
  readonly item: ObjectField;
  readonly minItems: number;
  readonly maxItems: number | undefined;
};
export type FieldSpec = StringField | NumberField | BooleanField | EnumField | ArrayField | ObjectField | ObjectArrayField;

export type RawObject = { [name: string]: Raw };
export type Raw = string | boolean | readonly string[] | RawObject | readonly RawObject[];
export type FieldErrors = Readonly<Record<string, string>>;

/** Owner-facing names for catalog body properties. */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  company: "Company",
  role: "Role",
  sourceUrl: "Listing URL",
  description: "Listing description",
  terms: "Terms",
  employment: "Employment",
  baseUsd: "Base salary (USD)",
  hourlyUsd: "Hourly rate (USD)",
  remote: "Remote eligibility",
  match401k: "Employer 401(k) match",
  zeroPremium: "Zero employee health premium",
  affordableCare: "Affordable visits and prescriptions",
  state: "New state",
  evidence: "Evidence for this change",
  confirmed: "I confirm this change",
  field: "Field",
  text: "Exact claim",
  sourceIds: "Evidence IDs",
  permitted: "Permitted in applications",
  status: "Evidence status",
  questionId: "Question ID",
  value: "Authoritative value",
  reason: "Why this is correct",
  opportunityId: "Opportunity ID",
  claimIds: "Claims to include",
  packetId: "Packet ID",
  receipt: "Submission receipt",
  submittedAt: "Submitted at (your time zone)",
  recipient: "Recruiter email",
  subject: "Subject",
  message: "Recruiter message",
  threadId: "Conversation ID",
  body: "Draft reply",
  interviewId: "Interview ID",
  bonusUsd: "Bonus (USD)",
  equityUsd: "Equity value (USD)",
  equityType: "Equity type",
  notes: "Notes",
  discoveryEnabled: "Discovery enabled",
  correspondenceEnabled: "Correspondence enabled",
  remindersEnabled: "Reminders enabled",
  sendingEnabled: "Sending preference",
  profileResolved: "Profile resolved",
  integrationVerified: "Integration verified",
  sender: "Sender address",
  notificationEmail: "Notification email",
  calendarId: "Calendar ID",
  interviewWindows: "Interview windows",
  approvedRecipients: "Approved recipients",
  boards: "Job boards",
  provider: "Provider",
  start: "Start (your time zone)",
  end: "End (your time zone)",
};

export function humanize(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function asSchema(value: unknown): Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Schema) : {};
}
function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
function optionsOf(values: readonly unknown[]): Option[] {
  return values.filter((v): v is string => typeof v === "string").map((value) => ({ value, label: value.replaceAll("_", " ") }));
}
function overrideFor(overrides: Overrides, path: string): FieldOverride {
  return overrides[path] ?? overrides[path.replace(/\.\d+\./g, ".*.")] ?? {};
}

/** Unwraps {anyOf:[X,{type:"null"}]} and {type:[X,"null"]}. */
function unwrapNullable(schema: Schema): { schema: Schema; nullable: boolean } {
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf) && anyOf.length === 2) {
    const nonNull = anyOf.map(asSchema).filter((s) => s.type !== "null");
    if (nonNull.length === 1 && nonNull[0]) return { schema: nonNull[0], nullable: true };
  }
  if (Array.isArray(schema.type) && schema.type.length === 2 && schema.type.includes("null")) {
    const type = schema.type.find((t) => t !== "null");
    return { schema: { ...schema, type }, nullable: true };
  }
  return { schema, nullable: false };
}

function describe(raw: Schema, name: string, path: string, optional: boolean, overrides: Overrides): FieldSpec {
  const { schema, nullable } = unwrapNullable(raw);
  const override = overrideFor(overrides, path);
  const base: Base = {
    path,
    name,
    label: override.label ?? FIELD_LABELS[name] ?? humanize(name),
    help: override.help,
    nullable,
    optional,
    fixed: Object.hasOwn(override, "fixed") ? { value: override.fixed } : undefined,
  };
  const type = schema.type;
  if (type === "object") {
    const properties = asSchema(schema.properties);
    const required = Array.isArray(schema.required) ? schema.required : [];
    return {
      ...base,
      type: "object",
      fields: Object.entries(properties).map(([child, childSchema]) =>
        describe(asSchema(childSchema), child, path ? path + "." + child : child, !required.includes(child), overrides),
      ),
    };
  }
  if (type === "array") {
    const items = asSchema(schema.items);
    const minItems = num(schema.minItems) ?? 0,
      maxItems = num(schema.maxItems);
    if (items.type === "object") {
      const item = describe(items, name, path + ".*", false, overrides);
      if (item.type !== "object") throw Error("Unsupported array item schema");
      return { ...base, type: "objectArray", item, minItems, maxItems };
    }
    const item = describe(items, name, path + ".*", false, overrides);
    if (item.type !== "string" && item.type !== "enum") throw Error("Unsupported array item schema");
    return {
      ...base,
      type: "array",
      item,
      minItems,
      maxItems,
      uniqueItems: schema.uniqueItems === true,
      checkboxes: override.widget === "checkboxes" ? (override.options ?? []) : undefined,
    };
  }
  if (type === "string" && Array.isArray(schema.enum)) return { ...base, type: "enum", options: override.options ?? optionsOf(schema.enum) };
  if (type === "string") {
    const maxLength = num(schema.maxLength);
    return {
      ...base,
      type: "string",
      minLength: num(schema.minLength) ?? 0,
      maxLength,
      pattern: typeof schema.pattern === "string" ? schema.pattern : undefined,
      format: schema.format === "email" || schema.format === "uri" ? schema.format : undefined,
      multiline: override.widget === "textarea" || (override.widget === undefined && (maxLength ?? 0) > 2000),
      options: override.options,
    };
  }
  if (type === "number" || type === "integer")
    return {
      ...base,
      type: "number",
      integer: type === "integer",
      minimum: num(schema.minimum),
      maximum: num(schema.maximum),
      exclusiveMinimum: num(schema.exclusiveMinimum),
      datetime: override.widget === "datetime",
    };
  if (type === "boolean") return { ...base, type: "boolean", mustBeTrue: schema.const === true };
  throw Error("Unsupported schema for field " + (path || "(root)"));
}

export function describeSchema(schema: unknown, overrides: Overrides = {}): ObjectField {
  const root = describe(asSchema(schema), "", "", false, overrides);
  if (root.type !== "object") throw Error("A form schema must describe an object");
  return root;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}
/** Local datetime-local text for epoch milliseconds. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function initialRaw(field: FieldSpec, value?: unknown): Raw {
  switch (field.type) {
    case "object": {
      const source = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
      const result: RawObject = {};
      for (const child of field.fields) result[child.name] = initialRaw(child, source[child.name]);
      return result;
    }
    case "objectArray":
      return Array.isArray(value) ? value.map((item) => initialRaw(field.item, item) as RawObject) : [];
    case "array": {
      const items = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      return field.checkboxes ? items : items.join("\n");
    }
    case "boolean":
      if (field.nullable) return value === true ? "yes" : value === false ? "no" : "unknown";
      return value === true;
    case "number":
      if (typeof value !== "number") return "";
      return field.datetime ? toLocalInput(value) : String(value);
    case "enum":
      return typeof value === "string" ? value : field.nullable ? "" : (field.options[0]?.value ?? "");
    case "string":
      return typeof value === "string" ? value : (field.options?.[0]?.value ?? "");
  }
}

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_PATTERN = "^[A-Za-z0-9_-]{1,100}$";

function stringError(field: StringField | EnumField, value: string): string | null {
  if (field.type === "enum")
    return field.options.some((o) => o.value === value) ? null : "Choose one of the listed options.";
  if (value.length < field.minLength || (field.minLength > 0 && !value.trim()))
    return field.minLength <= 1 ? "Required." : `Use at least ${field.minLength} characters.`;
  if (field.maxLength !== undefined && value.length > field.maxLength) return `Use at most ${field.maxLength} characters.`;
  if (field.format === "email" && !EMAIL_FORMAT.test(value)) return "Enter a valid email address.";
  if (field.format === "uri") {
    try {
      new URL(value);
    } catch {
      return "Enter a complete URL, including https://.";
    }
  }
  if (field.pattern && !new RegExp(field.pattern).test(value))
    return field.format === "email"
      ? "Enter a valid email address."
      : field.pattern === ID_PATTERN
        ? "Use 1-100 letters, digits, hyphens or underscores."
        : "This value has an invalid format.";
  return null;
}

type Result = { value: unknown; omit: boolean };

function coerceField(field: FieldSpec, raw: Raw | undefined, errors: Record<string, string>): Result {
  if (field.fixed) return { value: field.fixed.value, omit: false };
  const fail = (message: string): Result => {
    errors[field.path] = message;
    return { value: undefined, omit: false };
  };
  switch (field.type) {
    case "object": {
      const source = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as RawObject) : {};
      const value: Record<string, unknown> = {};
      for (const child of field.fields) {
        const result = coerceField(child, source[child.name], errors);
        if (!result.omit) value[child.name] = result.value;
      }
      return { value, omit: false };
    }
    case "objectArray": {
      const rows = Array.isArray(raw) ? (raw as RawObject[]) : [];
      if (rows.length < field.minItems) return fail(`Add at least ${field.minItems}.`);
      if (field.maxItems !== undefined && rows.length > field.maxItems) return fail(`Use at most ${field.maxItems}.`);
      return {
        value: rows.map((row, index) => coerceField(rebase(field.item, field.item.path, `${field.path}.${index}`), row, errors).value),
        omit: false,
      };
    }
    case "array": {
      const items = Array.isArray(raw)
        ? (raw as string[])
        : typeof raw === "string"
          ? raw.split("\n").map((line) => line.trim()).filter(Boolean)
          : [];
      if (!items.length && field.optional) return { value: undefined, omit: true };
      if (items.length < field.minItems) return fail(field.minItems === 1 ? "Choose at least one." : `Choose at least ${field.minItems}.`);
      if (field.maxItems !== undefined && items.length > field.maxItems) return fail(`Use at most ${field.maxItems}.`);
      if (field.uniqueItems && new Set(items).size !== items.length) return fail("Remove duplicate entries.");
      for (const [index, item] of items.entries()) {
        const message = stringError(field.item, item);
        if (message) return fail(`Entry ${index + 1}: ${message}`);
      }
      return { value: items, omit: false };
    }
    case "boolean": {
      if (field.nullable) {
        if (raw === "unknown") return { value: null, omit: false };
        if (raw === "yes" || raw === "no") return { value: raw === "yes", omit: false };
        return fail("Choose yes, no or unknown.");
      }
      if (field.mustBeTrue && raw !== true) return fail("Confirmation is required.");
      return { value: raw === true, omit: false };
    }
    case "number": {
      const text = typeof raw === "string" ? raw.trim() : "";
      if (!text) {
        if (field.nullable) return { value: null, omit: false };
        if (field.optional) return { value: undefined, omit: true };
        return fail("Required.");
      }
      const value = field.datetime ? Date.parse(text) : Number(text);
      if (!Number.isFinite(value)) return fail(field.datetime ? "Enter a date and time." : "Enter a number.");
      if (field.integer && !Number.isSafeInteger(value)) return fail("Enter a whole number.");
      if (field.minimum !== undefined && value < field.minimum) return fail(`Must be at least ${field.minimum}.`);
      if (field.exclusiveMinimum !== undefined && value <= field.exclusiveMinimum)
        return fail(`Must be greater than ${field.exclusiveMinimum}.`);
      if (field.maximum !== undefined && value > field.maximum) return fail(`Must be at most ${field.maximum}.`);
      return { value, omit: false };
    }
    case "enum":
    case "string": {
      const text = typeof raw === "string" ? (field.type === "string" && field.multiline ? raw : raw.trim()) : "";
      if (!text) {
        if (field.nullable) return { value: null, omit: false };
        if (field.optional) return { value: undefined, omit: true };
      }
      const message = stringError(field, text);
      return message ? fail(message) : { value: text, omit: false };
    }
  }
}

function rebase(field: ObjectField, from: string, to: string): ObjectField {
  const move = (child: FieldSpec): FieldSpec => {
    const path = to + child.path.slice(from.length);
    if (child.type === "object") return { ...child, path, fields: child.fields.map(move) };
    return { ...child, path };
  };
  return { ...field, path: to, fields: field.fields.map(move) };
}

/** Raw input -> exactly the declared properties, or null with per-path messages. */
export function coerce(field: ObjectField, raw: RawObject): { value: Record<string, unknown> | null; errors: FieldErrors } {
  const errors: Record<string, string> = {};
  const { value } = coerceField(field, raw, errors);
  return Object.keys(errors).length ? { value: null, errors } : { value: value as Record<string, unknown>, errors };
}

/** Immutable update of one raw value by dotted path (array indices included). */
export function setRaw(root: RawObject, path: string, value: Raw): RawObject {
  const [head, ...rest] = path.split(".");
  if (head === undefined) return root;
  if (!rest.length) return { ...root, [head]: value };
  const child = root[head];
  if (Array.isArray(child) && rest[0] !== undefined && /^\d+$/.test(rest[0])) {
    const index = Number(rest[0]);
    const rows = [...(child as RawObject[])];
    const row = rows[index] ?? {};
    rows[index] = rest.length === 1 ? (value as RawObject) : setRaw(row, rest.slice(1).join("."), value);
    return { ...root, [head]: rows };
  }
  const nested = typeof child === "object" && child !== null && !Array.isArray(child) ? (child as RawObject) : {};
  return { ...root, [head]: setRaw(nested, rest.join("."), value) };
}

export function getRaw(root: RawObject, path: string): Raw | undefined {
  let current: Raw | undefined = root;
  for (const part of path.split(".")) {
    if (Array.isArray(current)) current = (current as readonly RawObject[])[Number(part)];
    else if (typeof current === "object" && current !== null) current = (current as RawObject)[part];
    else return undefined;
  }
  return current;
}
