import { expect, it } from "vitest";
import { assessFit, discoveryKey } from "../src/domain/rules";
import { rankListing } from "../src/domain/ranking";
import { initialSettings, settingsSchema } from "../src/domain/model";
import { selectCoreReads } from "../src/domain/core-operation-reads";
import { packetRequest } from "./fixtures/core-operation";
import { opportunityBody } from "./fixtures/domain-preparation";
const terms = {
  employment: "full_time" as const,
  baseUsd: 319000,
  hourlyUsd: null,
  remote: true,
  match401k: true,
  zeroPremium: true,
  affordableCare: true,
};
import { targeting } from "./fixtures/targeting";
it("keeps an unconfigured known opportunity researching and ranking unknown", () => {
  expect(assessFit(terms).status).toBe("researching");
  expect(
    rankListing("AI async staff", "Principal", terms.baseUsd),
  ).toMatchObject({
    technicalScope: "unknown",
    aiAlignment: "unknown",
    meetingLoad: "unknown",
    compensation: "unknown",
  });
  expect(discoveryKey(new Date("2026-01-01T18:00:00Z"))).toBeNull();
});
it("uses explicit independent floors, required facts and literal research terms", () => {
  expect(assessFit({ ...terms, baseUsd: 139999 }, targeting).status).toBe(
    "ineligible",
  );
  expect(
    assessFit(
      { ...terms, baseUsd: 150000, match401k: null, zeroPremium: null },
      targeting,
    ).status,
  ).toBe("qualified");
  expect(assessFit({ ...terms, baseUsd: null }, targeting).status).toBe(
    "researching",
  );
  expect(
    rankListing(
      "Computational systems, quiet time",
      "Senior engineer",
      220000,
      targeting,
    ),
  ).toMatchObject({
    technicalScope: "aligned",
    aiAlignment: "aligned",
    meetingLoad: "potentially_aligned",
    compensation: "target",
  });
});
it("preserves historical absent optional settings and reads only current main settings for assessment", () => {
  expect(settingsSchema.parse(initialSettings)).not.toHaveProperty(
    "targetingProfile",
  );
  const base = packetRequest();
  const request = {
    operationId: "job-stack.opportunity.capture.v1" as const,
    input: {
      workspaceId: base.input.workspaceId,
      requestKey: "fixture-capture",
      body: {
        company: opportunityBody.company,
        role: opportunityBody.role,
        sourceUrl: opportunityBody.sourceUrl,
        description: opportunityBody.description,
        terms: opportunityBody.terms,
      },
    },
  };
  const allocation = {
    ...base.allocation,
    records: [
      {
        role: "opportunity",
        recordKind: "opportunity" as const,
        entityId: "fixture-opportunity",
        lineageId: "fixture-lineage",
        auditEventId: "fixture-audit",
      },
    ],
  };
  expect(selectCoreReads(request, allocation).records).toContainEqual({
    recordKind: "settings",
    entityId: "main",
  });
});
