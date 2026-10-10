import { z } from "zod";
import { operationById } from "../../integration/shared-contract.mjs";
import { id, demand } from "./model";
import {
  canonicalizeEnvelope,
  hashEnvelope,
  parseEnvelopeJson,
} from "./recovery-canonical";
import {
  domainRecordKindSchema,
  domainRecoverySnapshotSchema,
  domainRevisionSchema,
  domainTimeSchema,
  detachedDomainValue,
  parseDomainRecoverySnapshot,
} from "./recovery-record";

export const MAX_DOMAIN_CANDIDATES = 32;
export const MAX_DOMAIN_REFERENCES = 128;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const ids = z
  .array(id)
  .max(MAX_DOMAIN_REFERENCES)
  .refine((v) => new Set(v).size === v.length, "DUPLICATE_DOMAIN_ID");
const workspace = z.object({ ownerId: id, workspaceId: id }).strict();
const actor = z.string().min(1).max(333);
const identity = { recordKind: domainRecordKindSchema, entityId: id };
export const domainRecordGuardSchema = z.discriminatedUnion("state", [
  z.object({ ...identity, state: z.literal("absent") }).strict(),
  z
    .object({
      ...identity,
      state: z.literal("present"),
      rawBody: z.string().max(131072),
      revision: domainRevisionSchema,
      updatedAt: domainTimeSchema,
    })
    .strict(),
]);
const collectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all_claims"), memberIds: ids }).strict(),
  z.object({ kind: z.literal("all_artifacts"), memberIds: ids }).strict(),
  z
    .object({ kind: z.literal("unresolved_profile_conflicts"), memberIds: ids })
    .strict(),
  z
    .object({
      kind: z.literal("interview_reminders"),
      interviewId: id,
      memberIds: ids,
    })
    .strict(),
]);
const sourceKey = z.string().url().max(2000);
const sourceGuard = z
  .object({ sourceKey, opportunityId: id.nullable() })
  .strict();
const artifactSource = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("utf8"),
      text: z.string().max(131072),
      mediaType: z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("legacy_body"),
      recordKind: domainRecordKindSchema,
      entityId: id,
    })
    .strict(),
  z
    .object({
      type: z.literal("committed"),
      versionId: id,
      artifactIndex: z.number().int().nonnegative().max(127),
    })
    .strict(),
  z
    .object({
      type: z.literal("upload"),
      uploadHandle: id,
      digest,
      sizeBytes: z.number().int().positive().max(1073741824),
      mediaType: z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/),
    })
    .strict(),
]);
const observationFields = {
  kind: z.literal("legacy_baseline"),
  approvalProvenance: z.enum(["inert_observed", "none"]),
};
const observationSchema = z.discriminatedUnion("originalArtifact", [
  z
    .object({
      ...observationFields,
      originalArtifact: z.literal("not_applicable"),
      originalLocator: z.null(),
    })
    .strict(),
  z
    .object({
      ...observationFields,
      originalArtifact: z.literal("missing"),
      originalLocator: z.string().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      ...observationFields,
      originalArtifact: z.literal("observed"),
      originalLocator: z.string().min(1).max(1024),
      original: z
        .object({
          artifactRole: id,
          digest,
          sizeBytes: z.number().int().positive().max(1073741824),
          mediaType: z
            .string()
            .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/),
        })
        .strict(),
    })
    .strict(),
]);
const candidate = z
  .object({
    role: id,
    lineageId: id,
    snapshot: domainRecoverySnapshotSchema,
    parentVersionIds: ids,
    sourceVersionIds: ids,
    artifacts: z
      .array(z.object({ role: id, source: artifactSource }).strict())
      .max(128),
    approval: z
      .object({
        state: z.enum(["draft", "unverified", "approved", "revoked"]),
        evidenceVersionIds: ids,
      })
      .strict(),
    observation: observationSchema.optional(),
  })
  .strict();
const mutation = z
  .object({ candidateRole: id, mode: z.enum(["insert", "update", "preserve"]) })
  .strict();
const auditOperations = [
  "claim.created",
  "claim.updated",
  "opportunity.created",
  "opportunity.updated",
  "opportunity.ingested",
  "packet.created",
  "thread.created",
  "thread.updated",
  "interview.created",
  "interview.updated",
  "offer.created",
  "offer.updated",
  "artifact.created",
  "artifact.updated",
  "reminder.created",
  "reminder.updated",
  "settings.created",
  "settings.updated",
  "attempt.created",
  "prep.created",
  "prep.updated",
  "question.created",
  "question.updated",
  "transition.evidence",
] as const;
const audit = z
  .object({
    eventId: id,
    actorId: actor,
    operation: z.enum(auditOperations),
    entityId: id,
    decision: z.literal("allow"),
    createdAt: domainTimeSchema,
  })
  .strict();
export const archivedOriginalCaptureSchema = z
  .object({
    purpose: z.literal("profile-source"),
    requestRootId: id,
    transactionId: id,
    uploadHandle: id,
    purposeDigest: digest,
  })
  .strict();
export const archivedOriginalSourceSchema = z
  .object({
    format: z.literal("archived-original-source-v1"),
    entityId: id,
    kind: z.enum(["artifact", "evidence", "resume"]),
    lineageId: id,
    versionId: id,
    manifestDigest: digest,
    projectionBody: z.string().max(131072),
    original: z
      .object({
        artifactIndex: z.literal(0),
        digest,
        sizeBytes: z.number().int().positive().max(1073741824),
        mediaType: z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/),
      })
      .strict(),
    capture: archivedOriginalCaptureSchema,
  })
  .strict();
export type ArchivedOriginalSource = z.infer<
  typeof archivedOriginalSourceSchema
>;
const planShape = {
  format: z.literal("domain-plan-v1"),
  phase: z.enum(["mutation", "baseline-archive-v1"]),
  operationId: z.string().refine((value) => {
    const operation = operationById(value);
    return (
      operation !== null &&
      "domainOperation" in operation &&
      operation.domainOperation !== null
    );
  }, "UNREGISTERED_DOMAIN_OPERATION"),
  inputDigest: digest,
  planner: z.object({ version: z.literal(1), sourceDigest: digest }).strict(),
  workspace,
  actorId: actor,
  requestRootId: id,
  requestKey: id,
  readSet: z
    .object({
      records: z.array(domainRecordGuardSchema).max(128),
      collections: z.array(collectionSchema).max(16),
      sourceKeys: z.array(sourceGuard).max(128),
      archiveSources: z.array(archivedOriginalSourceSchema).max(128).optional(),
    })
    .strict(),
  mutations: z.array(mutation).max(MAX_DOMAIN_CANDIDATES),
  candidates: z.array(candidate).min(1).max(MAX_DOMAIN_CANDIDATES),
  sourceKeys: z
    .array(
      z
        .object({
          sourceKey,
          opportunityId: id,
          mode: z.enum(["insert", "same"]),
        })
        .strict(),
    )
    .max(128),
  audit: z.array(audit).max(128),
  resultRecord: z
    .object({ candidateRole: id, ...identity, revision: domainRevisionSchema })
    .strict(),
};
export const domainPlanSchema = z.object(planShape).strict().readonly();
export type DomainPlan = z.infer<typeof domainPlanSchema>;
export const candidateVersionSchema = z
  .object({ role: id, versionId: id })
  .strict();
export const acceptedDomainPlanSchema = z
  .object({
    plan: domainPlanSchema,
    candidateVersions: z
      .array(candidateVersionSchema)
      .max(MAX_DOMAIN_CANDIDATES),
    currentHeads: z
      .array(z.object({ role: id, versionIds: ids }).strict())
      .max(MAX_DOMAIN_CANDIDATES),
  })
  .strict()
  .readonly();
export type AcceptedDomainPlan = z.infer<typeof acceptedDomainPlanSchema>;
export const domainEffectsSchema = z
  .object({
    format: z.literal("domain-effects-v1"),
    planDigest: digest,
    plan: domainPlanSchema,
    candidateVersions: z
      .array(candidateVersionSchema)
      .max(MAX_DOMAIN_CANDIDATES),
  })
  .strict()
  .readonly();
export type DomainEffects = z.infer<typeof domainEffectsSchema>;
function same(left: unknown, right: unknown) {
  return (
    new TextDecoder().decode(canonicalizeEnvelope(left)) ===
    new TextDecoder().decode(canonicalizeEnvelope(right))
  );
}
function unique(values: readonly string[]) {
  demand(new Set(values).size === values.length, "DUPLICATE_DOMAIN_ID");
}
export function recordIdentity(value: {
  recordKind: string;
  entityId: string;
}) {
  return `${value.recordKind}:${value.entityId}`;
}
export function validateDomainPlan(plan: DomainPlan): void {
  unique(plan.readSet.records.map(recordIdentity));
  unique(plan.candidates.map((c) => c.role));
  unique(plan.candidates.map((c) => c.lineageId));
  unique(plan.candidates.map((c) => recordIdentity(c.snapshot)));
  unique(plan.mutations.map((m) => m.candidateRole));
  unique(plan.audit.map((a) => a.eventId));
  unique(plan.readSet.sourceKeys.map((s) => s.sourceKey));
  unique(plan.sourceKeys.map((s) => s.sourceKey));
  unique(
    plan.readSet.collections.map((c) =>
      c.kind === "interview_reminders" ? `${c.kind}:${c.interviewId}` : c.kind,
    ),
  );
  const records = new Map(
    plan.readSet.records.map((r) => [recordIdentity(r), r]),
  );
  const archives = plan.readSet.archiveSources ?? [];
  unique(archives.map((a) => a.entityId));
  unique(archives.map((a) => a.lineageId));
  unique(archives.map((a) => a.versionId));
  for (const source of archives) {
    demand(
      records.get(`artifact:${source.entityId}`)?.state === "absent",
      "ARCHIVE_SOURCE_LEGACY_ABSENCE_REQUIRED",
    );
    demand(
      plan.candidates.some((c) =>
        c.sourceVersionIds.includes(source.versionId),
      ),
      "ARCHIVE_SOURCE_REFERENCE_REQUIRED",
    );
  }
  for (const guard of plan.readSet.records) {
    if (guard.state === "present") {
      const quarantine = plan.candidates.find(
        (c) =>
          c.snapshot.type === "legacy_record_quarantine" &&
          recordIdentity(c.snapshot) === recordIdentity(guard),
      );
      const type =
        quarantine && plan.phase === "baseline-archive-v1"
          ? {
              type: "legacy_record_quarantine",
              reason: "incomplete_legacy_claim",
            }
          : { type: "domain_record" };
      parseDomainRecoverySnapshot({
        formatVersion: 1,
        ...type,
        recordKind: guard.recordKind,
        entityId: guard.entityId,
        revision: guard.revision,
        updatedAt: guard.updatedAt,
        body: parseEnvelopeJson(guard.rawBody),
      });
    }
  }
  const baseline = plan.phase === "baseline-archive-v1";
  demand(
    !baseline ||
      (plan.mutations.length === 0 &&
        plan.sourceKeys.length === 0 &&
        plan.audit.length === 0),
    "BASELINE_OPERATIONAL_EFFECT_FORBIDDEN",
  );
  demand(
    baseline || plan.mutations.length === plan.candidates.length,
    "DOMAIN_EFFECT_BIJECTION_MISMATCH",
  );
  for (const candidate of plan.candidates) {
    const snapshot = parseDomainRecoverySnapshot(candidate.snapshot),
      guard = records.get(recordIdentity(snapshot));
    demand(guard, "DOMAIN_RECORD_GUARD_REQUIRED");
    unique(candidate.artifacts.map((a) => a.role));
    demand(candidate.parentVersionIds.length <= 1, "DOMAIN_BRANCH_FORBIDDEN");
    demand(
      candidate.approval.evidenceVersionIds.every((id) =>
        candidate.sourceVersionIds.includes(id),
      ),
      "DOMAIN_APPROVAL_SOURCE_REQUIRED",
    );
    demand(
      guard.state === "absent" || snapshot.updatedAt >= guard.updatedAt,
      "DOMAIN_TIME_REGRESSION",
    );
    if (baseline) {
      demand(
        guard.state === "present" &&
          candidate.observation &&
          candidate.approval.state === "unverified" &&
          candidate.approval.evidenceVersionIds.length === 0,
        "INVALID_BASELINE_CANDIDATE",
      );
      const observation = candidate.observation;
      const locator =
        snapshot.recordKind === "artifact"
          ? snapshot.body.key
          : snapshot.recordKind === "packet"
            ? snapshot.body.artifactKey
            : null;
      demand(
        observation.originalArtifact === "not_applicable"
          ? locator === null
          : locator !== null && observation.originalLocator === locator,
        "DOMAIN_ORIGINAL_LOCATOR_MISMATCH",
      );
      if (observation.originalArtifact === "observed") {
        const original = candidate.artifacts.find(
          (a) => a.role === observation.original.artifactRole,
        );
        demand(
          original &&
            (original.source.type === "committed" ||
              original.source.type === "upload"),
          "DOMAIN_ORIGINAL_SOURCE_REQUIRED",
        );
        if (original.source.type === "upload")
          demand(
            original.source.digest === observation.original.digest &&
              original.source.sizeBytes === observation.original.sizeBytes &&
              original.source.mediaType === observation.original.mediaType,
            "DOMAIN_ORIGINAL_DESCRIPTOR_MISMATCH",
          );
      }
      demand(
        same(snapshot.body, parseEnvelopeJson(guard.rawBody)) &&
          snapshot.revision === guard.revision &&
          snapshot.updatedAt === guard.updatedAt,
        "BASELINE_OBSERVATION_MISMATCH",
      );
    } else {
      demand(
        candidate.observation === undefined &&
          snapshot.type === "domain_record",
        "INVALID_MUTATION_CANDIDATE",
      );
      const mutation = plan.mutations.find(
        (m) => m.candidateRole === candidate.role,
      );
      demand(mutation, "DOMAIN_EFFECT_BIJECTION_MISMATCH");
      demand(
        mutation.mode === "insert"
          ? guard.state === "absent" && snapshot.revision === 1
          : guard.state === "present" &&
              snapshot.revision ===
                guard.revision + (mutation.mode === "update" ? 1 : 0),
        "DOMAIN_REVISION_MISMATCH",
      );
      demand(
        mutation.mode !== "update" || snapshot.recordKind !== "packet",
        "IMMUTABLE_PACKET",
      );
      if (mutation.mode === "preserve") {
        demand(
          guard.state === "present" &&
            snapshot.updatedAt === guard.updatedAt &&
            same(snapshot.body, parseEnvelopeJson(guard.rawBody)),
          "DOMAIN_PRESERVE_MISMATCH",
        );
      }
      if (mutation.mode !== "preserve")
        demand(
          plan.audit.some(
            (a) =>
              a.entityId === snapshot.entityId &&
              a.operation ===
                `${snapshot.recordKind}.${mutation.mode === "insert" ? "created" : "updated"}`,
          ),
          "DOMAIN_AUDIT_REQUIRED",
        );
    }
    if (snapshot.type === "legacy_record_quarantine")
      demand(
        candidate.artifacts.some((a) => a.source.type === "legacy_body"),
        "QUARANTINE_RAW_ARTIFACT_REQUIRED",
      );
    for (const artifact of candidate.artifacts) {
      if (artifact.source.type === "legacy_body")
        demand(
          baseline &&
            artifact.source.recordKind === snapshot.recordKind &&
            artifact.source.entityId === snapshot.entityId,
          "RAW_BASELINE_ARTIFACT_FORBIDDEN",
        );
      if (artifact.source.type === "committed")
        demand(
          candidate.sourceVersionIds.includes(artifact.source.versionId) ||
            candidate.parentVersionIds.includes(artifact.source.versionId),
          "UNDECLARED_DOMAIN_ARTIFACT_SOURCE",
        );
    }
  }
  for (const collection of plan.readSet.collections) {
    const kind =
      collection.kind === "all_claims"
        ? "claim"
        : collection.kind === "all_artifacts"
          ? "artifact"
          : collection.kind === "unresolved_profile_conflicts"
            ? "question"
            : "reminder";
    for (const entityId of collection.memberIds) {
      const guard = records.get(`${kind}:${entityId}`);
      demand(guard?.state === "present", "DOMAIN_COLLECTION_GUARD_REQUIRED");
      const body = parseEnvelopeJson(guard.rawBody);
      if (collection.kind === "unresolved_profile_conflicts")
        demand(
          body !== null &&
            typeof body === "object" &&
            "type" in body &&
            body.type === "profile_conflict" &&
            "status" in body &&
            body.status !== "resolved",
          "DOMAIN_COLLECTION_MEMBER_MISMATCH",
        );
      if (collection.kind === "interview_reminders")
        demand(
          body !== null &&
            typeof body === "object" &&
            "interviewId" in body &&
            body.interviewId === collection.interviewId,
          "DOMAIN_COLLECTION_MEMBER_MISMATCH",
        );
    }
  }
  for (const effect of plan.sourceKeys) {
    const guard = plan.readSet.sourceKeys.find(
      (s) => s.sourceKey === effect.sourceKey,
    );
    demand(
      guard &&
        (effect.mode === "insert"
          ? guard.opportunityId === null
          : guard.opportunityId === effect.opportunityId),
      "DOMAIN_SOURCE_KEY_GUARD_REQUIRED",
    );
    demand(
      plan.candidates.some(
        (c) =>
          c.snapshot.recordKind === "opportunity" &&
          c.snapshot.entityId === effect.opportunityId,
      ) ||
        records.get(`opportunity:${effect.opportunityId}`)?.state === "present",
      "DOMAIN_SOURCE_KEY_TARGET_REQUIRED",
    );
  }
  for (const entry of plan.audit)
    demand(
      entry.actorId === plan.actorId &&
        plan.candidates.some(
          (c) =>
            c.snapshot.entityId === entry.entityId &&
            entry.createdAt === c.snapshot.updatedAt &&
            (entry.operation.startsWith(`${c.snapshot.recordKind}.`) ||
              entry.operation === "transition.evidence"),
        ),
      "DOMAIN_AUDIT_MISMATCH",
    );
  const result = plan.candidates.find(
    (c) => c.role === plan.resultRecord.candidateRole,
  );
  demand(
    result &&
      recordIdentity(result.snapshot) === recordIdentity(plan.resultRecord) &&
      result.snapshot.revision === plan.resultRecord.revision,
    "DOMAIN_RESULT_MISMATCH",
  );
}
export function parseDomainPlan(value: unknown): DomainPlan {
  const plan = domainPlanSchema.parse(detachedDomainValue(value));
  validateDomainPlan(plan);
  return plan;
}
export async function domainPlanDigest(plan: DomainPlan) {
  return hashEnvelope("request", { purpose: "domain-plan-v1", plan });
}
export async function domainRequestDigest(plan: DomainPlan) {
  return hashEnvelope("request", {
    purpose: "domain-request-v1",
    workspace: plan.workspace,
    requestKey: plan.requestKey,
    operationId: plan.operationId,
    inputDigest: plan.inputDigest,
    planner: plan.planner,
    planDigest: await domainPlanDigest(plan),
  });
}
export function validateCandidateVersions(
  plan: DomainPlan,
  versions: readonly z.infer<typeof candidateVersionSchema>[],
) {
  unique(versions.map((v) => v.role));
  unique(versions.map((v) => v.versionId));
  demand(
    versions.length === plan.candidates.length &&
      plan.candidates.every((c) => versions.some((v) => v.role === c.role)),
    "DOMAIN_VERSION_MAPPING_MISMATCH",
  );
  const ids = versions.map((v) => v.versionId);
  demand(
    plan.candidates.every((c) =>
      [
        ...c.parentVersionIds,
        ...c.sourceVersionIds,
        ...c.approval.evidenceVersionIds,
      ].every((id) => !ids.includes(id)),
    ),
    "DOMAIN_CANDIDATE_SOURCE_FORBIDDEN",
  );
}
