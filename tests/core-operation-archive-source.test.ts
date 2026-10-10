import { expect, it } from "vitest";
import { DomainError } from "../src/domain/model";
import { planCoreOperation } from "../src/domain/core-operation-plan";
import { archivedSourceRequest } from "./fixtures/core-archive-source";

it("uses an actual current archived-original source without synthesizing a legacy artifact", () => {
  const request = archivedSourceRequest(),
    plan = planCoreOperation(request);
  expect(
    plan.readSet.records.some(
      (r) => r.recordKind === "artifact" && r.state === "absent",
    ),
  ).toBe(true);
  expect(plan.candidates).toHaveLength(1);
  expect(plan.candidates[0]?.snapshot.recordKind).toBe("claim");
  expect(plan.candidates[0]?.sourceVersionIds).toContain("version-original");
  expect(plan.candidates[0]?.approval.state).toBe("draft");
});
it("denies missing current original-source permission", () => {
  const request = archivedSourceRequest();
  request.currentEvidence.sourceArtifacts = [];
  expect(() => planCoreOperation(request)).toThrowError(DomainError);
  expect(() => planCoreOperation(request)).toThrow(
    "CURRENT_SOURCE_PERMISSION_REQUIRED",
  );
});
it("denies an unrelated retained original upload-purpose tuple", () => {
  const request = archivedSourceRequest();
  const permission = request.currentEvidence.sourceArtifacts[0];
  if (!permission) throw Error("FIXTURE");
  permission.capture.purposeDigest = "d".repeat(64);
  expect(() => planCoreOperation(request)).toThrow(
    "CURRENT_SOURCE_PROVENANCE_MISMATCH",
  );
});
it("denies ambiguous duplicate archived-source identity", () => {
  const request = archivedSourceRequest();
  const original = request.read.archiveSources[0];
  if (!original) throw Error("FIXTURE");
  request.read.archiveSources.push({
    ...original,
    kind: "evidence",
    lineageId: "other-lineage",
  });
  expect(() => planCoreOperation(request)).toThrow();
});
it("denies expired source permission even when original bytes and shaped provenance are present", () => {
  const request = archivedSourceRequest();
  const permission = request.currentEvidence.sourceArtifacts[0];
  if (!permission) throw Error("FIXTURE");
  permission.expiresAt = 1000;
  expect(() => planCoreOperation(request)).toThrow(
    "CURRENT_SOURCE_PERMISSION_REQUIRED",
  );
});
it("denies a structured meeting-purpose source instead of reusing it as profile evidence", () => {
  const request = archivedSourceRequest();
  const source = request.read.archiveSources[0];
  if (!source) throw Error("FIXTURE");
  const raw = {
    ...request,
    read: {
      ...request.read,
      archiveSources: [
        {
          ...source,
          capture: { ...source.capture, purpose: "meeting-artifact" },
        },
      ],
    },
  };
  expect(() => planCoreOperation(raw)).toThrow();
});
