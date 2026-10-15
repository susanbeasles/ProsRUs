import { parseCorePlanningInput } from "../../src/domain/core-operation-input";
import {
  packetPlan,
  claimBody,
  opportunityBody,
  present,
} from "./domain-preparation";
export function packetRequest() {
  const plan = packetPlan();
  const result = parseCorePlanningInput({
    operationId: "job-stack.packet.create.v1",
    input: {
      workspaceId: plan.workspace.workspaceId,
      requestKey: plan.requestKey,
      body: { opportunityId: opportunityBody.id, claimIds: [claimBody.id] },
    },
    allocation: {
      workspace: plan.workspace,
      actorId: plan.actorId,
      requestRootId: plan.requestRootId,
      businessTime: 1000,
      records: [
        {
          role: "packet",
          recordKind: "packet",
          entityId: "packet-1",
          lineageId: "lineage-packet-1",
          auditEventId: "audit-packet",
        },
        {
          role: "opportunity",
          recordKind: "opportunity",
          entityId: opportunityBody.id,
          lineageId: "lineage-opportunity-1",
          auditEventId: "audit-opportunity",
        },
      ],
    },
    read: {
      records: [
        { recordKind: "packet", entityId: "packet-1", state: "absent" },
        present("opportunity", opportunityBody.id, opportunityBody),
        present("claim", claimBody.id, claimBody),
      ],
      collections: [],
      sourceKeys: [],
      bindings: [
        {
          recordKind: "opportunity",
          entityId: opportunityBody.id,
          lineageId: "lineage-opportunity-1",
          versionId: "opportunity-version-1",
          heads: ["opportunity-version-1"],
          revision: 1,
          sourceVersionIds: [],
        },
        {
          recordKind: "claim",
          entityId: claimBody.id,
          lineageId: "lineage-claim-1",
          versionId: "claim-version-1",
          heads: ["claim-version-1"],
          revision: 1,
          sourceVersionIds: [],
        },
      ],
    },
    currentEvidence: {
      checkedAt: 1000,
      ownerInteraction: null,
      claims: [
        {
          claimId: claimBody.id,
          versionId: "claim-version-1",
          revision: 1,
          approvalId: "review-1",
          approvalRevision: 1,
          expiresAt: 2000,
          sourceVersionIds: [],
        },
      ],
      sourceArtifacts: [],
    },
  });
  if (result.operationId !== "job-stack.packet.create.v1")
    throw Error("FIXTURE");
  return result;
}
