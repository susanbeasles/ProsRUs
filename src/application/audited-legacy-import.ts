import { createHash } from "node:crypto";
import { z } from "zod";
import { demand } from "../domain/model";
import {
  auditedPipelineView,
  rawObject,
  type RawObject,
  type Observation,
} from "../domain/audited-pipeline-view";
import {
  canonicalJson,
  detachedJson,
} from "../../integration/shared-contract.mjs";
import {
  auditedBuckets,
  auditedIdentity,
  auditedPlanDigest,
  auditedProfileDigest,
  auditedSupplementAssociationSchema,
  parseAuditedSourceProfile,
  type CheckedAuditedSourceProfile,
} from "./audited-source-profile";
const supplementSchema = z
  .object({
    retrieved_at: z.iso.datetime(),
    source: z.literal("connected Gmail read_email_thread"),
    purpose: z.string(),
    messages: z
      .array(
        z
          .object({
            id: z.string(),
            thread_id: z.string(),
            internal_date: z.string().regex(/^[0-9]+$/),
            headers: z.array(
              z.object({ name: z.string(), value: z.string() }).strict(),
            ),
            parts: z.array(
              z
                .object({
                  mime_type: z.enum(["text/plain", "text/html"]),
                  body: z.string(),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .length(2),
    interpretation: z
      .object({
        approval: z.string(),
        role_match: z.string(),
        scheduling: z.string(),
      })
      .strict(),
  })
  .strict();
const workspaceSchema = z
  .object({
    ownerId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  })
  .strict();
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const items = (value: unknown) => z.array(rawObject).parse(value ?? []);
const text = (value: unknown) => (typeof value === "string" ? value : null);
export function createAuditedSchemas(profile: CheckedAuditedSourceProfile) {
  const identity = auditedIdentity(profile);
  const auditedSourceNames = Object.values(profile.sources).map(
    (role) => role.label,
  );
  const supplementBindingSchema = auditedSupplementAssociationSchema;
  const boundProfile =
    profile.identityMode === "profile-v2"
      ? { profileDigest: z.literal(auditedProfileDigest(profile)) }
      : {};
  const receiptSchema = z
    .object({
      name: z.enum(auditedSourceNames),
      rawSha256: z.string().regex(/^[a-f0-9]{64}$/),
      sizeBytes: z.number().int().min(1).max(524288),
      supplementBinding: supplementBindingSchema.optional(),
    })
    .passthrough();
  const inputSchema = z
    .object({
      sources: z
        .array(
          z
            .object({
              name: z.enum(auditedSourceNames),
              bytes: z.instanceof(Uint8Array),
              receipt: receiptSchema,
            })
            .strict(),
        )
        .min(4)
        .max(5),
      workspace: workspaceSchema,
      seriesId: z.string().regex(/^[A-Za-z0-9_-]{1,50}$/),
      observedAt: z.number().int().nonnegative(),
    })
    .strict();
  const auditedRoleSchema = z
    .object({
      format: z.literal(identity.role),
      source: z
        .object({
          seriesId: z.string(),
          bundleDigest: z.string().regex(/^[a-f0-9]{64}$/),
          name: z.literal(profile.sources.main.label),
          rawSha256: z.string().regex(/^[a-f0-9]{64}$/),
          pointer: z.string(),
          sourceId: z.string(),
          sourceIdIsOriginal: z.boolean(),
          classification: z.enum([
            "direct_opportunities",
            "digest_listings",
            "excluded_already_engaged",
            "post_cutoff_new_leads",
          ]),
        })
        .strict(),
      raw: rawObject,
      relatedEvidence: z.array(
        z
          .object({
            source: z.enum(auditedSourceNames),
            pointer: z.string(),
            basis: z.string(),
            raw: rawObject,
            observedAt: z.string().nullable(),
          })
          .strict(),
      ),
      display: z
        .object({
          company: z.string(),
          role: z.string(),
          status: z.enum([
            "closed",
            "pending",
            "active",
            "waiting",
            "unreviewed",
          ]),
          stage: z.string(),
          inPipeline: z.boolean(),
          summary: z.string(),
          verifiedAt: z.string().nullable(),
          approval: z.literal("No current pursuit or action approval"),
          history: z.literal("legacy_unversioned"),
          protection: z.literal("import_pending"),
          overlaySources: z.array(
            z.object({ source: z.string(), pointer: z.string() }).strict(),
          ),
        })
        .strict(),
      import: z
        .object({
          observedAt: z.number().int().nonnegative(),
          ...boundProfile,
          mappingVersion: z.literal(identity.mapping),
        })
        .strict(),
      sourceRevision: z.null(),
    })
    .strict();
  const auditedSourceSchema = z
    .object({
      format: z.literal(identity.source),
      ...boundProfile,
      seriesId: z.string(),
      name: z.enum(auditedSourceNames),
      rawSha256: z.string().regex(/^[a-f0-9]{64}$/),
      sizeBytes: z.number().int().positive(),
      rawUtf8: z.string(),
      importObservedAt: z.number().int().nonnegative(),
      mappingVersion: z.literal(identity.mapping),
      sourceReceipt: receiptSchema,
    })
    .strict();
  return {
    input: inputSchema,
    role: auditedRoleSchema,
    source: auditedSourceSchema,
    receipt: receiptSchema,
    supplementBinding: supplementBindingSchema,
  };
}
export function planAuditedImport(value: unknown, suppliedProfile: unknown) {
  const profile = parseAuditedSourceProfile(suppliedProfile);
  const identity = auditedIdentity(profile),
    auditedMappingVersion = identity.mapping;
  const auditedBaseSourceNames = [
    profile.sources.main.label,
    profile.sources.outreach.label,
    profile.sources.coordination.label,
    profile.sources.notes.label,
  ];
  const auditedSupplementName = profile.sources.recruiter_supplement?.label;
  const {
    input: inputSchema,
    role: auditedRoleSchema,
    source: auditedSourceSchema,
    supplementBinding: supplementBindingSchema,
  } = createAuditedSchemas(profile);
  const input = inputSchema.parse(value);
  demand(
    input.workspace.ownerId === profile.workspace.ownerId &&
      input.workspace.workspaceId === profile.workspace.workspaceId &&
      input.seriesId === profile.seriesId,
    "AUDIT_PROFILE_TARGET",
  );
  const boundProfile =
    profile.identityMode === "profile-v2"
      ? { profileDigest: auditedProfileDigest(profile) }
      : {};
  const names = input.sources.map((s) => s.name);
  const orderedLabels = profile.sourceOrder
    .map((role) => profile.sources[role]?.label)
    .filter(
      (label): label is string => label !== undefined && names.includes(label),
    );
  demand(
    orderedLabels.length === names.length &&
      orderedLabels.every((name, i) => names[i] === name),
    "AUDIT_SOURCE_ORDER",
  );
  demand(
    new Set(names).size === input.sources.length &&
      auditedBaseSourceNames.every((n) => names.includes(n)),
    "AUDIT_SOURCE_SET",
  );
  const sourceRows = input.sources.map((source) => {
    demand(
      source.bytes.length === source.receipt.sizeBytes &&
        source.name === source.receipt.name &&
        digest(source.bytes) === source.receipt.rawSha256,
      "AUDIT_SOURCE_HASH",
    );
    const rawUtf8 = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(source.bytes);
    demand(
      digest(new TextEncoder().encode(rawUtf8)) === source.receipt.rawSha256,
      "AUDIT_SOURCE_ENCODING",
    );
    const parsed = rawObject.parse(
      detachedJson(JSON.parse(rawUtf8), { maxBytes: 524288 }),
    );
    return { source, rawUtf8, parsed };
  });
  const byName = (name: string) => {
    const found = sourceRows.find((s) => s.source.name === name);
    demand(found, "AUDIT_SOURCE_SET");
    return found;
  };
  const main = byName(profile.sources.main.label),
    out = byName(profile.sources.outreach.label).parsed,
    afternoon = byName(profile.sources.coordination.label).parsed,
    notes = items(byName(profile.sources.notes.label).parsed.call_notes);
  const extra = sourceRows.find((s) => s.source.name === auditedSupplementName);
  const supplement = extra
    ? {
        data: supplementSchema.parse(extra.parsed),
        binding: supplementBindingSchema.parse(
          extra.source.receipt.supplementBinding,
        ),
      }
    : null;
  for (const source of sourceRows)
    if (source !== extra)
      demand(
        source.source.receipt.supplementBinding === undefined,
        "AUDIT_UNEXPECTED_SUPPLEMENT_BINDING",
      );
  if (supplement) {
    demand(
      canonicalJson(supplement.binding) ===
        canonicalJson(profile.supplementAssociation),
      "AUDIT_SUPPLEMENT_PROFILE",
    );
    demand(
      supplement.data.retrieved_at === supplement.binding.retrievedAt &&
        new Set(supplement.data.messages.map((m) => m.id)).size === 2,
      "AUDIT_SUPPLEMENT_RECEIPT",
    );
    for (const [i, message] of supplement.data.messages.entries()) {
      const expected = supplement.binding.messages[i];
      demand(
        expected &&
          message.id === expected.id &&
          message.thread_id === expected.threadId &&
          Number.isSafeInteger(Number(message.internal_date)) &&
          Number(message.internal_date) <=
            Date.parse(supplement.data.retrieved_at),
        "AUDIT_SUPPLEMENT_JOIN",
      );
    }
    demand(
      supplement.data.messages[0]?.thread_id ===
        supplement.binding.originalThreadId,
      "AUDIT_SUPPLEMENT_JOIN",
    );
  }
  const sourceReceipts = sourceRows
    .map((s) => s.source.receipt)
    .sort((a, b) => a.name.localeCompare(b.name));
  const bundleDigest = digest(
    canonicalJson({
      mappingVersion: auditedMappingVersion,
      ...boundProfile,
      seriesId: input.seriesId,
      workspace: input.workspace,
      sources: sourceReceipts,
    }),
  );
  const seen = new Set<string>();
  const records = [];
  let supplementAttachments = 0;
  const buckets = auditedBuckets;
  demand(
    items(main.parsed.other_classifications).length ===
      profile.expectedCounts.otherClassifications,
    "AUDIT_CLASSIFICATION_COUNT",
  );
  for (const bucket of buckets) {
    const values = items(main.parsed[bucket]);
    demand(
      values.length === profile.expectedCounts[bucket],
      "AUDIT_ROLE_COUNT",
    );
    for (const [i, raw] of values.entries()) {
      const sourceId =
        bucket === "post_cutoff_new_leads"
          ? profile.recordIds.postCutoffPrefix +
            String(i + profile.recordIds.postCutoffStart).padStart(
              profile.recordIds.postCutoffPadWidth,
              "0",
            )
          : z
              .string()
              .regex(/^[A-Za-z0-9_-]{1,20}$/)
              .parse(raw.id);
      demand(!seen.has(sourceId), "AUDIT_DUPLICATE_ID");
      seen.add(sourceId);
      const evidence: Observation[] = [];
      const add = (
        source: string,
        pointer: string,
        basis: string,
        observation: RawObject,
        observedAt: string | null,
      ) =>
        evidence.push({ source, pointer, basis, raw: observation, observedAt });
      const receipt = rawObject.safeParse(raw.after_cutoff_outreach);
      for (const [j, action] of items(out.actions).entries())
        if (
          action.opportunity_id === sourceId ||
          (receipt.success &&
            action.message_id !== undefined &&
            action.message_id === receipt.data.sent_message_id &&
            action.thread_id === receipt.data.thread_id)
        )
          add(
            profile.sources.outreach.label,
            "/actions/" + j,
            "exact opportunity or sent-message/thread receipt",
            action,
            text(action.sent_at) ?? text(out.as_of),
          );
      for (const [source, document] of [
        [profile.sources.main.label, main.parsed],
        [profile.sources.outreach.label, out],
        [profile.sources.coordination.label, afternoon],
      ] as const) {
        const runs =
          source === profile.sources.coordination.label
            ? [document]
            : items(document.coordination_runs);
        for (const [r, run] of runs.entries()) {
          const prefix =
            source === profile.sources.coordination.label
              ? ""
              : "/coordination_runs/" + r;
          const time = text(run.as_of);
          const booking = rawObject.safeParse(run.booking);
          if (booking.success && booking.data.opportunity_id === sourceId)
            add(
              source,
              prefix + "/booking",
              "exact opportunity_id",
              booking.data,
              time,
            );
          for (const [u, update] of items(run.updates).entries()) {
            const linked =
              update.opportunity_id === sourceId ||
              (Array.isArray(update.opportunity_ids) &&
                update.opportunity_ids.includes(sourceId));
            const exactNote = notes.filter(
              (n) =>
                n.opportunity_id === sourceId &&
                n.company === raw.company &&
                n.company === update.company,
            );
            if (linked || exactNote.length === 1)
              add(
                source,
                prefix + "/updates/" + u,
                linked
                  ? "exact opportunity_id(s)"
                  : "exact existing call-note identity basis",
                update,
                time,
              );
          }
          for (const [n, lead] of items(run.new_low_priority_leads).entries())
            if (
              bucket === "post_cutoff_new_leads" &&
              canonicalJson(lead) === canonicalJson(raw)
            )
              add(
                source,
                prefix + "/new_low_priority_leads/" + n,
                "same complete source observation",
                lead,
                time,
              );
        }
        for (const [j, booking] of items(document.bookings).entries())
          if (booking.opportunity_id === sourceId)
            add(
              source,
              "/bookings/" + j,
              "exact opportunity_id",
              booking,
              text(document.as_of),
            );
      }
      for (const [j, note] of notes.entries())
        if (note.opportunity_id === sourceId)
          add(
            profile.sources.notes.label,
            "/call_notes/" + j,
            "exact opportunity_id; index only",
            note,
            text(note.saved_at_utc),
          );
      if (supplement && sourceId === supplement.binding.roleSourceId) {
        supplementAttachments += 1;
        demand(
          receipt.success &&
            receipt.data.thread_id === supplement.binding.originalThreadId,
          "AUDIT_SUPPLEMENT_JOIN",
        );
        const received = Math.max(
          ...supplement.data.messages.map((m) => Number(m.internal_date)),
        );
        add(
          extra?.source.name ?? "",
          "",
          "exact pinned original thread and separate message/thread receipts; historical observation",
          supplement.data,
          new Date(received).toISOString(),
        );
      }
      const body = auditedRoleSchema.parse({
        format: identity.role,
        source: {
          seriesId: input.seriesId,
          bundleDigest,
          name: profile.sources.main.label,
          rawSha256: main.source.receipt.rawSha256,
          pointer: "/" + bucket + "/" + i,
          sourceId,
          sourceIdIsOriginal: bucket !== "post_cutoff_new_leads",
          classification: bucket,
        },
        raw,
        relatedEvidence: evidence,
        display: auditedPipelineView(
          raw,
          bucket,
          evidence,
          text(main.parsed.cutoff),
          profile,
        ),
        import: {
          observedAt: input.observedAt,
          ...boundProfile,
          mappingVersion: auditedMappingVersion,
        },
        sourceRevision: null,
      });
      demand(
        new TextEncoder().encode(JSON.stringify(body)).length <= 54000,
        "AUDIT_ROLE_TOO_LARGE",
      );
      const prefix = profile.recordIds.recordPrefix;
      records.push({
        id: prefix + "_" + sourceId,
        body,
        revision: 1,
        updatedAt: input.observedAt,
      });
    }
  }
  demand(!supplement || supplementAttachments === 1, "AUDIT_SUPPLEMENT_JOIN");
  const sources = sourceRows.map((s) =>
    auditedSourceSchema.parse({
      format: identity.source,
      ...boundProfile,
      seriesId: input.seriesId,
      name: s.source.name,
      rawSha256: s.source.receipt.rawSha256,
      sizeBytes: s.source.receipt.sizeBytes,
      rawUtf8: s.rawUtf8,
      importObservedAt: input.observedAt,
      mappingVersion: auditedMappingVersion,
      sourceReceipt: s.source.receipt,
    }),
  );
  const receipt = {
    format: identity.receipt,
    ...boundProfile,
    status: "legacy_imported_archive_pending",
    workspace: input.workspace,
    seriesId: input.seriesId,
    bundleDigest,
    mappingVersion: auditedMappingVersion,
    importObservedAt: input.observedAt,
    roleCount: records.length,
    rawSourceCount: sources.length,
    history: "unavailable",
    independentProtection: "unavailable",
    sourceReceipts,
  };
  const plan = {
    workspace: input.workspace,
    seriesId: input.seriesId,
    records,
    sources,
    receipt,
  };
  const planDigest = auditedPlanDigest(plan);
  if (profile.identityMode === "legacy-v1")
    demand(
      profile.legacyBinding.bundleDigest === bundleDigest &&
        profile.legacyBinding.importObservedAt === input.observedAt &&
        profile.legacyBinding.planSha256 === planDigest,
      "AUDIT_LEGACY_BINDING",
    );
  return plan;
}
export type AuditedImportPlan = ReturnType<typeof planAuditedImport>;
