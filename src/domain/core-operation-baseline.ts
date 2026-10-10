import { createHash } from "node:crypto";
import { canonicalJson } from "../../integration/shared-contract.mjs";
import { demand } from "./model";
import { parseEnvelopeJson } from "./recovery-canonical";
import {
  parseDomainPlan,
  recordIdentity,
  type DomainPlan,
} from "./recovery-domain-plan";
import { parseDomainRecoverySnapshot } from "./recovery-record";
import {
  coreInputDigest,
  type CorePlanningInput,
} from "./core-operation-input";

/** The baseline branch of the one core planner. It cannot mutate business rows,
 * approve content, replace the public key, or invent an unobserved original. */
export function planObservedBaseline(
  request: CorePlanningInput,
  sourceDigest: string,
): DomainPlan {
  const baseline = request.baseline;
  demand(
    baseline && baseline.requestKey !== request.input.requestKey,
    "INTERNAL_BASELINE_KEY_REQUIRED",
  );
  const selected = request.read.bindings
    .filter((b) => b.versionId === null)
    .sort((a, b) => (recordIdentity(a) < recordIdentity(b) ? -1 : 1));
  demand(
    selected.length > 0 && selected.length <= 32,
    "BASELINE_NOT_REQUIRED_OR_TOO_LARGE",
  );
  const candidates: DomainPlan["candidates"] = selected.map(
    (binding, index) => {
      const guard = request.read.records.find(
        (r) => recordIdentity(r) === recordIdentity(binding),
      );
      demand(
        guard?.state === "present" &&
          guard.revision === binding.revision &&
          binding.heads.length === 0,
        "BASELINE_OBSERVATION_MISMATCH",
      );
      const body = parseEnvelopeJson(guard.rawBody),
        fields = {
          formatVersion: 1,
          recordKind: guard.recordKind,
          entityId: guard.entityId,
          revision: guard.revision,
          updatedAt: guard.updatedAt,
          body,
        };
      let snapshot;
      try {
        snapshot = parseDomainRecoverySnapshot({
          ...fields,
          type: "domain_record",
        });
      } catch {
        snapshot = parseDomainRecoverySnapshot({
          ...fields,
          type: "legacy_record_quarantine",
          reason: "incomplete_legacy_claim",
        });
      }
      const artifacts: DomainPlan["candidates"][number]["artifacts"] = [
        {
          role: "raw-body",
          source: {
            type: "legacy_body",
            recordKind: guard.recordKind,
            entityId: guard.entityId,
          },
        },
      ];
      const migration = baseline.migrations.find(
        (m) => recordIdentity(m) === recordIdentity(binding),
      );
      if (migration)
        artifacts.push({
          role: "migration-baseline",
          source: {
            type: "utf8",
            mediaType: "application/json",
            text: canonicalJson({
              format: "migration-baseline-provenance-v1",
              ...migration,
            }),
          },
        });
      const locator =
        snapshot.type === "domain_record" && snapshot.recordKind === "artifact"
          ? snapshot.body.key
          : snapshot.type === "domain_record" &&
              snapshot.recordKind === "packet"
            ? snapshot.body.artifactKey
            : null;
      const resolution = baseline.originals.find(
        (o) => recordIdentity(o) === recordIdentity(binding),
      );
      const sourceVersionIds: string[] = (
        request.read.archiveSources ?? []
      ).map((a) => a.versionId);
      let observation: NonNullable<
        DomainPlan["candidates"][number]["observation"]
      > = {
        kind: "legacy_baseline",
        originalArtifact: "not_applicable",
        originalLocator: null,
        approvalProvenance:
          guard.recordKind === "claim" ? "inert_observed" : "none",
      };
      if (locator !== null) {
        demand(
          resolution &&
            resolution.locator === locator &&
            resolution.recordRevision === guard.revision &&
            resolution.rawBodyDigest ===
              createHash("sha256").update(guard.rawBody).digest("hex"),
          "BASELINE_ORIGINAL_CORRESPONDENCE_REQUIRED",
        );
        demand(
          resolution.state !== "unavailable",
          "BASELINE_ORIGINAL_UNAVAILABLE",
        );
        if (resolution.state === "missing")
          observation = {
            ...observation,
            originalArtifact: "missing",
            originalLocator: locator,
          };
        else {
          demand(
            resolution.source.type === "committed" ||
              resolution.source.type === "upload",
            "DOMAIN_ORIGINAL_SOURCE_REQUIRED",
          );
          if (resolution.source.type === "committed")
            sourceVersionIds.push(resolution.source.versionId);
          artifacts.push({ role: "original-file", source: resolution.source });
          artifacts.push({
            role: "original-resolution",
            source: {
              type: "utf8",
              mediaType: "application/json",
              text: canonicalJson({
                format: "baseline-original-resolution-v1",
                ...resolution,
              }),
            },
          });
          observation = {
            ...observation,
            originalArtifact: "observed",
            originalLocator: locator,
            original: {
              artifactRole: "original-file",
              digest: resolution.digest,
              sizeBytes: resolution.sizeBytes,
              mediaType: resolution.mediaType,
            },
          };
        }
      } else demand(!resolution, "UNSELECTED_BASELINE_ORIGINAL");
      return {
        role: `baseline-${index}`,
        lineageId: binding.lineageId,
        snapshot,
        parentVersionIds: [],
        sourceVersionIds,
        artifacts,
        approval: { state: "unverified", evidenceVersionIds: [] },
        observation,
      };
    },
  );
  const identities = new Set(selected.map(recordIdentity));
  demand(
    baseline.originals.every((o) => identities.has(recordIdentity(o))) &&
      baseline.migrations.every((m) => identities.has(recordIdentity(m))) &&
      new Set(baseline.originals.map(recordIdentity)).size ===
        baseline.originals.length &&
      new Set(baseline.migrations.map(recordIdentity)).size ===
        baseline.migrations.length,
    "UNSELECTED_BASELINE_EVIDENCE",
  );
  const first = candidates[0];
  demand(first, "BASELINE_NOT_REQUIRED_OR_TOO_LARGE");
  return parseDomainPlan({
    format: "domain-plan-v1",
    phase: "baseline-archive-v1",
    operationId: request.operationId,
    inputDigest: coreInputDigest(request),
    planner: { version: 1, sourceDigest },
    workspace: request.allocation.workspace,
    actorId: request.allocation.actorId,
    requestRootId: request.allocation.requestRootId,
    requestKey: baseline.requestKey,
    readSet: {
      records: request.read.records,
      collections: request.read.collections,
      sourceKeys: request.read.sourceKeys,
      ...(request.read.archiveSources
        ? { archiveSources: request.read.archiveSources }
        : {}),
    },
    candidates,
    mutations: [],
    sourceKeys: [],
    audit: [],
    resultRecord: {
      candidateRole: first.role,
      recordKind: first.snapshot.recordKind,
      entityId: first.snapshot.entityId,
      revision: first.snapshot.revision,
    },
  });
}
