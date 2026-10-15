// The record detail moved from dashboard/pages/Opportunities (list + detail in one component) to the
// presentational features/opportunities/ObservationDetail; the assertions below are unchanged.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  ObservationDetail as Opportunities,
  type ObservationDetailProps,
} from "../dashboard/features/opportunities/ObservationDetail";
import type { ReadRecord } from "../dashboard/lib/api";
function props(current: ReadRecord): ObservationDetailProps {
  return {
    current,
    select: () => {},
    history: false,
    versions: [],
    version: null,
    selectedVersion: null,
    protection: null,
    selectVersion: () => {},
  };
}
for (const bodyStatus of ["invalid_json", "too_large"] as const) {
  it(`renders exact identity and ${bodyStatus} reason instead of usable empty content`, () => {
    const row: ReadRecord = {
      origin: "domain_record",
      history: "legacy_unversioned",
      kind: "opportunity",
      entityId: "synthetic_record",
      revision: "7",
      updatedAt: 1000,
      body: null,
      bodyStatus,
      provenance: null,
    };
    const html = renderToStaticMarkup(createElement(Opportunities, props(row)));
    expect(html).toContain("Record body unavailable");
    expect(html).toContain(
      bodyStatus === "invalid_json"
        ? "Stored content is not valid JSON."
        : "Stored content exceeds the read size limit.",
    );
    expect(html).toContain("synthetic_record");
    expect(html).toContain("Row revision: 7");
    expect(html).not.toContain("Unknown");
    expect(html).not.toContain("Original role fields");
    expect(html).not.toContain("<pre>null</pre>");
  });
}
const versioned: ReadRecord = {
  origin: "generic_archive",
  history: "versioned",
  kind: "opportunity",
  entityId: "archive_record",
  revision: null,
  updatedAt: 1000,
  body: { company: "Synthetic", role: "Role" },
  bodyStatus: "available",
  provenance: null,
  lineageId: "lineage",
  versionId: "current_version",
  manifestDigest: "a".repeat(64),
};
it("presents the exact selected version protection as distinct truthful states", () => {
  const p = {
    ...props(versioned),
    history: true,
    selectedVersion: "past_version",
    version: { versionId: "past_version" },
    protection: {
      status: "available" as const,
      view: {
        versionId: "past_version",
        documentApproval: "approved" as const,
        primarySave: "journal_complete" as const,
        replication: "protection_pending" as const,
        integrity: "unchecked" as const,
        retentionEvidence: [],
        lastCheckedAt: null,
        freshnessKnown: false,
      },
    },
  };
  const html = renderToStaticMarkup(createElement(Opportunities, p));
  expect(html).toContain("Protection for past_version");
  for (const value of [
    "Primary save: journal complete",
    "Replication: protection pending",
    "Integrity: unchecked",
    "Freshness: unknown",
    "Last checked: never",
    "No retention evidence",
    "Historical document approval: approved",
  ])
    expect(html).toContain(value);
  expect(html).toContain("No current pursuit or action approval is inferred");
});
it("never presents cached protection from another selected version", () => {
  const html = renderToStaticMarkup(
    createElement(Opportunities, {
      ...props(versioned),
      history: true,
      selectedVersion: "past_version",
      protection: {
        status: "available",
        view: {
          versionId: "current_version",
          documentApproval: "draft",
          primarySave: "journal_complete",
          replication: "protection_pending",
          integrity: "unchecked",
          retentionEvidence: [],
          lastCheckedAt: null,
          freshnessKnown: false,
        },
      },
    }),
  );
  expect(html).toContain("Protection unavailable or denied for past_version");
  expect(html).not.toContain("Primary save:");
});
