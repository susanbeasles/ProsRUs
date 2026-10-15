import { baselinePlan, present, snapshot } from "./domain-preparation";
import { parseDomainRecordSnapshot } from "../../src/domain/recovery-record";

export const originalPdf = new TextEncoder().encode(
  "%PDF-1.7\nExact legacy original bytes\n%%EOF\n",
);
export function artifactBaselinePlan() {
  const plan = structuredClone(baselinePlan());
  const body = {
    id: "artifact-legacy",
    name: "legacy.pdf",
    key: "owner/artifacts/legacy.pdf",
    flags: [],
    facts: [],
    status: "available" as const,
    createdAt: 90,
  };
  const candidate = plan.candidates[0];
  if (!candidate) throw Error("FIXTURE");
  candidate.role = "artifact";
  candidate.lineageId = "lineage-artifact-legacy";
  candidate.snapshot = parseDomainRecordSnapshot(
    snapshot("artifact", body.id, 7, body, 90),
  );
  candidate.artifacts = [
    {
      role: "legacy-json",
      source: {
        type: "legacy_body",
        recordKind: "artifact",
        entityId: body.id,
      },
    },
  ];
  candidate.observation = {
    kind: "legacy_baseline",
    originalArtifact: "missing",
    originalLocator: body.key,
    approvalProvenance: "none",
  };
  Object.assign(plan, {
    readSet: {
      records: [present("artifact", body.id, body, 7, 90)],
      collections: [],
      sourceKeys: [],
    },
    resultRecord: {
      candidateRole: "artifact",
      recordKind: "artifact",
      entityId: body.id,
      revision: 7,
    },
    requestRootId: "root-original",
    requestKey: "request-original",
  });
  return plan;
}
