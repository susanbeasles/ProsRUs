import { packetRequest } from "./core-operation";
export function archivedSourceRequest() {
  const base = packetRequest();
  const capture = {
    purpose: "profile-source",
    requestRootId: "root-original-upload",
    transactionId: "transaction-original-upload",
    uploadHandle: "upload-original",
    purposeDigest: "c".repeat(64),
  };
  const original = {
    artifactIndex: 0,
    digest: "a".repeat(64),
    sizeBytes: 123,
    mediaType: "application/octet-stream",
  };
  return {
    ...base,
    operationId: "job-stack.claim.add.v1",
    input: {
      workspaceId: base.input.workspaceId,
      requestKey: "new-source-claim",
      body: {
        field: "experience",
        text: "Built services",
        permitted: true,
        sourceIds: ["resume-original"],
      },
    },
    allocation: {
      ...base.allocation,
      records: [
        {
          role: "claim",
          recordKind: "claim",
          entityId: "new-claim",
          lineageId: "lineage-new-claim",
          auditEventId: "audit-new-claim",
        },
      ],
    },
    read: {
      records: [
        { recordKind: "claim", entityId: "new-claim", state: "absent" },
        {
          recordKind: "artifact",
          entityId: "resume-original",
          state: "absent",
        },
      ],
      bindings: [],
      collections: [],
      sourceKeys: [],
      archiveSources: [
        {
          format: "archived-original-source-v1",
          entityId: "resume-original",
          kind: "resume",
          lineageId: "lineage-original",
          versionId: "version-original",
          manifestDigest: "b".repeat(64),
          projectionBody:
            '{"type":"exact_original","original":{"sizeBytes":123,"fileName":"resume.pdf","mediaType":"application/pdf","format":null,"lastModified":null}}',
          original,
          capture: { ...capture },
        },
      ],
    },
    currentEvidence: {
      ...base.currentEvidence,
      claims: [],
      sourceArtifacts: [
        {
          entityId: "resume-original",
          versionId: "version-original",
          permissionId: "source-permission",
          permissionRevision: 1,
          expiresAt: 2000,
          ...original,
          capture: { ...capture },
        },
      ],
    },
  };
}
