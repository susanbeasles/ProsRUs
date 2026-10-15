import { canonicalJson } from "../../integration/shared-contract.mjs";
import { demand } from "./model";
import { parseEnvelopeJson } from "./recovery-canonical";
import {
  parseDomainRecordSnapshot,
  type DomainRecordKind,
} from "./recovery-record";
import {
  presentGuard,
  type CoreObservation,
  type CurrentDomainEvidence,
} from "./core-operation-input";

export function currentRecord(
  read: CoreObservation,
  kind: DomainRecordKind,
  entityId: string,
) {
  const guard = presentGuard(read, kind, entityId);
  return parseDomainRecordSnapshot({
    formatVersion: 1,
    type: "domain_record",
    recordKind: kind,
    entityId,
    revision: guard.revision,
    updatedAt: guard.updatedAt,
    body: parseEnvelopeJson(guard.rawBody),
  });
}
export function committedBinding(
  read: CoreObservation,
  kind: DomainRecordKind,
  entityId: string,
) {
  const guard = presentGuard(read, kind, entityId);
  const binding = read.bindings.find(
    (b) => b.recordKind === kind && b.entityId === entityId,
  );
  demand(
    binding &&
      binding.revision === guard.revision &&
      binding.versionId !== null &&
      binding.heads.length === 1 &&
      binding.heads[0] === binding.versionId,
    "COMMITTED_DOMAIN_BINDING_REQUIRED",
  );
  return { ...binding, versionId: binding.versionId };
}
export function currentClaimEvidence(
  read: CoreObservation,
  evidence: CurrentDomainEvidence,
  claimId: string,
) {
  const snapshot = currentRecord(read, "claim", claimId);
  demand(snapshot.recordKind === "claim", "CLAIM_NOT_FOUND");
  const binding = committedBinding(read, "claim", claimId);
  const approval = evidence.claims.find((a) => a.claimId === claimId);
  demand(
    approval &&
      approval.versionId === binding.versionId &&
      approval.revision === snapshot.revision &&
      approval.expiresAt > evidence.checkedAt,
    "CURRENT_CLAIM_PERMISSION_REQUIRED",
  );
  demand(
    snapshot.body.permitted &&
      ["user_confirmed", "source_supported"].includes(snapshot.body.status),
    "CLAIM_NOT_PERMITTED",
  );
  const sources =
    snapshot.body.status === "source_supported"
      ? currentSourceArtifacts(read, evidence, snapshot.body.sourceIds)
      : [];
  demand(
    sources.every((s) => approval.sourceVersionIds.includes(s.versionId)),
    "CURRENT_CLAIM_SOURCE_MISMATCH",
  );
  return { claim: snapshot.body, binding, approval, sources };
}
export function currentSourceArtifacts(
  read: CoreObservation,
  evidence: CurrentDomainEvidence,
  sourceIds: readonly string[],
) {
  demand(sourceIds.length > 0, "MISSING_EVIDENCE");
  return sourceIds.map((entityId) => {
    const archive = read.archiveSources?.find((a) => a.entityId === entityId);
    const source = evidence.sourceArtifacts.find(
      (s) => s.entityId === entityId,
    );
    if (archive) {
      demand(
        source &&
          source.versionId === archive.versionId &&
          source.expiresAt > evidence.checkedAt,
        "CURRENT_SOURCE_PERMISSION_REQUIRED",
      );
      demand(
        source.capture &&
          canonicalJson(source.capture) === canonicalJson(archive.capture),
        "CURRENT_SOURCE_PROVENANCE_MISMATCH",
      );
      demand(
        source.artifactIndex === 0 &&
          source.digest === archive.original.digest &&
          source.sizeBytes === archive.original.sizeBytes &&
          source.mediaType === archive.original.mediaType,
        "CURRENT_SOURCE_ARTIFACT_MISMATCH",
      );
    } else {
      const record = currentRecord(read, "artifact", entityId);
      demand(
        record.recordKind === "artifact" && record.body.status === "available",
        "SOURCE_NOT_AVAILABLE",
      );
      const binding = committedBinding(read, "artifact", entityId);
      demand(
        source &&
          source.versionId === binding.versionId &&
          source.expiresAt > evidence.checkedAt,
        "CURRENT_SOURCE_PERMISSION_REQUIRED",
      );
    }
    demand(source, "CURRENT_SOURCE_PERMISSION_REQUIRED");
    return source;
  });
}
export function claimEvidenceText(
  values: readonly ReturnType<typeof currentClaimEvidence>[],
) {
  return canonicalJson({
    format: "current-claim-evidence-v1",
    claims: values.map((v) => ({
      claimId: v.claim.id,
      versionId: v.binding.versionId,
      revision: v.binding.revision,
      approval: v.approval,
      sources: v.sources,
    })),
  });
}
