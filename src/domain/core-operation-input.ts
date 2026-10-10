import { z } from "zod";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  detachedJson,
  LIMITS,
  operationById,
  validateCoreInput,
  type CoreOperationId,
  type InputById,
} from "../../integration/shared-contract.mjs";
import { demand, id } from "./model";
import {
  domainPlanSchema,
  domainRecordGuardSchema,
  archivedOriginalCaptureSchema,
} from "./recovery-domain-plan";
import {
  domainRecordKindSchema,
  domainTimeSchema,
  domainRevisionSchema,
} from "./recovery-record";

export type DomainOperationId = {
  [I in CoreOperationId]: InputById[I] extends { readonly body: unknown }
    ? I
    : never;
}[CoreOperationId];
export type DomainOperationRequest = {
  [I in DomainOperationId]: Readonly<{ operationId: I; input: InputById[I] }>;
}[DomainOperationId];
const ids = z
  .array(id)
  .max(128)
  .refine((v) => new Set(v).size === v.length, "DUPLICATE_DOMAIN_ID");
const identity = { recordKind: domainRecordKindSchema, entityId: id };
export const recordBindingSchema = z
  .object({
    ...identity,
    lineageId: id,
    versionId: id.nullable(),
    heads: ids,
    revision: domainRevisionSchema,
    sourceVersionIds: ids,
  })
  .strict();
export const coreObservationSchema = domainPlanSchema
  .unwrap()
  .shape.readSet.extend({
    bindings: z.array(recordBindingSchema).max(128),
    packetEvidence: z
      .array(
        z
          .object({ packetId: id, versionId: id, text: z.string().max(131072) })
          .strict(),
      )
      .max(128)
      .optional(),
  })
  .strict();
export type CoreObservation = z.infer<typeof coreObservationSchema>;
export const allocationSchema = z
  .object({
    workspace: domainPlanSchema.unwrap().shape.workspace,
    actorId: domainPlanSchema.unwrap().shape.actorId,
    requestRootId: id,
    businessTime: domainTimeSchema,
    records: z
      .array(
        z
          .object({
            role: id,
            ...identity,
            lineageId: id,
            auditEventId: id,
            transitionAuditEventId: id.optional(),
            ingestAuditEventId: id.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
export type CoreAllocation = z.infer<typeof allocationSchema>;
const approvalSchema = z
  .object({
    claimId: id,
    versionId: id,
    revision: domainRevisionSchema,
    approvalId: id,
    approvalRevision: domainRevisionSchema,
    expiresAt: domainTimeSchema,
    sourceVersionIds: ids,
  })
  .strict();
const sourceArtifactSchema = z
  .object({
    capture: archivedOriginalCaptureSchema.optional(),
    entityId: id,
    versionId: id,
    permissionId: id,
    permissionRevision: domainRevisionSchema,
    expiresAt: domainTimeSchema,
    artifactIndex: z.number().int().nonnegative().max(127),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().positive().max(1073741824),
    mediaType: z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/),
  })
  .strict();
/** Trusted live host dependency data, never a caller proof or independent issuer. */
export const currentEvidenceSchema = z
  .object({
    checkedAt: domainTimeSchema,
    ownerInteraction: z
      .object({ id, revision: domainRevisionSchema })
      .strict()
      .nullable(),
    claims: z.array(approvalSchema).max(128),
    sourceArtifacts: z.array(sourceArtifactSchema).max(128),
  })
  .strict();
export type CurrentDomainEvidence = z.infer<typeof currentEvidenceSchema>;
const artifactSourceSchema =
  domainPlanSchema.unwrap().shape.candidates.element.shape.artifacts.element
    .shape.source;
const originalFields = {
  ...identity,
  locator: z.string().min(1).max(1024),
  recordRevision: domainRevisionSchema,
  rawBodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
};
export const baselineOriginalSchema = z.discriminatedUnion("state", [
  z.object({ ...originalFields, state: z.literal("missing") }).strict(),
  z
    .object({
      ...originalFields,
      state: z.literal("unavailable"),
      reason: z.enum(["permission_unavailable", "capture_unavailable"]),
    })
    .strict(),
  z
    .object({
      ...originalFields,
      state: z.literal("observed"),
      source: artifactSourceSchema,
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      sizeBytes: z.number().int().positive().max(1073741824),
      mediaType: z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/),
    })
    .strict(),
]);
export const baselineInputsSchema = z
  .object({
    requestKey: id,
    originals: z.array(baselineOriginalSchema).max(128),
    migrations: z
      .array(
        z
          .object({
            ...identity,
            sourceRevision: z.string().regex(/^[1-9][0-9]*$/),
            sourceSnapshot: z.string().max(131072),
            provenance: z.literal("imported_legacy_baseline"),
            artifactAvailability: z.enum([
              "not_applicable",
              "unobserved",
              "missing",
              "observed",
            ]),
          })
          .strict(),
      )
      .max(128),
  })
  .strict();
export type BaselineInputs = z.infer<typeof baselineInputsSchema>;
export type CorePlanningInput = DomainOperationRequest &
  Readonly<{
    allocation: CoreAllocation;
    read: CoreObservation;
    currentEvidence: CurrentDomainEvidence;
    phase?: "baseline-archive-v1";
    baseline?: BaselineInputs;
  }>;
export function parseDomainOperation(value: unknown): DomainOperationRequest {
  const request = z
    .object({ operationId: z.string(), input: z.unknown() })
    .strict()
    .parse(detachedJson(value));
  const operation = operationById(request.operationId);
  demand(
    operation && "domainOperation" in operation && operation.domainOperation,
    "UNREGISTERED_DOMAIN_OPERATION",
  );
  // The catalog validator establishes the operation/input correlation before this
  // finite TypeScript interoperability assertion. No rule/schema is duplicated.
  return {
    operationId: operation.id,
    input: validateCoreInput(operation.id, request.input),
  } as DomainOperationRequest;
}
export function parseCorePlanningInput(value: unknown): CorePlanningInput {
  const raw = z
    .object({
      operationId: z.string(),
      input: z.unknown(),
      allocation: allocationSchema,
      read: coreObservationSchema,
      currentEvidence: currentEvidenceSchema,
      phase: z.literal("baseline-archive-v1").optional(),
      baseline: baselineInputsSchema.optional(),
    })
    .strict()
    .parse(detachedJson(value, { maxBytes: LIMITS.privateComposite }));
  const request = parseDomainOperation({
    operationId: raw.operationId,
    input: raw.input,
  });
  demand(
    request.input.workspaceId === raw.allocation.workspace.workspaceId,
    "DOMAIN_WORKSPACE_MISMATCH",
  );
  demand(
    new Set(raw.allocation.records.map((r) => r.role)).size ===
      raw.allocation.records.length,
    "DUPLICATE_DOMAIN_ID",
  );
  demand(
    new Set(raw.currentEvidence.claims.map((c) => c.claimId)).size ===
      raw.currentEvidence.claims.length &&
      new Set(raw.currentEvidence.sourceArtifacts.map((s) => s.entityId))
        .size === raw.currentEvidence.sourceArtifacts.length,
    "DUPLICATE_CURRENT_EVIDENCE",
  );
  return {
    ...request,
    allocation: raw.allocation,
    read: raw.read,
    currentEvidence: raw.currentEvidence,
    ...(raw.phase ? { phase: raw.phase, baseline: raw.baseline } : {}),
  };
}
/** Byte-identical to Control's invocation-input digest, without any I/O. */
export function coreInputDigest(request: DomainOperationRequest): string {
  return createHash("sha256")
    .update("job-stack.shared-auth.v1\0invocation-input\0")
    .update(
      canonicalJson(
        { operationId: request.operationId, input: request.input },
        LIMITS.privateComposite,
      ),
    )
    .digest("hex");
}
export function presentGuard(
  read: CoreObservation,
  recordKind: z.infer<typeof domainRecordKindSchema>,
  entityId: string,
) {
  const guard = read.records.find(
    (r) => r.recordKind === recordKind && r.entityId === entityId,
  );
  demand(guard?.state === "present", "DOMAIN_RECORD_NOT_FOUND");
  return guard;
}
export function recordGuard(
  read: CoreObservation,
  recordKind: z.infer<typeof domainRecordKindSchema>,
  entityId: string,
) {
  const guard = read.records.find(
    (r) => r.recordKind === recordKind && r.entityId === entityId,
  );
  demand(guard, "DOMAIN_RECORD_GUARD_REQUIRED");
  return domainRecordGuardSchema.parse(guard);
}
