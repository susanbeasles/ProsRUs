import { validateArchivedOriginalSource } from "./recovery-archive-source";
import {
  isOriginalRole,
  validateCommittedOriginal,
  validateOriginalDescriptor,
} from "./recovery-domain-original";
import { LIMITS, detachedJson } from "../../integration/shared-contract.mjs";
import { demand } from "../domain/model";
import {
  acceptedDomainPlanSchema,
  domainPlanDigest,
  domainRequestDigest,
  parseDomainPlan,
  validateCandidateVersions,
  MAX_DOMAIN_REFERENCES,
  type DomainPlan,
  type AcceptedDomainPlan,
} from "../domain/recovery-domain-plan";
import {
  detachedDomainValue,
  recoveryKindForRecord,
} from "../domain/recovery-record";
import {
  canonicalizeEnvelope,
  hashEnvelope,
} from "../domain/recovery-canonical";
import {
  preparedEnvelopePayloadSchema,
  versionManifestSchema,
  type BlobDescriptor,
  type VersionManifest,
  type ArchiveMetadataDescriptor,
} from "../domain/recovery";
import {
  primaryPackageSchema,
  type PrimaryPackage,
} from "../domain/recovery-package";
import type {
  AcceptedPreparation,
  PrimaryArchive,
  RecoveryUploadResolver,
} from "./recovery-ports";
import {
  equalMetadata,
  logicalObject,
  readMetadata,
  writeMetadata,
} from "../storage/recovery-metadata";
import { artifactDigest, verifyArtifact } from "../storage/recovery-streams";
import { resolveRequestUpload, sameSaveInput } from "./recovery-request";
import { recoveryFormat } from "./recovery-package-content";

type Ports = Readonly<{
  archive: PrimaryArchive;
  uploads?: RecoveryUploadResolver;
  trustRootIds: readonly string[];
}>;
function sameIds(a: readonly string[], b: readonly string[]) {
  return (
    a.length === b.length &&
    new Set(a).size === a.length &&
    a.every((x) => b.includes(x))
  );
}
type Candidate = DomainPlan["candidates"][number];
function readDomainAcceptance(accepted: AcceptedPreparation, ports: Ports) {
  const property = Object.getOwnPropertyDescriptor(accepted, "domainPlan");
  demand(
    property && "value" in property && property.enumerable,
    "INVALID_DOMAIN_ACCEPTANCE",
  );
  const binding = acceptedDomainPlanSchema.parse(
    detachedDomainValue(property.value),
  );
  const plan = parseDomainPlan(binding.plan);
  validateCandidateVersions(plan, binding.candidateVersions);
  demand(
    equalMetadata(plan.workspace, accepted.context.workspace) &&
      plan.actorId === accepted.context.actor.id,
    "DOMAIN_AUTHORITY_MISMATCH",
  );
  demand(
    ports.trustRootIds.length > 0,
    "RECOVERY_SIGNING_AUTHORITY_UNAVAILABLE",
    503,
  );
  demand(
    binding.currentHeads.length === plan.candidates.length &&
      new Set(binding.currentHeads.map((h) => h.role)).size ===
        plan.candidates.length,
    "DOMAIN_HEAD_MAPPING_MISMATCH",
  );
  const resultCandidate = plan.candidates.find(
    (c) => c.role === plan.resultRecord.candidateRole,
  );
  demand(resultCandidate, "DOMAIN_RESULT_MISMATCH");
  demand(
    binding.candidateVersions.find((v) => v.role === resultCandidate.role)
      ?.versionId === accepted.versionId,
    "DOMAIN_RESULT_MISMATCH",
  );
  demand(
    sameSaveInput(accepted.input, {
      requestKey: plan.requestKey,
      lineageId: resultCandidate.lineageId,
      entityId: resultCandidate.snapshot.entityId,
      kind: recoveryKindForRecord[resultCandidate.snapshot.recordKind],
      expectedParentIds: resultCandidate.parentVersionIds,
      branchRequested: false,
      sourceVersionIds: resultCandidate.sourceVersionIds,
      content: resultCandidate.snapshot,
    }),
    "DOMAIN_PRIMARY_INPUT_MISMATCH",
  );
  return { binding, plan };
}
function resolveDomainClosure(
  accepted: AcceptedPreparation,
  binding: AcceptedDomainPlan,
  plan: DomainPlan,
) {
  demand(
    accepted.parents.length + accepted.sources.length <= MAX_DOMAIN_REFERENCES,
    "DOMAIN_CLOSURE_TOO_LARGE",
  );
  for (const values of [accepted.parents, accepted.sources])
    demand(
      new Set(values.map((v) => v.versionId)).size === values.length,
      "DUPLICATE_DOMAIN_CLOSURE",
    );
  detachedJson(
    {
      domainPlan: binding,
      parents: accepted.parents,
      sources: accepted.sources,
    },
    { maxBytes: LIMITS.privateComposite },
  );
  const supplied = new Map<string, VersionManifest>();
  for (const raw of [...accepted.parents, ...accepted.sources]) {
    const value = versionManifestSchema.parse(detachedDomainValue(raw));
    const prior = supplied.get(value.versionId);
    demand(!prior || equalMetadata(prior, value), "RECOVERY_CLOSURE_CONFLICT");
    demand(
      equalMetadata(value.workspace, plan.workspace),
      "RECOVERY_CLOSURE_OWNER_MISMATCH",
    );
    demand(
      !binding.candidateVersions.some((v) => v.versionId === value.versionId),
      "DOMAIN_CANDIDATE_SOURCE_FORBIDDEN",
    );
    supplied.set(value.versionId, value);
  }
  demand(supplied.size <= MAX_DOMAIN_REFERENCES, "DOMAIN_CLOSURE_TOO_LARGE");
  const selected = new Set<string>(),
    active = new Set<string>(),
    parentIds = new Set<string>(),
    sourceIds = new Set<string>();
  function visit(versionId: string, role: "parent" | "source") {
    const target = role === "parent" ? parentIds : sourceIds;
    target.add(versionId);
    demand(!active.has(versionId), "RECOVERY_CLOSURE_CYCLE");
    const manifest = supplied.get(versionId);
    demand(manifest, "RECOVERY_MANIFEST_CLOSURE_MISMATCH");
    if (selected.has(versionId)) return;
    active.add(versionId);
    for (const id of manifest.parentVersionIds) visit(id, role);
    for (const id of manifest.sourceVersionIds) visit(id, "source");
    active.delete(versionId);
    selected.add(versionId);
  }
  for (const candidate of plan.candidates) {
    const head = binding.currentHeads.find((h) => h.role === candidate.role);
    demand(
      head && sameIds(head.versionIds, candidate.parentVersionIds),
      "RECOVERY_HEAD_CONFLICT",
      409,
    );
    for (const id of candidate.parentVersionIds) {
      visit(id, "parent");
      const parent = supplied.get(id);
      demand(
        parent &&
          parent.lineageId === candidate.lineageId &&
          parent.entityId === candidate.snapshot.entityId &&
          parent.kind === recoveryKindForRecord[candidate.snapshot.recordKind],
        "RECOVERY_PARENT_CONFLICT",
        409,
      );
    }
    for (const id of [
      ...candidate.sourceVersionIds,
      ...candidate.approval.evidenceVersionIds,
    ])
      visit(id, "source");
  }
  demand(selected.size === supplied.size, "UNAUTHORIZED_DOMAIN_CLOSURE");
  const committed = [...selected].map((id) => {
    const value = supplied.get(id);
    demand(value, "RECOVERY_MANIFEST_CLOSURE_MISMATCH");
    return value;
  });
  return {
    supplied,
    committed,
    parents: committed.filter((m) => parentIds.has(m.versionId)),
    sources: committed.filter((m) => sourceIds.has(m.versionId)),
  };
}
function domainArtifactArchive(
  accepted: AcceptedPreparation,
  ports: Ports,
  access: "persist" | "read",
  plan: DomainPlan,
  supplied: ReadonlyMap<string, VersionManifest>,
) {
  const objects: BlobDescriptor[] = [];
  async function include(descriptor: BlobDescriptor) {
    demand(
      descriptor.object.provider === "primary" &&
        descriptor.object.versionId !== null,
      "RECOVERY_PRIMARY_CLOSURE_REQUIRED",
    );
    const prior = objects.find((d) =>
      equalMetadata(d.object, descriptor.object),
    );
    demand(
      !prior || equalMetadata(prior, descriptor),
      "RECOVERY_DESCRIPTOR_CONFLICT",
    );
    if (!prior) {
      await verifyArtifact(ports.archive, descriptor);
      objects.push(descriptor);
    }
    return descriptor;
  }
  async function bytesArtifact(bytes: Uint8Array, mediaType: string) {
    const digest = artifactDigest(bytes);
    const object = logicalObject(accepted.namespace, `blobs/${digest}`);
    const stored =
      access === "persist"
        ? await ports.archive.putImmutable({
            object,
            bytes,
            digest,
            hashPurpose: "blob",
          })
        : await ports.archive.getStream(object);
    demand(stored, "ARCHIVE_OBJECT_MISSING");
    if ("body" in stored) await stored.body.cancel();
    return include({
      schemaVersion: 1,
      hashAlgorithm: "sha256-domain-v1",
      digest,
      sizeBytes: bytes.length,
      mediaType,
      object: stored.object,
    });
  }
  async function candidateArtifacts(candidate: Candidate) {
    const artifacts = [
      await bytesArtifact(
        canonicalizeEnvelope(candidate.snapshot),
        "application/json",
      ),
    ];
    for (const artifact of candidate.artifacts) {
      const source = artifact.source;
      if (source.type === "utf8")
        artifacts.push(
          await bytesArtifact(
            new TextEncoder().encode(source.text),
            source.mediaType,
          ),
        );
      else if (source.type === "legacy_body") {
        const guard = plan.readSet.records.find(
          (r) =>
            r.recordKind === source.recordKind &&
            r.entityId === source.entityId,
        );
        demand(guard?.state === "present", "DOMAIN_RECORD_GUARD_REQUIRED");
        artifacts.push(
          await bytesArtifact(
            new TextEncoder().encode(guard.rawBody),
            "application/json",
          ),
        );
      } else if (source.type === "committed") {
        const committed = supplied.get(source.versionId);
        const descriptor = committed?.artifacts[source.artifactIndex];
        if (isOriginalRole(candidate, artifact.role)) {
          demand(committed, "DOMAIN_ARTIFACT_SOURCE_MISSING");
          validateCommittedOriginal(committed, source.artifactIndex);
        }
        demand(descriptor, "DOMAIN_ARTIFACT_SOURCE_MISSING");
        artifacts.push(await include(descriptor));
      } else {
        const upload = await resolveRequestUpload(
          {
            ...accepted.input,
            content: undefined,
            uploadHandle: source.uploadHandle,
          },
          accepted.context,
          ports.uploads,
        );
        demand(
          upload &&
            upload.artifact.digest === source.digest &&
            upload.artifact.sizeBytes === source.sizeBytes &&
            upload.artifact.mediaType === source.mediaType,
          "DOMAIN_UPLOAD_MISMATCH",
        );
        artifacts.push(await include(upload.artifact));
      }
    }
    validateOriginalDescriptor(candidate, artifacts);
    return artifacts;
  }
  return { objects, include, candidateArtifacts };
}
function domainManifest(
  accepted: AcceptedPreparation,
  binding: AcceptedDomainPlan,
  plan: DomainPlan,
  ports: Ports,
  candidate: Candidate,
  artifacts: BlobDescriptor[],
  objects: readonly BlobDescriptor[],
) {
  const sequence = String(BigInt(accepted.context.chain.sequence) + 1n);
  const assignment = binding.candidateVersions.find(
    (v) => v.role === candidate.role,
  );
  demand(assignment, "DOMAIN_VERSION_MAPPING_MISMATCH");
  return versionManifestSchema.parse({
    ...recoveryFormat,
    workspace: plan.workspace,
    epochId: accepted.context.chain.epochId,
    sequence,
    transactionId: accepted.transactionId,
    versionId: assignment.versionId,
    lineageId: candidate.lineageId,
    entityId: candidate.snapshot.entityId,
    kind: recoveryKindForRecord[candidate.snapshot.recordKind],
    parentVersionIds: candidate.parentVersionIds,
    branchRequested: false,
    sourceVersionIds: candidate.sourceVersionIds,
    recordSnapshot: candidate.snapshot,
    artifacts,
    approval: candidate.approval,
    actorId: plan.actorId,
    createdAt: accepted.context.serverTime,
    generationRecipe: candidate.observation
      ? {
          templateId: null,
          rendererId: "legacy-observation-v1",
          modelId: null,
          permittedInputVersionIds: [],
          parameters: candidate.observation,
        }
      : null,
    recoveryLocator: {
      workspaceId: plan.workspace.workspaceId,
      lineageId: candidate.lineageId,
      formatVersion: 1,
      namespace: accepted.namespace,
      archives: [
        ...new Set([
          accepted.namespace,
          ...objects.map((o) => o.object.namespace),
        ]),
      ].map((namespace) => ({ provider: "primary", namespace })),
      trustRootIds: ports.trustRootIds,
    },
  });
}
async function domainManifestDescriptors(
  accepted: AcceptedPreparation,
  ports: Ports,
  access: "persist" | "read",
  versions: readonly VersionManifest[],
  committed: readonly VersionManifest[],
) {
  const manifests: {
    versionId: string;
    descriptor: ArchiveMetadataDescriptor;
  }[] = [];
  for (const value of [...versions, ...committed]) {
    const digest = await hashEnvelope("manifest", value),
      object = logicalObject(accepted.namespace, `manifests/${digest}`);
    let descriptor: ArchiveMetadataDescriptor;
    if (access === "persist")
      descriptor = await writeMetadata(
        ports.archive,
        object,
        "manifest",
        value,
      );
    else {
      const read = await readMetadata(ports.archive, object, "manifest");
      demand(
        read &&
          read.descriptor.digest === digest &&
          equalMetadata(read.value, value),
        "INTEGRITY_MISMATCH",
      );
      descriptor = read.descriptor;
    }
    manifests.push({ versionId: value.versionId, descriptor });
  }
  return manifests;
}
async function domainPayload(
  accepted: AcceptedPreparation,
  binding: AcceptedDomainPlan,
  plan: DomainPlan,
  versions: VersionManifest[],
  objects: BlobDescriptor[],
  sources: readonly VersionManifest[],
) {
  const sequence = String(BigInt(accepted.context.chain.sequence) + 1n);
  const sourceDescriptors = await Promise.all(
    sources.map(async (source) => ({
      versionId: source.versionId,
      workspace: source.workspace,
      epochId: source.epochId,
      lineageId: source.lineageId,
      manifestDigest: await hashEnvelope("manifest", source),
      recoveryLocator: source.recoveryLocator,
    })),
  );
  const primary = versions.find((v) => v.versionId === accepted.versionId);
  demand(primary, "DOMAIN_RESULT_MISMATCH");
  return preparedEnvelopePayloadSchema.parse({
    ...recoveryFormat,
    purpose: "preparation",
    workspace: plan.workspace,
    epochId: accepted.context.chain.epochId,
    sequence,
    previousTransactionDigest: accepted.context.chain.previousTransactionDigest,
    transactionId: accepted.transactionId,
    requestKey: plan.requestKey,
    requestDigest: await domainRequestDigest(plan),
    actorId: plan.actorId,
    issuer: accepted.context.issuer,
    audience: accepted.context.audience,
    grant: accepted.context.grant,
    createdAt: accepted.context.serverTime,
    versions,
    events: [],
    expectedHeads: versions.map((v) => ({
      lineageId: v.lineageId,
      parentVersionIds: v.parentVersionIds,
      branchRequested: false,
    })),
    objects,
    sourceDescriptors,
    packageObject: logicalObject(
      accepted.namespace,
      `packages/${accepted.transactionId}`,
    ),
    result: {
      versionId: primary.versionId,
      transactionId: primary.transactionId,
      digest: await hashEnvelope("manifest", primary),
      statusUrl: `/versions/${primary.versionId}/protection`,
      status: "saved_primary",
      protection: "protection_pending",
    },
    domainEffects: {
      format: "domain-effects-v1",
      planDigest: await domainPlanDigest(plan),
      plan,
      candidateVersions: binding.candidateVersions,
    },
  });
}
/** Persist and read-only signing both execute this exact accepted-plan assembly. */
export async function buildDomainPrimaryPackage(
  accepted: AcceptedPreparation,
  ports: Ports,
  access: "persist" | "read",
): Promise<PrimaryPackage> {
  const { binding, plan } = readDomainAcceptance(accepted, ports);
  const { supplied, committed, parents, sources } = resolveDomainClosure(
    accepted,
    binding,
    plan,
  );
  for (const source of plan.readSet.archiveSources ?? []) {
    const manifest = supplied.get(source.versionId);
    demand(manifest, "ARCHIVE_SOURCE_MANIFEST_MISSING");
    await validateArchivedOriginalSource(source, manifest);
  }
  const artifacts = domainArtifactArchive(
    accepted,
    ports,
    access,
    plan,
    supplied,
  );
  for (const manifest of committed)
    for (const descriptor of manifest.artifacts)
      await artifacts.include(descriptor);
  const versions: VersionManifest[] = [];
  for (const candidate of plan.candidates) {
    const selected = await artifacts.candidateArtifacts(candidate);
    versions.push(
      domainManifest(
        accepted,
        binding,
        plan,
        ports,
        candidate,
        selected,
        artifacts.objects,
      ),
    );
  }
  const manifests = await domainManifestDescriptors(
    accepted,
    ports,
    access,
    versions,
    committed,
  );
  const proposed = await domainPayload(
    accepted,
    binding,
    plan,
    versions,
    artifacts.objects,
    sources,
  );
  const core = primaryPackageSchema.parse({
    formatVersion: 1,
    type: "recovery_package",
    commitStatus: "unknown",
    proposed,
    parents,
    sources,
    manifests,
  });
  canonicalizeEnvelope(proposed);
  canonicalizeEnvelope(core);
  return core;
}
