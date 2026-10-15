import type {
  AuthenticatedRecoveryContext,
  PrimaryArchive,
  RecoveryCommitAuthority,
  RecoveryPreparationAuthority,
  RecoverySigner,
  RecoverySigningCustody,
  RecoveryUploadResolver,
} from "../application/recovery-ports";
import {
  buildPrimaryPackage,
  recoveryFormat,
  sameAcceptedPreparation,
  validateAcceptedPreparation,
} from "../application/recovery-package-content";
import { demand, DomainError } from "../domain/model";
import {
  authenticatedRecoveryContextSchema,
  commitCertificatePayloadSchema,
  commitCertificateSchema,
  preparedEnvelopePayloadSchema,
  preparedEnvelopeSchema,
  type PreparedEnvelope,
  type PreparedEnvelopePayload,
} from "../domain/recovery";
import {
  canonicalizeEnvelope,
  hashEnvelope,
  verifyRecoverySignature,
} from "../domain/recovery-canonical";
import { equalMetadata } from "../storage/recovery-metadata";
import {
  readBoundPrimaryPackage,
  readPreparationArtifacts,
  unsignedPreparation,
  verifyPackageArtifacts,
} from "../storage/recovery-package-archive";

type SigningPorts = Readonly<{
  archive: PrimaryArchive;
  authority: RecoveryPreparationAuthority;
  custody: RecoverySigningCustody;
  uploads?: RecoveryUploadResolver;
  commitAuthority?: RecoveryCommitAuthority;
}>;

/** No keys, issuer, authorization or synthetic fallback are created here. Only a
 * registered trusted host may supply these capabilities; unavailable means denial. */
export function createRecoverySigner(ports?: SigningPorts): RecoverySigner {
  if (!ports) {
    const unavailable = async (): Promise<never> => {
      throw new DomainError("RECOVERY_SIGNING_AUTHORITY_UNAVAILABLE", 503);
    };
    return {
      capabilities: {
        custody: "trusted_server",
        algorithms: [],
        trustRootIds: [],
      },
      signPreparation: unavailable,
      signCommit: unavailable,
      verifyPreparation: unavailable,
    };
  }
  const { archive, authority, custody, uploads } = ports;
  demand(
    custody.verificationKey.publicKey.type === "public",
    "SIGNATURE_POLICY_MISMATCH",
  );
  const capabilities = {
    custody: "trusted_server" as const,
    algorithms: [custody.verificationKey.algorithm],
    trustRootIds: [custody.verificationKey.keyId],
  };
  async function verifyPreparation(prepared: PreparedEnvelope): Promise<void> {
    canonicalizeEnvelope(prepared);
    preparedEnvelopeSchema.parse(prepared);
    demand(prepared.packageBinding, "PACKAGE_BINDING_REQUIRED");
    canonicalizeEnvelope(prepared);
    await verifyRecoverySignature(
      prepared.signature,
      "preparation",
      unsignedPreparation(prepared),
      custody.verificationKey,
    );
  }
  async function signPreparation(
    input: PreparedEnvelopePayload,
    context: AuthenticatedRecoveryContext,
  ): Promise<PreparedEnvelope> {
    canonicalizeEnvelope(input);
    const payload = preparedEnvelopePayloadSchema.parse(input);
    demand(payload.packageBinding, "PACKAGE_BINDING_REQUIRED");
    canonicalizeEnvelope(payload);
    const accepted = await authority.resolveAccepted(
      payload.transactionId,
      context,
    );
    demand(accepted, "PREPARATION_NOT_ACCEPTED", 403);
    validateAcceptedPreparation(accepted, context);
    const expected = await buildPrimaryPackage(
      accepted,
      { archive, uploads, trustRootIds: capabilities.trustRootIds },
      "read",
    );
    await readBoundPrimaryPackage(archive, payload, expected);
    const current = await authority.resolveAccepted(
      payload.transactionId,
      context,
    );
    demand(current, "PREPARATION_NOT_ACCEPTED", 403);
    validateAcceptedPreparation(current, context);
    demand(
      sameAcceptedPreparation(accepted, current),
      "PREPARATION_CONTENT_MISMATCH",
    );
    const binding = {
      ...recoveryFormat,
      purpose: "preparation" as const,
      digest: await hashEnvelope("preparation", payload),
    };
    const signature = await custody.signPreparation(binding);
    const prepared = preparedEnvelopeSchema.parse({ ...payload, signature });
    await verifyPreparation(prepared);
    const after = await authority.resolveAccepted(
      payload.transactionId,
      context,
    );
    demand(after, "PREPARATION_NOT_ACCEPTED", 403);
    validateAcceptedPreparation(after, context);
    demand(
      sameAcceptedPreparation(current, after),
      "PREPARATION_CONTENT_MISMATCH",
    );
    return prepared;
  }
  async function signCommit(
    preparedInput: PreparedEnvelope,
    context: AuthenticatedRecoveryContext,
  ) {
    demand(
      ports?.commitAuthority,
      "RECOVERY_COMMIT_AUTHORITY_UNAVAILABLE",
      503,
    );
    canonicalizeEnvelope(preparedInput);
    const prepared = preparedEnvelopeSchema.parse(preparedInput);
    await verifyPreparation(prepared);
    const durable = await ports.commitAuthority.resolveCommitted(
      prepared.transactionId,
      context,
    );
    demand(durable, "RECOVERY_COMMIT_NOT_FOUND", 409);
    function validateCurrent(value: NonNullable<typeof durable>) {
      authenticatedRecoveryContextSchema.parse(value.context);
      demand(
        equalMetadata(value.context, context) &&
          equalMetadata(value.context.workspace, prepared.workspace),
        "RECOVERY_AUTHORITY_MISMATCH",
        403,
      );
      demand(
        Number.isSafeInteger(value.now) &&
          value.now >= context.serverTime &&
          context.actor.expiresAt > value.now &&
          context.grant.expiresAt > value.now,
        "EXPIRED_RECOVERY_AUTHORITY",
        403,
      );
      demand(
        equalMetadata(value.prepared, prepared),
        "RECOVERY_COMMIT_MISMATCH",
      );
      demand(
        Number.isSafeInteger(value.committedAt) &&
          value.committedAt >= prepared.createdAt &&
          value.committedAt <= value.now,
        "RECOVERY_COMMIT_TIME_MISMATCH",
      );
    }
    validateCurrent(durable);
    const core = await readBoundPrimaryPackage(
      archive,
      unsignedPreparation(prepared),
    );
    await verifyPackageArtifacts(archive, core);
    await readPreparationArtifacts(archive, prepared);
    const current = await ports.commitAuthority.resolveCommitted(
      prepared.transactionId,
      context,
    );
    demand(current, "RECOVERY_COMMIT_NOT_FOUND", 409);
    validateCurrent(current);
    demand(
      current.committedAt === durable.committedAt,
      "RECOVERY_COMMIT_MISMATCH",
    );
    const payload = commitCertificatePayloadSchema.parse({
      ...recoveryFormat,
      purpose: "commit",
      workspace: prepared.workspace,
      epochId: prepared.epochId,
      sequence: prepared.sequence,
      transactionId: prepared.transactionId,
      preparedDigest: await hashEnvelope(
        "preparation",
        unsignedPreparation(prepared),
      ),
      transactionDigest: await hashEnvelope(
        "transaction",
        unsignedPreparation(prepared),
      ),
      committedAt: durable.committedAt,
    });
    const signature = await custody.signCommit({
      ...recoveryFormat,
      purpose: "commit",
      digest: await hashEnvelope("commit", payload),
    });
    await verifyRecoverySignature(
      signature,
      "commit",
      payload,
      custody.verificationKey,
    );
    const certificate = commitCertificateSchema.parse({
      ...payload,
      signature,
    });
    canonicalizeEnvelope(certificate);
    const after = await ports.commitAuthority.resolveCommitted(
      prepared.transactionId,
      context,
    );
    demand(after, "RECOVERY_COMMIT_NOT_FOUND", 409);
    validateCurrent(after);
    demand(
      after.committedAt === durable.committedAt,
      "RECOVERY_COMMIT_MISMATCH",
    );
    return certificate;
  }
  return { capabilities, signPreparation, signCommit, verifyPreparation };
}
