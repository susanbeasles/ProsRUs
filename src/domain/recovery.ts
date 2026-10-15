import { z } from "zod";
import { domainEffectsSchema } from "./recovery-domain-plan";
import {
  scalarString,
  validateInvocation,
} from "../../integration/shared-contract.mjs";
import type { SharedInvocation } from "../../integration/shared-contract.mjs";
export const canonicalIdentitySchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => value.trim() === value && scalarString(value),
    "INVALID_CANONICAL_IDENTITY",
  );
const sharedAuthoritySchema = z.custom<SharedInvocation>((value) => {
  try {
    validateInvocation(value);
    return true;
  } catch {
    return false;
  }
}, "INVALID_SHARED_AUTHORITY");
import { demand } from "./model";
import {
  canonicalizeEnvelope,
  RECOVERY_CANONICALIZATION_VERSION,
  RECOVERY_HASH_ALGORITHM,
  RECOVERY_SCHEMA_VERSION,
} from "./recovery-canonical";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
/** Actor provenance is not an artifact ID. Preserve host prefixes without mapping to the owner. */
export const principalIdentitySchema = z
  .string()
  .min(1)
  .max(333)
  .refine((value) => {
    if (/^[A-Za-z0-9_-]{1,100}$/.test(value)) return true;
    if (value.startsWith("client:"))
      return (
        canonicalIdentitySchema.safeParse(value).success && value.length > 7
      );
    if (!value.startsWith("access-owner:")) return false;
    const email = value.slice("access-owner:".length);
    return (
      email.length <= 320 &&
      email === email.toLowerCase() &&
      !/[\u0000-\u0020\u007f-\u009f]/.test(email) &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    );
  }, "INVALID_PRINCIPAL_IDENTITY");
export type PrincipalIdentity = z.infer<typeof principalIdentitySchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sequence = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(100);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const safeLabel = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const authorityName = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => !/[\s\u0000-\u001f\u007f]/.test(value));
const format = {
  schemaVersion: z.literal(RECOVERY_SCHEMA_VERSION),
  canonicalizationVersion: z.literal(RECOVERY_CANONICALIZATION_VERSION),
  hashAlgorithm: z.literal(RECOVERY_HASH_ALGORITHM),
};
function uniqueIds() {
  return z
    .array(identifier)
    .refine(
      (values) => new Set(values).size === values.length,
      "DUPLICATE_REFERENCE",
    )
    .readonly();
}
export const recoveryJsonSchema = z.custom<unknown>((value) => {
  try {
    canonicalizeEnvelope(value);
    return true;
  } catch {
    return false;
  }
}, "INVALID_RECOVERY_JSON");
export const recoveryPurposeSchema = z.enum([
  "manifest",
  "transaction",
  "preparation",
  "commit",
  "checkpoint",
  "receipt",
  "inventory",
  "epoch_transition",
  "request",
]);
export type RecoveryPurpose = z.infer<typeof recoveryPurposeSchema>;
export const recoverySignatureBindingSchema = z
  .object({ ...format, purpose: recoveryPurposeSchema, digest })
  .strict()
  .readonly();
export type RecoverySignatureBinding = z.infer<
  typeof recoverySignatureBindingSchema
>;
// The approved signer adapter must negotiate one of these standard asymmetric algorithms.
export const signatureAlgorithmSchema = z.enum([
  "ES256",
  "ES384",
  "ES512",
  "PS256",
  "PS384",
  "PS512",
  "RS256",
  "RS384",
  "RS512",
  "EdDSA",
  "Ed25519",
]);
export type SignatureAlgorithm = z.infer<typeof signatureAlgorithmSchema>;
export const recoverySignatureSchema = z
  .object({
    keyId: identifier,
    algorithm: signatureAlgorithmSchema,
    jws: z
      .string()
      .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
      .max(180000),
  })
  .strict()
  .readonly();
export type RecoverySignature = z.infer<typeof recoverySignatureSchema>;
export const workspaceRefSchema = z
  .object({ ownerId: identifier, workspaceId: identifier })
  .strict()
  .readonly();
export type WorkspaceRef = z.infer<typeof workspaceRefSchema>;
const namespace = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const objectKey = z
  .string()
  .max(1000)
  .regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*$/)
  .refine((key) =>
    key.split("/").every((part) => part !== "." && part !== ".."),
  );
export const archiveLocationSchema = z
  .object({ provider: z.enum(["primary", "replica"]), namespace })
  .strict()
  .readonly();
export const archiveObjectRefSchema = z
  .object({
    provider: z.enum(["primary", "replica"]),
    namespace,
    key: objectKey,
    versionId: identifier.nullable(),
  })
  .strict()
  .readonly();
export type ArchiveObjectRef = z.infer<typeof archiveObjectRefSchema>;
export const recoveryLocatorSchema = z
  .object({
    workspaceId: identifier,
    lineageId: identifier,
    formatVersion: z.literal(1),
    namespace,
    archives: z.array(archiveLocationSchema).min(1).readonly(),
    trustRootIds: uniqueIds().refine((ids) => ids.length > 0),
  })
  .strict()
  .readonly();
export type RecoveryLocator = z.infer<typeof recoveryLocatorSchema>;
export const blobDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    hashAlgorithm: z.literal(RECOVERY_HASH_ALGORITHM),
    digest,
    sizeBytes: count,
    mediaType: z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/),
    object: archiveObjectRefSchema,
  })
  .strict()
  .readonly();
export type BlobDescriptor = z.infer<typeof blobDescriptorSchema>;
/** Exact canonical metadata bytes, with their purpose and physical provider identity. */
export const archiveMetadataDescriptorSchema = z
  .object({
    formatVersion: z.literal(1),
    hashPurpose: recoveryPurposeSchema,
    digest,
    sizeBytes: count.max(128 * 1024),
    mediaType: z.literal("application/json"),
    object: archiveObjectRefSchema,
  })
  .strict()
  .readonly();
export type ArchiveMetadataDescriptor = z.infer<
  typeof archiveMetadataDescriptorSchema
>;
export const recoveryKindSchema = z.enum([
  "resume",
  "brief",
  "profile",
  "career_profile",
  "channel_draft",
  "observed_profile_snapshot",
  "profile_change_set",
  "publication_attempt",
  "claim",
  "evidence",
  "packet",
  "artifact",
  "opportunity",
  "conversation",
  "interview",
  "settings",
  "source",
  "source_checkpoint",
  "approval",
  "head_selection",
  "audit",
  "external_receipt",
  "action_intent",
  "request_result",
  "tombstone",
  "suppression",
  "meeting",
  "recording",
  "transcript",
  "meeting_note",
  "summary",
  "action_item",
  "prep_brief",
  "coaching",
  "offer",
  "question",
  "reminder",
]);
export type RecoveryKind = z.infer<typeof recoveryKindSchema>;
export const documentApprovalSchema = z.enum([
  "draft",
  "approved",
  "revoked",
  "unverified",
]);
const principalSchema = z
  .object({
    id: principalIdentitySchema,
    kind: z.enum(["user", "service"]),
    scopes: z.array(safeLabel).readonly(),
    expiresAt: timestamp,
  })
  .strict()
  .readonly();
export const grantEvidenceSchema = z
  .object({
    id: canonicalIdentitySchema,
    revision: sequence,
    issuerPrincipalId: principalIdentitySchema.optional(),
    sharedAuthority: sharedAuthoritySchema.optional(),
    scopes: z.array(safeLabel).readonly(),
    resourceBounds: z
      .array(z.object({ kind: safeLabel, id: identifier }).strict().readonly())
      .readonly(),
    expiresAt: timestamp,
  })
  .strict()
  .refine((grant) => {
    const shared = grant.sharedAuthority;
    if (!shared) return true;
    return (
      grant.id === shared.grant.id &&
      grant.revision === String(shared.grant.revision) &&
      grant.issuerPrincipalId === shared.grant.issuerPrincipalId &&
      grant.expiresAt === shared.grant.expiresAtMs &&
      JSON.stringify(grant.scopes) === JSON.stringify(shared.grant.scopes) &&
      JSON.stringify(grant.resourceBounds) ===
        JSON.stringify([
          { kind: "workspace", id: shared.capability.workspace.workspaceId },
        ])
    );
  }, "SHARED_GRANT_EVIDENCE_MISMATCH")
  .readonly();
export type GrantEvidence = z.infer<typeof grantEvidenceSchema>;
export const workspaceChainSchema = z
  .object({
    epochId: identifier,
    sequence,
    previousTransactionDigest: digest.nullable(),
  })
  .strict()
  .refine(
    (chain) =>
      chain.sequence === "0" || chain.previousTransactionDigest !== null,
    "CHAIN_PREDECESSOR_REQUIRED",
  )
  .readonly();
export type WorkspaceChain = z.infer<typeof workspaceChainSchema>;
export const authenticatedRecoveryContextSchema = z
  .object({
    workspace: workspaceRefSchema,
    actor: principalSchema,
    issuer: authorityName,
    audience: authorityName,
    grant: grantEvidenceSchema,
    chain: workspaceChainSchema,
    serverTime: timestamp,
  })
  .strict()
  .refine(
    (context) =>
      context.actor.expiresAt > context.serverTime &&
      context.grant.expiresAt > context.serverTime,
    "EXPIRED_RECOVERY_AUTHORITY",
  )
  .refine((context) => {
    const shared = context.grant.sharedAuthority;
    return (
      !shared ||
      (context.actor.id === shared.grant.principalId &&
        context.actor.kind === "service" &&
        JSON.stringify(context.actor.scopes) ===
          JSON.stringify([shared.operation.scope]) &&
        context.actor.expiresAt === shared.expiresAtMs &&
        context.issuer === shared.grant.issuer &&
        context.audience === shared.grant.audience &&
        context.workspace.ownerId === shared.capability.workspace.ownerId &&
        context.workspace.workspaceId ===
          shared.capability.workspace.workspaceId &&
        context.serverTime === shared.authorizedAtMs)
    );
  }, "SHARED_CONTEXT_MISMATCH")
  .readonly();
export type AuthenticatedRecoveryContext = z.infer<
  typeof authenticatedRecoveryContextSchema
>;

const manifestShape = {
  ...format,
  workspace: workspaceRefSchema,
  epochId: identifier,
  sequence,
  transactionId: identifier,
  versionId: identifier,
  lineageId: identifier,
  entityId: identifier,
  kind: recoveryKindSchema,
  parentVersionIds: uniqueIds(),
  branchRequested: z.boolean(),
  sourceVersionIds: uniqueIds(),
  recordSnapshot: recoveryJsonSchema,
  artifacts: z.array(blobDescriptorSchema).readonly(),
  approval: z
    .object({ state: documentApprovalSchema, evidenceVersionIds: uniqueIds() })
    .strict()
    .readonly(),
  actorId: principalIdentitySchema,
  createdAt: timestamp,
  generationRecipe: z
    .object({
      templateId: identifier.nullable(),
      rendererId: identifier.nullable(),
      modelId: identifier.nullable(),
      permittedInputVersionIds: uniqueIds(),
      parameters: recoveryJsonSchema,
    })
    .strict()
    .readonly()
    .nullable(),
  recoveryLocator: recoveryLocatorSchema,
};
function lineageValid(
  manifest: z.infer<z.ZodObject<typeof manifestShape>>,
): boolean {
  return (
    !manifest.parentVersionIds.includes(manifest.versionId) &&
    !manifest.sourceVersionIds.includes(manifest.versionId) &&
    (manifest.parentVersionIds.length <= 1 || manifest.branchRequested) &&
    (!manifest.branchRequested || manifest.parentVersionIds.length > 0) &&
    manifest.recoveryLocator.workspaceId === manifest.workspace.workspaceId &&
    manifest.recoveryLocator.lineageId === manifest.lineageId &&
    manifest.artifacts.every((artifact) =>
      manifest.recoveryLocator.archives.some(
        (location) =>
          location.provider === artifact.object.provider &&
          location.namespace === artifact.object.namespace,
      ),
    )
  );
}
export const versionManifestSchema = z
  .object(manifestShape)
  .strict()
  .refine(lineageValid, "INVALID_LINEAGE")
  .readonly();
export type VersionManifest = z.infer<typeof versionManifestSchema>;
/** Local links only; resolved ancestry/ownership/cycles require the archive/store closure. */
export function validateLineage(manifest: VersionManifest): void {
  demand(versionManifestSchema.safeParse(manifest).success, "INVALID_LINEAGE");
}

export const saveVersionInputSchema = z
  .object({
    requestKey: identifier,
    lineageId: identifier,
    entityId: identifier,
    kind: recoveryKindSchema,
    expectedParentIds: uniqueIds(),
    branchRequested: z.boolean(),
    content: z
      .union([
        z.instanceof(Uint8Array).transform((bytes) => new Uint8Array(bytes)),
        recoveryJsonSchema,
      ])
      .optional(),
    uploadHandle: identifier.optional(),
    sourceVersionIds: uniqueIds(),
  })
  .strict()
  .refine(
    (input) =>
      (input.content !== undefined) !== (input.uploadHandle !== undefined),
    "CONTENT_OR_UPLOAD_REQUIRED",
  )
  .readonly();
export type SaveVersionInput = z.infer<typeof saveVersionInputSchema>;
export const saveVersionResultSchema = z
  .object({
    versionId: identifier,
    transactionId: identifier,
    digest,
    statusUrl: z.string().regex(/^\/versions\/[A-Za-z0-9_-]+\/protection$/),
    status: z.literal("saved_primary"),
    protection: z.literal("protection_pending"),
  })
  .strict()
  .readonly();
export type SaveVersionResult = z.infer<typeof saveVersionResultSchema>;

export const recoveryEventSchema = z
  .object({
    ...format,
    workspace: workspaceRefSchema,
    eventId: identifier,
    transactionId: identifier,
    epochId: identifier,
    sequence,
    kind: z.enum([
      "head_selection",
      "approval",
      "source_checkpoint",
      "request_result",
      "external_receipt",
      "tombstone",
      "suppression",
      "audit",
      "epoch_transition",
    ]),
    body: recoveryJsonSchema,
  })
  .strict()
  .readonly();
export type RecoveryEvent = z.infer<typeof recoveryEventSchema>;
export const sourceRecoveryDescriptorSchema = z
  .object({
    versionId: identifier,
    workspace: workspaceRefSchema,
    epochId: identifier,
    lineageId: identifier,
    manifestDigest: digest,
    recoveryLocator: recoveryLocatorSchema,
  })
  .strict()
  .refine(
    (source) =>
      source.recoveryLocator.workspaceId === source.workspace.workspaceId &&
      source.recoveryLocator.lineageId === source.lineageId,
    "INVALID_SOURCE_LOCATOR",
  )
  .readonly();
export type SourceRecoveryDescriptor = z.infer<
  typeof sourceRecoveryDescriptorSchema
>;
export const primaryPackageBindingSchema = z
  .object({
    formatVersion: z.literal(1),
    packageFormat: z.literal("recovery-package-v1"),
    descriptor: archiveMetadataDescriptorSchema.refine(
      (value) =>
        value.hashPurpose === "inventory" &&
        value.object.provider === "primary" &&
        value.object.versionId !== null,
      "INVALID_PACKAGE_BINDING",
    ),
  })
  .strict()
  .readonly();
export type PrimaryPackageBinding = z.infer<typeof primaryPackageBindingSchema>;
const preparedShape = {
  ...format,
  purpose: z.literal("preparation"),
  workspace: workspaceRefSchema,
  epochId: identifier,
  sequence,
  previousTransactionDigest: digest.nullable(),
  transactionId: identifier,
  requestKey: identifier,
  requestDigest: digest,
  actorId: principalIdentitySchema,
  issuer: authorityName,
  audience: authorityName,
  grant: grantEvidenceSchema,
  createdAt: timestamp,
  versions: z.array(versionManifestSchema).min(1).readonly(),
  events: z.array(recoveryEventSchema).readonly(),
  expectedHeads: z
    .array(
      z
        .object({
          lineageId: identifier,
          parentVersionIds: uniqueIds(),
          branchRequested: z.boolean(),
        })
        .strict()
        .readonly(),
    )
    .readonly(),
  objects: z.array(blobDescriptorSchema).readonly(),
  sourceDescriptors: z.array(sourceRecoveryDescriptorSchema).readonly(),
  packageObject: archiveObjectRefSchema,
  // Optional only for decoding historical evidence. New signing paths require v1.
  packageBinding: primaryPackageBindingSchema.optional(),
  result: saveVersionResultSchema,
  domainEffects: domainEffectsSchema.optional(),
};
function physicalObjectIdentity(object: ArchiveObjectRef): string {
  return JSON.stringify([
    object.provider,
    object.namespace,
    object.key,
    object.versionId,
  ]);
}
function descriptorMetadata(descriptor: BlobDescriptor): string {
  return JSON.stringify([
    descriptor.schemaVersion,
    descriptor.hashAlgorithm,
    descriptor.digest,
    descriptor.sizeBytes,
    descriptor.mediaType,
  ]);
}
function consistentDescriptors(
  descriptors: readonly BlobDescriptor[],
): boolean {
  const identities = new Map<string, string>();
  for (const descriptor of descriptors) {
    const identity = physicalObjectIdentity(descriptor.object);
    const metadata = descriptorMetadata(descriptor);
    const prior = identities.get(identity);
    if (prior !== undefined && prior !== metadata) return false;
    identities.set(identity, metadata);
  }
  return true;
}
function declaresPrimary(locator: RecoveryLocator, namespace: string): boolean {
  return locator.archives.some(
    (location) =>
      location.provider === "primary" && location.namespace === namespace,
  );
}
function preparedLocationsValid(
  envelope: z.infer<z.ZodObject<typeof preparedShape>>,
): boolean {
  return (
    envelope.packageObject.provider === "primary" &&
    envelope.versions.every((version) =>
      declaresPrimary(
        version.recoveryLocator,
        envelope.packageObject.namespace,
      ),
    ) &&
    envelope.versions.every((version) =>
      version.artifacts.every(
        (artifact) =>
          artifact.object.provider === "primary" &&
          declaresPrimary(version.recoveryLocator, artifact.object.namespace),
      ),
    ) &&
    envelope.objects.every(
      (object) =>
        object.object.provider === "primary" &&
        envelope.versions.some((version) =>
          declaresPrimary(version.recoveryLocator, object.object.namespace),
        ),
    )
  );
}
function preparedValid(
  envelope: z.infer<z.ZodObject<typeof preparedShape>>,
): boolean {
  const matches = (value: {
    workspace: WorkspaceRef;
    epochId: string;
    sequence: string;
    transactionId: string;
  }) =>
    value.workspace.ownerId === envelope.workspace.ownerId &&
    value.workspace.workspaceId === envelope.workspace.workspaceId &&
    value.epochId === envelope.epochId &&
    value.sequence === envelope.sequence &&
    value.transactionId === envelope.transactionId;
  return (
    (!envelope.grant.sharedAuthority ||
      (envelope.actorId === envelope.grant.sharedAuthority.grant.principalId &&
        envelope.issuer === envelope.grant.sharedAuthority.grant.issuer &&
        envelope.audience === envelope.grant.sharedAuthority.grant.audience &&
        envelope.workspace.ownerId ===
          envelope.grant.sharedAuthority.capability.workspace.ownerId &&
        envelope.workspace.workspaceId ===
          envelope.grant.sharedAuthority.capability.workspace.workspaceId &&
        envelope.createdAt ===
          envelope.grant.sharedAuthority.authorizedAtMs)) &&
    envelope.sequence !== "0" &&
    (envelope.packageBinding === undefined ||
      (envelope.packageObject.versionId === null &&
        envelope.packageBinding.descriptor.object.provider ===
          envelope.packageObject.provider &&
        envelope.packageBinding.descriptor.object.namespace ===
          envelope.packageObject.namespace &&
        envelope.packageBinding.descriptor.object.key ===
          envelope.packageObject.key)) &&
    preparedLocationsValid(envelope) &&
    consistentDescriptors([
      ...envelope.objects,
      ...envelope.versions.flatMap((version) => version.artifacts),
    ]) &&
    new Set(envelope.versions.map((version) => version.lineageId)).size ===
      envelope.versions.length &&
    new Set(envelope.expectedHeads.map((head) => head.lineageId)).size ===
      envelope.expectedHeads.length &&
    (envelope.sequence === "1" ||
      envelope.previousTransactionDigest !== null) &&
    envelope.grant.expiresAt > envelope.createdAt &&
    new Set(envelope.sourceDescriptors.map((source) => source.versionId))
      .size === envelope.sourceDescriptors.length &&
    envelope.sourceDescriptors.every(
      (source) =>
        source.workspace.ownerId === envelope.workspace.ownerId &&
        source.workspace.workspaceId === envelope.workspace.workspaceId,
    ) &&
    envelope.versions.every((version) =>
      version.sourceVersionIds.every(
        (id) =>
          envelope.sourceDescriptors.some(
            (source) => source.versionId === id,
          ) ||
          envelope.versions.some((candidate) => candidate.versionId === id),
      ),
    ) &&
    envelope.versions.every(
      (version) =>
        matches(version) &&
        version.actorId === envelope.actorId &&
        version.createdAt === envelope.createdAt,
    ) &&
    envelope.events.every(matches) &&
    new Set(envelope.versions.map((version) => version.versionId)).size ===
      envelope.versions.length &&
    new Set(envelope.events.map((event) => event.eventId)).size ===
      envelope.events.length &&
    envelope.result.transactionId === envelope.transactionId &&
    envelope.versions.some(
      (version) => version.versionId === envelope.result.versionId,
    ) &&
    envelope.expectedHeads.length === envelope.versions.length &&
    envelope.versions.every((version) =>
      envelope.expectedHeads.some(
        (head) =>
          head.lineageId === version.lineageId &&
          head.branchRequested === version.branchRequested &&
          head.parentVersionIds.length === version.parentVersionIds.length &&
          head.parentVersionIds.every((id) =>
            version.parentVersionIds.includes(id),
          ),
      ),
    ) &&
    envelope.versions.every((version) =>
      version.artifacts.every((artifact) =>
        envelope.objects.some(
          (object) =>
            descriptorMetadata(object) === descriptorMetadata(artifact) &&
            object.object.provider === artifact.object.provider &&
            object.object.namespace === artifact.object.namespace &&
            object.object.key === artifact.object.key &&
            object.object.versionId === artifact.object.versionId,
        ),
      ),
    )
  );
}
export const preparedEnvelopePayloadSchema = z
  .object(preparedShape)
  .strict()
  .refine(preparedValid, "INVALID_PREPARED_ENVELOPE")
  .readonly();
export type PreparedEnvelopePayload = z.infer<
  typeof preparedEnvelopePayloadSchema
>;
export const preparedEnvelopeSchema = z
  .object({ ...preparedShape, signature: recoverySignatureSchema })
  .strict()
  .refine(preparedValid, "INVALID_PREPARED_ENVELOPE")
  .readonly();
export type PreparedEnvelope = z.infer<typeof preparedEnvelopeSchema>;
const commitShape = {
  ...format,
  purpose: z.literal("commit"),
  workspace: workspaceRefSchema,
  epochId: identifier,
  sequence,
  transactionId: identifier,
  preparedDigest: digest,
  transactionDigest: digest,
  committedAt: timestamp,
};
export const commitCertificatePayloadSchema = z
  .object(commitShape)
  .strict()
  .readonly();
export type CommitCertificatePayload = z.infer<
  typeof commitCertificatePayloadSchema
>;
export const commitCertificateSchema = z
  .object({ ...commitShape, signature: recoverySignatureSchema })
  .strict()
  .readonly();
export type CommitCertificate = z.infer<typeof commitCertificateSchema>;
export const archiveInventorySchema = z
  .object({
    ...format,
    workspace: workspaceRefSchema,
    epochId: identifier,
    throughSequence: sequence,
    transactionDigest: digest,
    objects: z.array(blobDescriptorSchema).readonly(),
    versionIds: uniqueIds(),
    eventIds: uniqueIds(),
    complete: z.boolean(),
  })
  .strict()
  .readonly();
export type ArchiveInventory = z.infer<typeof archiveInventorySchema>;
export const checkpointSchema = z
  .object({
    ...format,
    workspace: workspaceRefSchema,
    epochId: identifier,
    sequence,
    transactionDigest: digest,
    inventoryDigest: digest,
    checkedAt: timestamp,
  })
  .strict()
  .readonly();
export type RecoveryCheckpoint = z.infer<typeof checkpointSchema>;
export const retentionObservationSchema = z
  .object({
    object: archiveObjectRefSchema,
    mode: z.enum(["not_configured", "governance", "compliance", "unknown"]),
    retainUntil: timestamp.nullable(),
    observedAt: timestamp,
  })
  .strict()
  .readonly();
export type RetentionObservation = z.infer<typeof retentionObservationSchema>;
const receiptShape = {
  ...format,
  purpose: z.literal("receipt"),
  workspace: workspaceRefSchema,
  epochId: identifier,
  sequence,
  transactionDigest: digest,
  inventoryDigest: digest,
  checkpoint: checkpointSchema,
  observations: z
    .array(
      z
        .object({
          object: archiveObjectRefSchema,
          digest,
          sizeBytes: count,
          verifiedAt: timestamp,
        })
        .strict()
        .readonly(),
    )
    .min(1)
    .readonly(),
  retentionEvidence: z.array(retentionObservationSchema).readonly(),
  verifierId: identifier,
  verifiedAt: timestamp,
};
type ReceiptObservation = z.infer<typeof receiptShape.observations>[number];
/** One consistent observation per exact physical reference; logical content is deduplicated. */
function receiptInventoriesMatch(
  observations: readonly ReceiptObservation[],
): boolean {
  const physical = new Map<string, string>();
  const inventories = {
    primary: new Set<string>(),
    replica: new Set<string>(),
  };
  for (const observation of observations) {
    const identity = physicalObjectIdentity(observation.object);
    const metadata = JSON.stringify([
      observation.digest,
      observation.sizeBytes,
      observation.verifiedAt,
    ]);
    const prior = physical.get(identity);
    if (prior !== undefined && prior !== metadata) return false;
    physical.set(identity, metadata);
    inventories[observation.object.provider].add(
      JSON.stringify([observation.digest, observation.sizeBytes]),
    );
  }
  return (
    inventories.primary.size > 0 &&
    inventories.primary.size === inventories.replica.size &&
    [...inventories.primary].every((identity) =>
      inventories.replica.has(identity),
    )
  );
}
export const protectionReceiptSchema = z
  .object({ ...receiptShape, signature: recoverySignatureSchema })
  .strict()
  .refine((receipt) => {
    const checkpoint = receipt.checkpoint;
    return (
      checkpoint.workspace.ownerId === receipt.workspace.ownerId &&
      checkpoint.workspace.workspaceId === receipt.workspace.workspaceId &&
      checkpoint.epochId === receipt.epochId &&
      checkpoint.sequence === receipt.sequence &&
      checkpoint.transactionDigest === receipt.transactionDigest &&
      checkpoint.inventoryDigest === receipt.inventoryDigest &&
      checkpoint.checkedAt <= receipt.verifiedAt &&
      receiptInventoriesMatch(receipt.observations) &&
      receipt.observations.every(
        (observation) => observation.verifiedAt <= receipt.verifiedAt,
      )
    );
  }, "INVALID_PROTECTION_RECEIPT")
  .readonly();
export type ProtectionReceipt = z.infer<typeof protectionReceiptSchema>;

export const recoveryPlanSchema = z
  .object({
    runId: identifier,
    workspace: workspaceRefSchema,
    lineageId: identifier,
    checkpoint: checkpointSchema.nullable(),
    source: z.enum(["primary", "replica"]),
    destination: z
      .object({ databaseNamespace: namespace, objectNamespace: namespace })
      .strict()
      .readonly(),
    freshnessKnown: z.boolean(),
    requiredObjectDigests: z.array(digest).readonly(),
    quarantinedIds: uniqueIds(),
    outboundEnabled: z.literal(false),
  })
  .strict()
  .readonly();
export type RecoveryPlan = z.infer<typeof recoveryPlanSchema>;
export const recoveryReportSchema = z
  .object({
    runId: identifier,
    restoredVersionCount: count,
    restoredBlobCount: count,
    restoredBytes: count,
    unexplainedMissingCount: count,
    suppressedVersionIds: uniqueIds(),
    quarantinedIds: uniqueIds(),
    checkpoint: checkpointSchema.nullable(),
    freshnessKnown: z.boolean(),
    startedAt: timestamp,
    completedAt: timestamp.nullable(),
    status: z.enum(["complete", "partial", "failed", "quarantined"]),
    outboundEffects: z.literal(0),
  })
  .strict()
  .refine(
    (report) =>
      report.status !== "complete" ||
      (report.unexplainedMissingCount === 0 &&
        report.quarantinedIds.length === 0 &&
        report.checkpoint !== null &&
        report.completedAt !== null),
    "INCOMPLETE_RECOVERY",
  )
  .readonly();
export type RecoveryReport = z.infer<typeof recoveryReportSchema>;
export const syncResultSchema = z
  .object({
    sourceId: identifier,
    imported: count,
    unchanged: count,
    missing: count,
    checkpoint: recoveryJsonSchema.nullable(),
    freshness: z.enum(["current", "stale", "unknown"]),
    error: safeLabel.nullable(),
  })
  .strict()
  .readonly();
export type SyncResult = z.infer<typeof syncResultSchema>;
export const protectionViewSchema = z
  .object({
    versionId: identifier,
    documentApproval: documentApprovalSchema,
    primarySave: z.enum([
      "uploading",
      "prepared_unknown",
      "saved_primary",
      "journal_complete",
    ]),
    replication: z.enum([
      "protection_pending",
      "verified_both",
      "delayed",
      "failed",
      "degraded",
      "suspect",
      "restored",
      "unrecoverable",
    ]),
    integrity: z.enum(["unchecked", "verified", "failed", "unknown"]),
    retentionEvidence: z.array(retentionObservationSchema).readonly(),
    lastCheckedAt: timestamp.nullable(),
    freshnessKnown: z.boolean(),
  })
  .strict()
  .refine(
    (view) =>
      view.replication !== "verified_both" || view.lastCheckedAt !== null,
    "VERIFICATION_TIME_REQUIRED",
  )
  .readonly();
export type ProtectionView = z.infer<typeof protectionViewSchema>;
export const recoveryHealthSchema = z
  .object({
    oldestPendingAt: timestamp.nullable(),
    checkpoint: checkpointSchema.nullable(),
    lastIndependentHeartbeatAt: timestamp.nullable(),
    incidentIds: uniqueIds(),
    status: z.enum(["healthy", "delayed", "critical", "unknown"]),
  })
  .strict()
  .readonly();
export type RecoveryHealth = z.infer<typeof recoveryHealthSchema>;
export const integritySweepResultSchema = z
  .object({
    checkedCount: count,
    failedIds: uniqueIds(),
    nextCursor: safeLabel.nullable(),
    coverageThrough: timestamp.nullable(),
  })
  .strict()
  .readonly();
export type IntegritySweepResult = z.infer<typeof integritySweepResultSchema>;
export const auditEventSchema = z
  .object({
    ...format,
    workspace: workspaceRefSchema,
    eventId: identifier,
    requestId: identifier,
    transactionId: identifier.nullable(),
    actorId: principalIdentitySchema,
    grantId: canonicalIdentitySchema,
    grantRevision: sequence,
    resourceIds: uniqueIds(),
    operation: safeLabel,
    serverTime: timestamp,
    epochId: identifier,
    sequence,
    digests: z.array(digest).readonly(),
    fromState: safeLabel.nullable(),
    toState: safeLabel,
    leaseOwner: identifier.nullable(),
    fence: sequence.nullable(),
    attempt: count,
    providerRequestRef: safeLabel.nullable(),
    errorCategory: safeLabel.nullable(),
    verificationResult: z.enum(["unchecked", "verified", "failed", "unknown"]),
    restoreDecision: safeLabel.nullable(),
    outcome: safeLabel,
  })
  .strict()
  .readonly();
export type AuditEvent = z.infer<typeof auditEventSchema>;
export const recoveryJobResultSchema = z
  .object({
    jobId: identifier,
    transactionId: identifier,
    fence: sequence,
    stage: z.enum([
      "primary_journal",
      "replicate",
      "verify",
      "receipt",
      "complete",
    ]),
    status: z.enum([
      "completed",
      "retryable",
      "dead_letter",
      "quarantined",
      "stale_fence",
    ]),
    attempt: count,
    nextAttemptAt: timestamp.nullable(),
    errorCategory: safeLabel.nullable(),
  })
  .strict()
  .readonly();
export type RecoveryJobResult = z.infer<typeof recoveryJobResultSchema>;
export const domainRevisionInputSchema = z
  .object({
    requestKey: identifier,
    kind: recoveryKindSchema,
    entityId: identifier,
    lineageId: identifier,
    body: recoveryJsonSchema,
    expectedRevision: sequence.nullable(),
    actor: principalSchema,
  })
  .strict()
  .readonly();
export type DomainRevisionInput = z.infer<typeof domainRevisionInputSchema>;

// Archived decisions are evidence. Only the live host resolver can confer current authority.
export const pursuitScopeSchema = z
  .object({
    correspondence: z.boolean(),
    scheduling: z.boolean(),
    conversationIds: uniqueIds(),
    calendarIds: uniqueIds(),
  })
  .strict()
  .readonly();
export type PursuitScope = z.infer<typeof pursuitScopeSchema>;
export const pursuitApprovalEvidenceSchema = z
  .object({
    approvalVersionId: identifier,
    opportunityId: identifier,
    approvedBy: principalIdentitySchema,
    approvedAt: timestamp,
    decision: z.literal("pursue"),
    scope: pursuitScopeSchema,
    expiresAt: timestamp,
    revokedAt: timestamp.nullable(),
  })
  .strict()
  .refine(
    (evidence) =>
      evidence.expiresAt > evidence.approvedAt &&
      (evidence.revokedAt === null ||
        evidence.revokedAt >= evidence.approvedAt),
    "INVALID_APPROVAL_INTERVAL",
  )
  .readonly();
export type PursuitApprovalEvidence = z.infer<
  typeof pursuitApprovalEvidenceSchema
>;
export const currentPursuitAuthorizationSchema = z
  .object({
    opportunityId: identifier,
    approvalVersionId: identifier,
    actorId: principalIdentitySchema,
    resolvedAt: timestamp,
    validUntil: timestamp,
    scope: pursuitScopeSchema,
    authority: z.literal("current_resolver"),
  })
  .strict()
  .refine(
    (authority) => authority.validUntil > authority.resolvedAt,
    "EXPIRED_PURSUIT_AUTHORITY",
  )
  .readonly();
export type CurrentPursuitAuthorization = z.infer<
  typeof currentPursuitAuthorizationSchema
>;
