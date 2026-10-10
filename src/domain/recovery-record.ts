import { profileFieldSchema } from "./profile-field";
import { z } from "zod";
import {
  claimSchema,
  id,
  opportunitySchema,
  settingsSchema,
  demand,
} from "./model";
import { canonicalizeEnvelope, parseEnvelopeJson } from "./recovery-canonical";

export const domainRecordKinds = [
  "claim",
  "opportunity",
  "packet",
  "thread",
  "interview",
  "offer",
  "artifact",
  "reminder",
  "settings",
  "attempt",
  "prep",
  "question",
] as const;
export const domainRecordKindSchema = z.enum(domainRecordKinds);
export type DomainRecordKind = z.infer<typeof domainRecordKindSchema>;
export const domainTimeSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const domainRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
// Stored business URLs must not inherit Zod URL's trim/tab/newline rewrites.
// This remains non-transforming even inside accepted-plan or prepared schemas.
const storedUrl = z
  .string()
  .min(1)
  .max(2000)
  .regex(/^\S(?:[^\t\r\n]*\S)?$/)
  .refine((value) => {
    const parsed = z.url().safeParse(value);
    return parsed.success && parsed.data === value;
  }, "DOMAIN_BODY_NORMALIZATION_FORBIDDEN")
  .meta({ format: "uri" });
const shortText = z.string().max(20000);
const label = z.string().max(1024);
const strings = z.array(shortText).max(128);
const ids = z
  .array(id)
  .max(128)
  .refine((v) => new Set(v).size === v.length, "DUPLICATE_DOMAIN_ID");
const strictClaim = claimSchema
  .extend({
    field: z.string().min(1).max(80),
    text: z.string().min(1).max(20000),
    sourceIds: ids.max(30),
    flags: strings.optional(),
  })
  .strict();
const factSchema = z
  .object({
    field: profileFieldSchema,
    value: shortText,
    sourceId: id,
  })
  .strict();
const packetSchema = z
  .object({
    id,
    opportunityId: id,
    company: shortText,
    role: shortText,
    claims: z.array(strictClaim).max(100),
    resume: shortText,
    coverNote: shortText,
    claimIds: ids,
    claimDigest: z.string().regex(/^[a-f0-9]{64}$/),
    artifactKey: label,
    createdAt: domainTimeSchema,
  })
  .strict();
const threadSchema = z
  .object({
    id,
    opportunityId: id,
    recipient: z.email(),
    subject: shortText,
    messages: z
      .array(z.object({ text: shortText, at: domainTimeSchema }).strict())
      .max(128),
    draft: shortText,
    status: z.enum(["needs_reply", "draft", "queued", "sent", "blocked"]),
    providerThreadId: label.optional(),
    providerLastSentId: label.optional(),
    replyMessageId: label.optional(),
    flags: strings,
    nextAction: shortText,
    dueAt: domainTimeSchema,
  })
  .strict();
const interviewSchema = z
  .object({
    id,
    opportunityId: id,
    threadId: id,
    start: domainTimeSchema,
    end: domainTimeSchema,
    title: shortText,
    attendee: z.email(),
    eventId: label,
    status: z.enum(["scheduled", "cancelled"]),
    calendarId: label,
  })
  .strict()
  .refine((v) => v.end > v.start, "INVALID_INTERVIEW_INTERVAL");
const offerSchema = z
  .object({
    opportunityId: id,
    baseUsd: z.number().nonnegative(),
    bonusUsd: z.number().nonnegative(),
    equityUsd: z.number().nonnegative(),
    equityType: z.enum(["liquid", "private", "none"]),
    notes: shortText,
    status: z.literal("recorded"),
    recordedAt: domainTimeSchema,
  })
  .strict();
const artifactSchema = z
  .object({
    id,
    name: label,
    key: label,
    flags: strings,
    facts: z.array(factSchema).max(128),
    status: z.enum(["review_required", "available"]),
    createdAt: domainTimeSchema,
  })
  .strict();
const reminderSchema = z
  .object({
    interviewId: id,
    dueAt: z
      .number()
      .int()
      .min(-Number.MAX_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER),
    minutes: z.union([z.literal(1440), z.literal(60), z.literal(10)]),
    status: z.enum(["pending", "provider_configured", "cancelled", "sent"]),
    delivery: z.enum(["unverified", "provider_receipt"]),
    provider: z.enum(["job_stack_email", "google_calendar"]),
    receipt: z
      .object({ id: label, threadId: label.optional() })
      .strict()
      .optional(),
  })
  .strict();
const attemptSchema = z
  .object({
    opportunityId: id,
    packetId: id,
    receipt: shortText,
    submittedAt: domainTimeSchema,
    confirmed: z.literal(true),
  })
  .strict();
const prepSchema = z
  .object({
    interviewId: id,
    company: shortText,
    role: shortText,
    sourceUrl: storedUrl,
    roleBrief: shortText,
    examples: z
      .array(z.object({ claim: shortText, sources: ids }).strict())
      .max(128),
    questions: strings,
    assumptions: strings,
    createdAt: domainTimeSchema,
  })
  .strict();
const profileQuestionSchema = z
  .object({
    type: z.literal("profile_conflict"),
    field: profileFieldSchema,
    values: z.array(factSchema).max(128),
    status: z.enum(["unresolved", "resolved"]),
    nextAction: shortText,
    confirmedValue: shortText.optional(),
    reason: shortText.optional(),
  })
  .strict();
const mailQuestionSchema = z
  .object({
    providerThreadId: label,
    recipient: z.email(),
    subject: shortText,
    preview: shortText,
    replyMessageId: label.optional(),
    flags: strings,
    nextAction: shortText.optional(),
    messageId: label.optional(),
    status: z.enum(["unassociated", "associated"]),
    threadId: id.optional(),
  })
  .strict();
const strictOpportunity = opportunitySchema
  .extend({
    sourceUrl: storedUrl,
    company: z.string().min(1).max(200),
    role: z.string().min(1).max(200),
    description: z.string().min(1).max(20000),
    nextAction: z.string().min(1).max(500),
    createdAt: domainTimeSchema,
    lastSeenAt: domainTimeSchema.optional(),
    dueAt: domainTimeSchema.nullable(),
    flags: strings,
    fit: opportunitySchema.shape.fit.extend({ rationale: strings }).strict(),
  })
  .strict();
const strictSettings = settingsSchema
  .extend({
    interviewWindows: z
      .array(
        z
          .object({ start: domainTimeSchema, end: domainTimeSchema })
          .strict()
          .refine((v) => v.end > v.start),
      )
      .max(100),
    boards: z
      .array(
        z
          .object({
            provider: z.enum(["greenhouse", "lever"]),
            company: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
const snapshotFields = {
  formatVersion: z.literal(1),
  type: z.literal("domain_record"),
  entityId: id,
  revision: domainRevisionSchema,
  updatedAt: domainTimeSchema,
};
function record<K extends DomainRecordKind, T extends z.ZodType>(
  recordKind: K,
  body: T,
) {
  return z
    .object({ ...snapshotFields, recordKind: z.literal(recordKind), body })
    .strict();
}
export const domainRecordSnapshotSchema = z
  .discriminatedUnion("recordKind", [
    record("claim", strictClaim),
    record("opportunity", strictOpportunity),
    record("packet", packetSchema),
    record("thread", threadSchema),
    record("interview", interviewSchema),
    record("offer", offerSchema),
    record("artifact", artifactSchema),
    record("reminder", reminderSchema),
    record("settings", strictSettings),
    record("attempt", attemptSchema),
    record("prep", prepSchema),
    record("question", z.union([profileQuestionSchema, mailQuestionSchema])),
  ])
  .refine(
    (v) => !("id" in v.body) || v.body.id === v.entityId,
    "DOMAIN_RECORD_ID_MISMATCH",
  )
  .readonly();
export type DomainRecordSnapshot = z.infer<typeof domainRecordSnapshotSchema>;
export const recoveryKindForRecord = {
  claim: "claim",
  opportunity: "opportunity",
  packet: "packet",
  thread: "conversation",
  interview: "interview",
  offer: "offer",
  artifact: "artifact",
  reminder: "reminder",
  settings: "settings",
  attempt: "external_receipt",
  prep: "prep_brief",
  question: "question",
} as const;

/** Validate descriptors before schemas can read properties. Parsing also detaches aliases;
 * schema transforms may not silently change a stored business body. */
export function detachedDomainValue(value: unknown): unknown {
  return parseEnvelopeJson(
    new TextDecoder().decode(canonicalizeEnvelope(value)),
  );
}
export function parseDomainRecordSnapshot(
  value: unknown,
): DomainRecordSnapshot {
  const detached = detachedDomainValue(value);
  const parsed = domainRecordSnapshotSchema.parse(detached);
  demand(
    new TextDecoder().decode(canonicalizeEnvelope(parsed)) ===
      new TextDecoder().decode(canonicalizeEnvelope(detached)),
    "DOMAIN_BODY_NORMALIZATION_FORBIDDEN",
  );
  return parsed;
}

/** A deliberately narrow safe quarantine: only known, typed claim fields may be
 * retained when required fields are missing. Unknown fields/other malformed models
 * fail closed and remain untouched at their source; no arbitrary raw export exists. */
export const quarantinedLegacyClaimSchema = z
  .object({
    ...snapshotFields,
    type: z.literal("legacy_record_quarantine"),
    recordKind: z.literal("claim"),
    body: strictClaim.partial().strict(),
    reason: z.literal("incomplete_legacy_claim"),
  })
  .strict()
  .refine(
    (v) =>
      !strictClaim.safeParse(v.body).success &&
      (!v.body.id || v.body.id === v.entityId),
    "INVALID_LEGACY_QUARANTINE",
  );
export const domainRecoverySnapshotSchema = z.union([
  domainRecordSnapshotSchema,
  quarantinedLegacyClaimSchema,
]);
export function parseDomainRecoverySnapshot(value: unknown) {
  const detached = detachedDomainValue(value);
  const parsed = domainRecoverySnapshotSchema.parse(detached);
  demand(
    new TextDecoder().decode(canonicalizeEnvelope(parsed)) ===
      new TextDecoder().decode(canonicalizeEnvelope(detached)),
    "DOMAIN_BODY_NORMALIZATION_FORBIDDEN",
  );
  return parsed;
}
