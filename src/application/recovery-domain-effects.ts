import { validateArchivedOriginalSource } from "./recovery-archive-source";
import {
  isOriginalRole,
  validateCommittedOriginal,
  validateOriginalDescriptor,
} from "./recovery-domain-original";
import { demand } from "../domain/model";
import {
  domainPlanDigest,
  domainRequestDigest,
  parseDomainPlan,
  validateCandidateVersions,
} from "../domain/recovery-domain-plan";
import { recoveryKindForRecord } from "../domain/recovery-record";
import { canonicalizeEnvelope } from "../domain/recovery-canonical";
import type {
  PreparedEnvelopePayload,
  VersionManifest,
} from "../domain/recovery";
import { equalMetadata } from "../storage/recovery-metadata";
import { artifactDigest } from "../storage/recovery-streams";

/** Signed values are checked for semantic consistency here. This does not authenticate
 * a caller: only host acceptance plus signer reconstruction may authorize this sink. */
export async function validateDomainEffects(
  prepared: PreparedEnvelopePayload,
  resolveCommitted?: (versionId: string) => Promise<VersionManifest | null>,
): Promise<void> {
  const effects = prepared.domainEffects;
  if (!effects) return;
  const plan = parseDomainPlan(effects.plan);
  validateCandidateVersions(plan, effects.candidateVersions);
  demand(
    effects.planDigest === (await domainPlanDigest(plan)),
    "DOMAIN_PLAN_DIGEST_MISMATCH",
  );
  demand(
    prepared.requestDigest === (await domainRequestDigest(plan)) &&
      prepared.requestKey === plan.requestKey,
    "DOMAIN_REQUEST_DIGEST_MISMATCH",
  );
  demand(
    equalMetadata(prepared.workspace, plan.workspace) &&
      prepared.actorId === plan.actorId,
    "DOMAIN_AUTHORITY_MISMATCH",
  );
  demand(
    prepared.events.length === 0 &&
      prepared.versions.length === plan.candidates.length,
    "DOMAIN_EFFECT_BIJECTION_MISMATCH",
  );
  for (const source of plan.readSet.archiveSources ?? []) {
    const manifest = await resolveCommitted?.(source.versionId);
    demand(manifest, "ARCHIVE_SOURCE_MANIFEST_MISSING");
    await validateArchivedOriginalSource(source, manifest);
  }
  for (const candidate of plan.candidates) {
    const assignment = effects.candidateVersions.find(
      (v) => v.role === candidate.role,
    );
    const manifest = prepared.versions.find(
      (v) => v.versionId === assignment?.versionId,
    );
    demand(
      manifest &&
        manifest.lineageId === candidate.lineageId &&
        manifest.entityId === candidate.snapshot.entityId &&
        manifest.kind ===
          recoveryKindForRecord[candidate.snapshot.recordKind] &&
        !manifest.branchRequested &&
        equalMetadata(manifest.recordSnapshot, candidate.snapshot) &&
        equalMetadata(manifest.parentVersionIds, candidate.parentVersionIds) &&
        equalMetadata(manifest.sourceVersionIds, candidate.sourceVersionIds) &&
        equalMetadata(manifest.approval, candidate.approval),
      "DOMAIN_CANDIDATE_MISMATCH",
    );
    demand(
      equalMetadata(
        manifest.generationRecipe,
        candidate.observation
          ? {
              templateId: null,
              rendererId: "legacy-observation-v1",
              modelId: null,
              permittedInputVersionIds: [],
              parameters: candidate.observation,
            }
          : null,
      ),
      "DOMAIN_BASELINE_PROVENANCE_MISMATCH",
    );
    demand(
      manifest.artifacts.length === candidate.artifacts.length + 1,
      "DOMAIN_ARTIFACT_MISMATCH",
    );
    const snapshot = manifest.artifacts[0];
    const bytes = canonicalizeEnvelope(candidate.snapshot);
    demand(
      snapshot?.digest === artifactDigest(bytes) &&
        snapshot.sizeBytes === bytes.length &&
        snapshot.mediaType === "application/json",
      "DOMAIN_SNAPSHOT_ARTIFACT_MISMATCH",
    );
    for (const [index, artifact] of candidate.artifacts.entries()) {
      const descriptor = manifest.artifacts[index + 1];
      demand(descriptor, "DOMAIN_ARTIFACT_MISMATCH");
      const source = artifact.source;
      if (source.type === "utf8" || source.type === "legacy_body") {
        const guard =
          source.type === "legacy_body"
            ? plan.readSet.records.find(
                (r) =>
                  r.recordKind === source.recordKind &&
                  r.entityId === source.entityId,
              )
            : null;
        const raw =
          source.type === "utf8"
            ? source.text
            : guard?.state === "present"
              ? guard.rawBody
              : null;
        demand(raw !== null, "DOMAIN_RECORD_GUARD_REQUIRED");
        const bytes = new TextEncoder().encode(raw);
        demand(
          descriptor.digest === artifactDigest(bytes) &&
            descriptor.sizeBytes === bytes.length &&
            descriptor.mediaType ===
              (source.type === "utf8" ? source.mediaType : "application/json"),
          "DOMAIN_ARTIFACT_MISMATCH",
        );
      } else if (source.type === "upload")
        demand(
          descriptor.digest === source.digest &&
            descriptor.sizeBytes === source.sizeBytes &&
            descriptor.mediaType === source.mediaType,
          "DOMAIN_ARTIFACT_MISMATCH",
        );
      else {
        const committed = await resolveCommitted?.(source.versionId);
        demand(
          committed &&
            equalMetadata(
              committed.artifacts[source.artifactIndex],
              descriptor,
            ),
          "DOMAIN_COMMITTED_ARTIFACT_MISMATCH",
        );
        if (isOriginalRole(candidate, artifact.role))
          validateCommittedOriginal(committed, source.artifactIndex);
      }
    }
    validateOriginalDescriptor(candidate, manifest.artifacts);
  }
  const result = effects.candidateVersions.find(
    (v) => v.role === plan.resultRecord.candidateRole,
  );
  demand(
    result?.versionId === prepared.result.versionId,
    "DOMAIN_RESULT_MISMATCH",
  );
}
