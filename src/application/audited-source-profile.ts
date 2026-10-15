import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalJson,
  detachedJson,
  freeze,
} from "../../integration/shared-contract.mjs";
import { demand } from "../domain/model";
import { parseEnvelopeJson } from "../domain/recovery-canonical";
export const MAX_AUDITED_PLAN_BYTES = 8 * 1024 * 1024;
export const auditedBuckets = [
  "direct_opportunities",
  "digest_listings",
  "excluded_already_engaged",
  "post_cutoff_new_leads",
] as const;
const identifier = z.string().regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const label = z
  .string()
  .min(6)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$(?![\s\S])/)
  .refine((value) => !value.includes(".."));
const sourceRole = z.object({ label }).strict();
const workspace = z
  .object({ ownerId: identifier.max(100), workspaceId: identifier.max(100) })
  .strict();
const digest = z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
const exactText = z.string().min(1).max(1024);
export const auditedSupplementAssociationSchema = z
  .object({
    roleSourceId: identifier.max(20),
    originalThreadId: exactText,
    messages: z
      .array(z.object({ id: exactText, threadId: exactText }).strict())
      .length(2),
    retrievedAt: z.iso.datetime(),
    displayDecision: z.literal("approval_pending"),
    booking: z.literal("not_confirmed"),
    specificJobDescription: z.literal("not_supplied_in_reply"),
    specificCompensation: z.literal("not_supplied_in_reply"),
    publicRoleMatch: z.literal("unconfirmed"),
  })
  .strict();
const count = z.number().int().nonnegative().max(256);
const fields = {
  format: z.literal("audited-source-profile-v1"),
  workspace,
  seriesId: identifier.max(50),
  sources: z
    .object({
      main: sourceRole,
      outreach: sourceRole,
      coordination: sourceRole,
      notes: sourceRole,
      recruiter_supplement: sourceRole.optional(),
    })
    .strict(),
  sourceOrder: z
    .array(
      z.enum([
        "main",
        "outreach",
        "coordination",
        "notes",
        "recruiter_supplement",
      ]),
    )
    .min(4)
    .max(5),
  expectedCounts: z
    .object({
      direct_opportunities: count,
      digest_listings: count,
      excluded_already_engaged: count,
      post_cutoff_new_leads: count,
      otherClassifications: count,
    })
    .strict(),
  recordIds: z
    .object({
      strategy: z.literal("original-id-and-post-sequence-v1"),
      recordPrefix: identifier.max(64),
      postCutoffPrefix: identifier.max(12),
      postCutoffStart: z.number().int().min(1).max(999999),
      postCutoffPadWidth: z.number().int().min(1).max(6),
    })
    .strict(),
  inventoryFormats: z
    .object({
      base: identifier.max(100),
      supplement: identifier.max(100).optional(),
    })
    .strict(),
  supplementAssociation: auditedSupplementAssociationSchema.optional(),
};
const schema = z
  .discriminatedUnion("identityMode", [
    z
      .object({
        ...fields,
        identityMode: z.literal("legacy-v1"),
        legacyBinding: z
          .object({
            bundleDigest: digest,
            importObservedAt: z.number().int().nonnegative(),
            planSha256: digest,
          })
          .strict(),
      })
      .strict(),
    z.object({ ...fields, identityMode: z.literal("profile-v2") }).strict(),
  ])
  .refine((profile) => {
    const labels = Object.values(profile.sources).map((role) => role.label);
    const roles = auditedBuckets.reduce(
      (total, bucket) => total + profile.expectedCounts[bucket],
      0,
    );
    const supplementary = profile.sources.recruiter_supplement !== undefined;
    const sourceRoles = Object.keys(profile.sources);
    return (
      new Set(profile.sourceOrder).size === sourceRoles.length &&
      profile.sourceOrder.length === sourceRoles.length &&
      profile.sourceOrder.every((role) => sourceRoles.includes(role)) &&
      new Set(labels).size === labels.length &&
      roles > 0 &&
      roles <= 256 &&
      supplementary === (profile.supplementAssociation !== undefined) &&
      supplementary === (profile.inventoryFormats.supplement !== undefined) &&
      (!profile.supplementAssociation ||
        new Set(
          profile.supplementAssociation.messages.map((message) => message.id),
        ).size === 2)
    );
  });
export type CheckedAuditedSourceProfile = z.infer<typeof schema>;
export function parseAuditedSourceProfile(
  value: unknown,
  admission: "file" | "runtime" = "file",
): CheckedAuditedSourceProfile {
  try {
    demand(
      admission === "file" || admission === "runtime",
      "AUDIT_PROFILE_INVALID",
    );
    const maxBytes = admission === "runtime" ? 5000 : 16384;
    if (typeof value === "string") {
      demand(
        new TextEncoder().encode(value).length <= maxBytes,
        "AUDIT_PROFILE_INVALID",
      );
      value = parseEnvelopeJson(value);
    }
    return freeze(schema.parse(detachedJson(value, { maxBytes })));
  } catch {
    demand(false, "AUDIT_PROFILE_INVALID");
  }
}
export function auditedProfileDigest(
  profile: CheckedAuditedSourceProfile,
): string {
  return createHash("sha256")
    .update(canonicalJson(parseAuditedSourceProfile(profile), 16384))
    .digest("hex");
}
export function auditedPlanDigest(plan: unknown): string {
  try {
    return createHash("sha256")
      .update(canonicalJson(plan, MAX_AUDITED_PLAN_BYTES))
      .digest("hex");
  } catch {
    demand(false, "AUDIT_PLAN_ENCODING_OR_SIZE");
  }
}
export function auditedIdentity(profile: CheckedAuditedSourceProfile) {
  return profile.identityMode === "legacy-v1"
    ? {
        source: "audited-json-input-v1" as const,
        role: "audited-legacy-role-v1" as const,
        mapping: "audited-legacy-map-v1" as const,
        receipt: "audited-legacy-import-v1" as const,
      }
    : {
        source: "audited-json-input-v2" as const,
        role: "audited-profile-role-v2" as const,
        mapping: "audited-profile-map-v2" as const,
        receipt: "audited-profile-import-v2" as const,
      };
}
