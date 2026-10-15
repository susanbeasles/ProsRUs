import { buildDomainPrimaryPackage } from "./recovery-domain-package";
import { id, demand } from "../domain/model";
import {
  authenticatedRecoveryContextSchema,
  preparedEnvelopePayloadSchema,
  versionManifestSchema,
  type ArchiveMetadataDescriptor,
  type AuthenticatedRecoveryContext,
  type BlobDescriptor,
  type VersionManifest,
} from "../domain/recovery";
import {
  primaryPackageSchema,
  type PrimaryPackage,
} from "../domain/recovery-package";
import {
  hashEnvelope,
  RECOVERY_CANONICALIZATION_VERSION,
  RECOVERY_HASH_ALGORITHM,
  RECOVERY_SCHEMA_VERSION,
} from "../domain/recovery-canonical";
import type {
  AcceptedPreparation,
  PrimaryArchive,
  RecoveryUploadResolver,
} from "./recovery-ports";
import {
  directContentBytes,
  recoveryRequestDigest,
  resolveRequestUpload,
  snapshotSaveInput,
  sameSaveInput,
} from "./recovery-request";
import { artifactDigest, verifyArtifact } from "../storage/recovery-streams";
import {
  equalMetadata,
  logicalObject,
  readMetadata,
  writeMetadata,
} from "../storage/recovery-metadata";

export const recoveryFormat = {
  schemaVersion: RECOVERY_SCHEMA_VERSION,
  canonicalizationVersion: RECOVERY_CANONICALIZATION_VERSION,
  hashAlgorithm: RECOVERY_HASH_ALGORITHM,
} as const;
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((id) => right.includes(id))
  );
}
function orderedClosure(
  ids: readonly string[],
  manifests: readonly VersionManifest[],
  failure: string,
): readonly VersionManifest[] {
  demand(
    sameSet(
      ids,
      manifests.map((manifest) => manifest.versionId),
    ),
    failure,
    409,
  );
  return ids.map((id) => {
    const manifest = manifests.find((value) => value.versionId === id);
    demand(manifest, failure, 409);
    return versionManifestSchema.parse(manifest);
  });
}
export function validateAcceptedPreparation(
  accepted: AcceptedPreparation,
  context: AuthenticatedRecoveryContext,
): void {
  demand(
    accepted.format === "bound-primary-v1",
    "UNSUPPORTED_PREPARATION_FORMAT",
    503,
  );
  authenticatedRecoveryContextSchema.parse(context);
  authenticatedRecoveryContextSchema.parse(accepted.context);
  demand(
    equalMetadata(context, accepted.context),
    "RECOVERY_AUTHORITY_MISMATCH",
    403,
  );
  demand(
    Number.isSafeInteger(accepted.now) &&
      accepted.now >= context.serverTime &&
      context.actor.expiresAt > accepted.now &&
      context.grant.expiresAt > accepted.now,
    "EXPIRED_RECOVERY_AUTHORITY",
    403,
  );
  demand(
    equalMetadata(accepted.currentChain, context.chain),
    "RECOVERY_CHAIN_CONFLICT",
    409,
  );
  id.parse(accepted.transactionId);
  id.parse(accepted.versionId);
  id.parse(accepted.namespace);
}
function closure(accepted: AcceptedPreparation) {
  const input = snapshotSaveInput(accepted.input);
  const parents = orderedClosure(
    input.expectedParentIds,
    accepted.parents,
    "RECOVERY_PARENT_CONFLICT",
  );
  const sources = orderedClosure(
    input.sourceVersionIds,
    accepted.sources,
    "RECOVERY_SOURCE_CONFLICT",
  );
  if (!input.branchRequested)
    demand(
      sameSet(input.expectedParentIds, accepted.currentHeads),
      "RECOVERY_HEAD_CONFLICT",
      409,
    );
  const unique = new Map<string, VersionManifest>();
  for (const manifest of [...parents, ...sources]) {
    demand(
      equalMetadata(manifest.workspace, accepted.context.workspace),
      "RECOVERY_CLOSURE_OWNER_MISMATCH",
      403,
    );
    demand(
      manifest.versionId !== accepted.versionId &&
        !manifest.parentVersionIds.includes(accepted.versionId) &&
        !manifest.sourceVersionIds.includes(accepted.versionId),
      "RECOVERY_CLOSURE_CYCLE",
    );
    const prior = unique.get(manifest.versionId);
    demand(
      !prior || equalMetadata(prior, manifest),
      "RECOVERY_CLOSURE_CONFLICT",
    );
    unique.set(manifest.versionId, manifest);
  }
  for (const parent of parents)
    demand(
      parent.lineageId === input.lineageId &&
        parent.entityId === input.entityId &&
        parent.kind === input.kind,
      "RECOVERY_PARENT_CONFLICT",
      409,
    );
  return { input, parents, sources, committed: [...unique.values()] };
}

/** Shared deterministic assembly. Preparation may write missing immutable evidence;
 * the signer passes read-only mode and independently reconstructs the accepted request. */
export async function buildPrimaryPackage(
  accepted: AcceptedPreparation,
  ports: Readonly<{
    archive: PrimaryArchive;
    uploads?: RecoveryUploadResolver;
    trustRootIds: readonly string[];
  }>,
  access: "persist" | "read",
): Promise<PrimaryPackage> {
  validateAcceptedPreparation(accepted, accepted.context);
  if (Object.prototype.hasOwnProperty.call(accepted, "domainPlan"))
    return buildDomainPrimaryPackage(accepted, ports, access);
  const { input, parents, sources, committed } = closure(accepted);
  const { archive } = ports;
  demand(
    ports.trustRootIds.length > 0,
    "RECOVERY_SIGNING_AUTHORITY_UNAVAILABLE",
    503,
  );
  const upload = await resolveRequestUpload(
    input,
    accepted.context,
    ports.uploads,
  );
  let artifact: BlobDescriptor;
  let snapshot: unknown;
  if (upload) {
    artifact = upload.artifact;
    snapshot = { type: "exact_original", original: upload.original };
  } else {
    const bytes = directContentBytes(input);
    const digest = artifactDigest(bytes);
    const object = logicalObject(accepted.namespace, `blobs/${digest}`);
    const stored =
      access === "persist"
        ? await archive.putImmutable({
            object,
            bytes,
            digest,
            hashPurpose: "blob",
          })
        : await archive.getStream(object);
    demand(stored, "ARCHIVE_OBJECT_MISSING");
    if ("body" in stored) await stored.body.cancel();
    artifact = {
      schemaVersion: 1,
      hashAlgorithm: RECOVERY_HASH_ALGORITHM,
      digest,
      sizeBytes: bytes.length,
      mediaType: "application/octet-stream",
      object: stored.object,
    };
    snapshot =
      input.content instanceof Uint8Array
        ? { type: "exact_bytes", sizeBytes: bytes.length }
        : input.content;
  }
  const objects: BlobDescriptor[] = [];
  const identities = new Map<string, BlobDescriptor>();
  for (const descriptor of [
    artifact,
    ...committed.flatMap((manifest) => manifest.artifacts),
  ]) {
    demand(
      descriptor.object.provider === "primary" &&
        descriptor.object.versionId !== null,
      "RECOVERY_PRIMARY_CLOSURE_REQUIRED",
    );
    const identity = JSON.stringify(descriptor.object);
    const prior = identities.get(identity);
    demand(
      !prior || equalMetadata(prior, descriptor),
      "RECOVERY_DESCRIPTOR_CONFLICT",
    );
    if (!prior) {
      await verifyArtifact(archive, descriptor);
      identities.set(identity, descriptor);
      objects.push(descriptor);
    }
  }
  const sequence = String(BigInt(accepted.context.chain.sequence) + 1n);
  const namespaces = [
    ...new Set([
      accepted.namespace,
      ...objects.map((value) => value.object.namespace),
    ]),
  ];
  const manifest = versionManifestSchema.parse({
    ...recoveryFormat,
    workspace: accepted.context.workspace,
    epochId: accepted.context.chain.epochId,
    sequence,
    transactionId: accepted.transactionId,
    versionId: accepted.versionId,
    lineageId: input.lineageId,
    entityId: input.entityId,
    kind: input.kind,
    parentVersionIds: input.expectedParentIds,
    branchRequested: input.branchRequested,
    sourceVersionIds: input.sourceVersionIds,
    recordSnapshot: snapshot,
    artifacts: [artifact],
    approval: { state: "draft", evidenceVersionIds: [] },
    actorId: accepted.context.actor.id,
    createdAt: accepted.context.serverTime,
    generationRecipe: null,
    recoveryLocator: {
      workspaceId: accepted.context.workspace.workspaceId,
      lineageId: input.lineageId,
      formatVersion: 1,
      namespace: accepted.namespace,
      archives: namespaces.map((namespace) => ({
        provider: "primary",
        namespace,
      })),
      trustRootIds: ports.trustRootIds,
    },
  });
  const manifests: {
    versionId: string;
    descriptor: ArchiveMetadataDescriptor;
  }[] = [];
  for (const value of [manifest, ...committed]) {
    const digest = await hashEnvelope("manifest", value);
    const object = logicalObject(accepted.namespace, `manifests/${digest}`);
    let descriptor: ArchiveMetadataDescriptor;
    if (access === "persist")
      descriptor = await writeMetadata(archive, object, "manifest", value);
    else {
      const stored = await readMetadata(archive, object, "manifest");
      demand(stored, "ARCHIVE_OBJECT_MISSING");
      demand(
        equalMetadata(stored.value, value) &&
          stored.descriptor.digest === digest,
        "INTEGRITY_MISMATCH",
      );
      descriptor = stored.descriptor;
    }
    manifests.push({ versionId: value.versionId, descriptor });
  }
  const sourceDescriptors = [];
  for (const source of sources)
    sourceDescriptors.push({
      versionId: source.versionId,
      workspace: source.workspace,
      epochId: source.epochId,
      lineageId: source.lineageId,
      manifestDigest: await hashEnvelope("manifest", source),
      recoveryLocator: source.recoveryLocator,
    });
  const result = {
    versionId: manifest.versionId,
    transactionId: manifest.transactionId,
    digest: await hashEnvelope("manifest", manifest),
    statusUrl: `/versions/${manifest.versionId}/protection`,
    status: "saved_primary",
    protection: "protection_pending",
  };
  const proposed = preparedEnvelopePayloadSchema.parse({
    ...recoveryFormat,
    purpose: "preparation",
    workspace: accepted.context.workspace,
    epochId: accepted.context.chain.epochId,
    sequence,
    previousTransactionDigest: accepted.context.chain.previousTransactionDigest,
    transactionId: accepted.transactionId,
    requestKey: input.requestKey,
    requestDigest: await recoveryRequestDigest(
      input,
      accepted.context.workspace,
      upload,
    ),
    actorId: accepted.context.actor.id,
    issuer: accepted.context.issuer,
    audience: accepted.context.audience,
    grant: accepted.context.grant,
    createdAt: accepted.context.serverTime,
    versions: [manifest],
    events: [],
    expectedHeads: [
      {
        lineageId: input.lineageId,
        parentVersionIds: input.expectedParentIds,
        branchRequested: input.branchRequested,
      },
    ],
    objects,
    sourceDescriptors,
    packageObject: logicalObject(
      accepted.namespace,
      `packages/${accepted.transactionId}`,
    ),
    result,
  });
  return primaryPackageSchema.parse({
    formatVersion: 1,
    type: "recovery_package",
    commitStatus: "unknown",
    proposed,
    parents,
    sources,
    manifests,
  });
}

export function sameAcceptedPreparation(
  left: AcceptedPreparation,
  right: AcceptedPreparation,
): boolean {
  const { input: leftInput, now: leftNow, ...leftFields } = left;
  const { input: rightInput, now: rightNow, ...rightFields } = right;
  void leftNow;
  void rightNow;
  return (
    sameSaveInput(leftInput, rightInput) &&
    equalMetadata(leftFields, rightFields)
  );
}
