import type {
  AuthenticatedRecoveryContext,
  PrimaryArchive,
  RecoveryPreparationAuthority,
  RecoverySigner,
  RecoveryUploadResolver,
} from "./recovery-ports";
import type { PreparedEnvelope, SaveVersionInput } from "../domain/recovery";
import {
  preparedEnvelopePayloadSchema,
  primaryPackageBindingSchema,
} from "../domain/recovery";
import { preparedWrapperSchema } from "../domain/recovery-package";
import { canonicalizeEnvelope } from "../domain/recovery-canonical";
import { demand } from "../domain/model";
import {
  buildPrimaryPackage,
  sameAcceptedPreparation,
  validateAcceptedPreparation,
} from "./recovery-package-content";
import { sameSaveInput, snapshotSaveInput } from "./recovery-request";
import {
  equalMetadata,
  readMetadata,
  writeMetadata,
} from "../storage/recovery-metadata";
import {
  preparedWrapperObject,
  readBoundPrimaryPackage,
  readPreparationArtifacts,
  unsignedPreparation,
} from "../storage/recovery-package-archive";

type PreparationPorts = Readonly<{
  archive: PrimaryArchive;
  signer: RecoverySigner;
  authority?: RecoveryPreparationAuthority;
  uploads?: RecoveryUploadResolver;
}>;

/** Preparation preserves intent, never commits D1 or acknowledges a saved version.
 * The host must check request replay before invoking this new-candidate path. */
export async function prepareRecoveryPackage(
  input: SaveVersionInput,
  context: AuthenticatedRecoveryContext,
  ports: PreparationPorts,
): Promise<PreparedEnvelope> {
  demand(ports.authority, "RECOVERY_PREPARATION_AUTHORITY_UNAVAILABLE", 503);
  const request = snapshotSaveInput(input);
  const accepted = await ports.authority.accept(request, context);
  validateAcceptedPreparation(accepted, context);
  demand(
    sameSaveInput(request, snapshotSaveInput(accepted.input)),
    "PREPARATION_CONTENT_MISMATCH",
  );
  const core = await buildPrimaryPackage(
    accepted,
    {
      archive: ports.archive,
      uploads: ports.uploads,
      trustRootIds: ports.signer.capabilities.trustRootIds,
    },
    "persist",
  );
  const descriptor = await writeMetadata(
    ports.archive,
    core.proposed.packageObject,
    "inventory",
    core,
  );
  const packageBinding = primaryPackageBindingSchema.parse({
    formatVersion: 1,
    packageFormat: "recovery-package-v1",
    descriptor,
  });
  const payload = preparedEnvelopePayloadSchema.parse({
    ...core.proposed,
    packageBinding,
  });
  canonicalizeEnvelope(payload);
  await readBoundPrimaryPackage(ports.archive, payload, core);
  const wrapperObject = preparedWrapperObject(payload);
  async function existing(): Promise<PreparedEnvelope | null> {
    const stored = await readMetadata(
      ports.archive,
      wrapperObject,
      "preparation",
    );
    if (!stored) return null;
    const wrapper = preparedWrapperSchema.parse(stored.value);
    demand(
      equalMetadata(unsignedPreparation(wrapper.prepared), payload) &&
        equalMetadata(wrapper.packageBinding, packageBinding),
      "PREPARATION_CONTENT_MISMATCH",
    );
    await ports.signer.verifyPreparation(wrapper.prepared);
    return wrapper.prepared;
  }
  let prepared = await existing();
  if (!prepared) {
    prepared = await ports.signer.signPreparation(payload, context);
    demand(
      equalMetadata(unsignedPreparation(prepared), payload),
      "PREPARATION_CONTENT_MISMATCH",
    );
    const wrapper = preparedWrapperSchema.parse({
      formatVersion: 1,
      type: "prepared_wrapper",
      commitStatus: "unknown",
      packageBinding,
      prepared,
    });
    try {
      await writeMetadata(ports.archive, wrapperObject, "preparation", wrapper);
    } catch (error) {
      const retained = await existing();
      if (!retained) throw error;
      prepared = retained;
    }
  }
  await readBoundPrimaryPackage(ports.archive, payload, core);
  await readPreparationArtifacts(ports.archive, prepared);
  await ports.signer.verifyPreparation(prepared);
  const current = await ports.authority.resolveAccepted(
    accepted.transactionId,
    context,
  );
  demand(current, "PREPARATION_NOT_ACCEPTED", 403);
  validateAcceptedPreparation(current, context);
  demand(
    sameAcceptedPreparation(accepted, current),
    "PREPARATION_CONTENT_MISMATCH",
  );
  return prepared;
}
