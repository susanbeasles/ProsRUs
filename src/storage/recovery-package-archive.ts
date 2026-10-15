import type { ArchiveReader } from "../application/recovery-ports";
import { demand } from "../domain/model";
import {
  primaryPackageSchema,
  preparedWrapperSchema,
  type PrimaryPackage,
} from "../domain/recovery-package";
import { hashEnvelope } from "../domain/recovery-canonical";
import type {
  PreparedEnvelope,
  PreparedEnvelopePayload,
} from "../domain/recovery";
import { unboundPayload } from "../domain/recovery-package";
import {
  equalMetadata,
  logicalObject,
  readMetadata,
} from "./recovery-metadata";
import { verifyArtifact } from "./recovery-streams";

export function unsignedPreparation(
  prepared: PreparedEnvelope,
): PreparedEnvelopePayload {
  const { signature, ...payload } = prepared;
  void signature;
  return payload;
}
export function preparedWrapperObject(payload: PreparedEnvelopePayload) {
  return logicalObject(
    payload.packageObject.namespace,
    `preparations/${payload.transactionId}`,
  );
}

/** Checks signed closure and exact physical metadata independently of D1. This is
 * evidence validation only; it never turns an archived candidate into a commit. */
export async function readBoundPrimaryPackage(
  archive: ArchiveReader,
  payload: PreparedEnvelopePayload,
  expected?: PrimaryPackage,
): Promise<PrimaryPackage> {
  const binding = payload.packageBinding;
  demand(binding, "PACKAGE_BINDING_REQUIRED");
  demand(
    payload.packageObject.versionId === null &&
      binding.descriptor.object.provider === "primary" &&
      binding.descriptor.object.versionId !== null &&
      binding.descriptor.object.namespace === payload.packageObject.namespace &&
      binding.descriptor.object.key === payload.packageObject.key,
    "INVALID_PACKAGE_BINDING",
  );
  const stored = await readMetadata(
    archive,
    binding.descriptor.object,
    "inventory",
    binding.descriptor,
  );
  demand(stored, "ARCHIVE_OBJECT_MISSING");
  const core = primaryPackageSchema.parse(stored.value);
  demand(
    equalMetadata(core.proposed, unboundPayload(payload)) &&
      (!expected || equalMetadata(core, expected)),
    "PREPARATION_CONTENT_MISMATCH",
  );
  const all = [...core.proposed.versions, ...core.parents, ...core.sources];
  const versions = new Map(
    all.map((manifest) => [manifest.versionId, manifest]),
  );
  demand(
    core.manifests.length === versions.size &&
      new Set(core.manifests.map((value) => value.versionId)).size ===
        versions.size,
    "RECOVERY_MANIFEST_CLOSURE_MISMATCH",
  );
  for (const item of core.manifests) {
    const manifest = versions.get(item.versionId);
    demand(manifest, "RECOVERY_MANIFEST_CLOSURE_MISMATCH");
    demand(
      item.descriptor.hashPurpose === "manifest" &&
        item.descriptor.digest === (await hashEnvelope("manifest", manifest)) &&
        item.descriptor.object.provider === "primary" &&
        item.descriptor.object.versionId !== null,
      "RECOVERY_MANIFEST_CLOSURE_MISMATCH",
    );
    const read = await readMetadata(
      archive,
      item.descriptor.object,
      "manifest",
      item.descriptor,
    );
    demand(read && equalMetadata(read.value, manifest), "INTEGRITY_MISMATCH");
  }
  demand(
    core.sources.length === payload.sourceDescriptors.length,
    "RECOVERY_SOURCE_CONFLICT",
  );
  for (const source of core.sources) {
    const descriptor = payload.sourceDescriptors.find(
      (value) => value.versionId === source.versionId,
    );
    demand(
      descriptor &&
        descriptor.manifestDigest ===
          (await hashEnvelope("manifest", source)) &&
        descriptor.epochId === source.epochId &&
        descriptor.lineageId === source.lineageId &&
        equalMetadata(descriptor.workspace, source.workspace) &&
        equalMetadata(descriptor.recoveryLocator, source.recoveryLocator),
      "RECOVERY_SOURCE_CONFLICT",
    );
  }
  return core;
}

export async function readPreparationArtifacts(
  archive: ArchiveReader,
  prepared: PreparedEnvelope,
) {
  await readBoundPrimaryPackage(archive, unsignedPreparation(prepared));
  const stored = await readMetadata(
    archive,
    preparedWrapperObject(prepared),
    "preparation",
  );
  demand(stored, "PREPARED_WRAPPER_MISSING");
  const wrapper = preparedWrapperSchema.parse(stored.value);
  demand(
    equalMetadata(wrapper.prepared, prepared) &&
      equalMetadata(wrapper.packageBinding, prepared.packageBinding),
    "PREPARATION_CONTENT_MISMATCH",
  );
  return {
    package: wrapper.packageBinding.descriptor,
    wrapper: stored.descriptor,
  };
}
export async function verifyPackageArtifacts(
  archive: ArchiveReader,
  core: PrimaryPackage,
): Promise<void> {
  for (const descriptor of core.proposed.objects)
    await verifyArtifact(archive, descriptor);
}
