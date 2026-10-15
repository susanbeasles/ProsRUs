import { describe, expect, it } from "vitest";
import { domainBodySchemas, validateSchema } from "../integration/shared-contract.mjs";
import { coerce, describeSchema, initialRaw, setRaw, type RawObject } from "../dashboard/lib/schemaForm";

function schemaOf(name: string) {
  const schema = domainBodySchemas[name];
  if (!schema) throw Error("missing schema " + name);
  return schema;
}
const raw = (schema: unknown, value?: unknown, overrides = {}) => initialRaw(describeSchema(schema, overrides), value) as RawObject;

describe("schema-driven forms", () => {
  it("describes every catalog domain body schema", () => {
    for (const [name, schema] of Object.entries(domainBodySchemas)) {
      const spec = describeSchema(schema);
      expect(spec.fields.length, name).toBeGreaterThan(0);
    }
  });

  it("produces exactly the declared properties, accepted by the shared validator", () => {
    const schema = schemaOf("capture_opportunity");
    const spec = describeSchema(schema);
    let form = raw(schema);
    form = setRaw(form, "company", "  Synthetic Co  ");
    form = setRaw(form, "role", "Engineer");
    form = setRaw(form, "sourceUrl", "https://example.invalid/jobs/1");
    form = setRaw(form, "description", "A role.");
    form = setRaw(form, "terms.baseUsd", "150000");
    form = setRaw(form, "terms.remote", "yes");
    form = { ...form, injected: "never sent" };
    const { value, errors } = coerce(spec, form);
    expect(errors).toEqual({});
    expect(value).toEqual({
      company: "Synthetic Co",
      role: "Engineer",
      sourceUrl: "https://example.invalid/jobs/1",
      description: "A role.",
      terms: { employment: "full_time", baseUsd: 150000, hourlyUsd: null, remote: true, match401k: null, zeroPremium: null, affordableCare: null },
    });
    expect(() => validateSchema(schema, value)).not.toThrow();
  });

  it("mirrors schema constraints with per-field messages", () => {
    const schema = schemaOf("capture_opportunity");
    let form = raw(schema);
    form = setRaw(form, "company", "x".repeat(201));
    form = setRaw(form, "role", "   ");
    form = setRaw(form, "sourceUrl", "not a url");
    form = setRaw(form, "terms.baseUsd", "-1");
    form = setRaw(form, "terms.hourlyUsd", "abc");
    const { value, errors } = coerce(describeSchema(schema), form);
    expect(value).toBeNull();
    expect(errors).toMatchObject({
      company: "Use at most 200 characters.",
      role: "Required.",
      sourceUrl: "Enter a complete URL, including https://.",
      description: "Required.",
      "terms.baseUsd": "Must be at least 0.",
      "terms.hourlyUsd": "Enter a number.",
    });
  });

  it("validates ids, emails, integers, enums, const confirmations and array bounds", () => {
    const transition = describeSchema(schemaOf("transition_opportunity"), { id: { fixed: "opp_1" }, revision: { fixed: 0 } });
    let form = initialRaw(transition) as RawObject;
    form = setRaw(form, "state", "bogus");
    form = setRaw(form, "evidence", "Called");
    expect(coerce(transition, form).errors).toEqual({ state: "Choose one of the listed options." });
    const submission = describeSchema(schemaOf("record_submission"));
    let s = initialRaw(submission) as RawObject;
    s = setRaw(s, "opportunityId", "bad id!");
    s = setRaw(s, "packetId", "packet_1");
    s = setRaw(s, "receipt", "R");
    s = setRaw(s, "submittedAt", "12.5");
    expect(coerce(submission, s).errors).toEqual({
      opportunityId: "Use 1-100 letters, digits, hyphens or underscores.",
      confirmed: "Confirmation is required.",
    });
    const conversation = describeSchema(schemaOf("capture_thread"));
    let c = initialRaw(conversation) as RawObject;
    c = setRaw(c, "recipient", "someone@example");
    expect(coerce(conversation, c).errors.recipient).toBe("Enter a valid email address.");
    const packet = describeSchema(schemaOf("create_packet"), { claimIds: { widget: "checkboxes", options: [] } });
    let p = initialRaw(packet) as RawObject;
    p = setRaw(p, "opportunityId", "opp_1");
    expect(coerce(packet, p).errors.claimIds).toBe("Choose at least one.");
    p = setRaw(p, "claimIds", ["a", "a"]);
    expect(coerce(packet, p).value).toEqual({ opportunityId: "opp_1", claimIds: ["a", "a"] });
    const review = describeSchema(schemaOf("review_claim"), { id: { fixed: "c" } });
    let r = initialRaw(review) as RawObject;
    r = setRaw(r, "revision", "1.5");
    expect(coerce(review, r).errors.revision).toBe("Enter a whole number.");
    r = setRaw(r, "revision", "0");
    expect(coerce(review, r).errors.revision).toBe("Must be greater than 0.");
  });

  it("injects fixed context values and never renders them", () => {
    const spec = describeSchema(schemaOf("save_draft"), { threadId: { fixed: "thread_1" }, revision: { fixed: 7 } });
    const form = setRaw(initialRaw(spec) as RawObject, "body", "Thanks!");
    expect(coerce(spec, form).value).toEqual({ threadId: "thread_1", revision: 7, body: "Thanks!" });
  });

  it("handles nullable unions, string arrays and arrays of objects (settings)", () => {
    const schema = schemaOf("update_settings");
    const spec = describeSchema(schema, { revision: { fixed: 3 }, "interviewWindows.*.start": { widget: "datetime" }, "interviewWindows.*.end": { widget: "datetime" } });
    let form = initialRaw(spec, { discoveryEnabled: true, approvedRecipients: ["a@example.org"], boards: [{ provider: "lever", company: "acme" }], targetingProfile: { secret: 1 } }) as RawObject;
    form = setRaw(form, "approvedRecipients", "a@example.org\n\nb@example.org\n");
    form = setRaw(form, "interviewWindows", [{ start: "2026-10-20T09:00", end: "2026-10-20T11:00" }]);
    form = setRaw(form, "boards.0.company", "acme_2");
    const { value, errors } = coerce(spec, form);
    expect(errors).toEqual({});
    expect(value).toMatchObject({
      discoveryEnabled: true,
      sender: null,
      calendarId: null,
      approvedRecipients: ["a@example.org", "b@example.org"],
      boards: [{ provider: "lever", company: "acme_2" }],
      revision: 3,
    });
    expect(value).not.toHaveProperty("targetingProfile");
    expect(() => validateSchema(schema, value)).not.toThrow();
    form = setRaw(form, "boards.0.company", "bad slug!");
    form = setRaw(form, "approvedRecipients", "nope");
    expect(coerce(spec, form).errors).toMatchObject({
      "boards.0.company": "This value has an invalid format.",
      approvedRecipients: "Entry 1: Enter a valid email address.",
    });
  });
});
