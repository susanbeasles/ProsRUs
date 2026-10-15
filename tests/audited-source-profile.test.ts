import { expect, it } from "vitest";
import { planAuditedImport } from "../src/application/audited-legacy-import";
import {
  fixtureInputs,
  fixtureProfile,
  fixtureWorkspace,
} from "./fixtures/audited-profile-inputs";
it("plans an independent 137-role corpus using exact declared source roles", () => {
  const sources = fixtureInputs();
  const plan = planAuditedImport(
    {
      sources,
      workspace: fixtureWorkspace,
      seriesId: fixtureProfile.seriesId,
      observedAt: 100,
    },
    fixtureProfile,
  );
  expect(plan.records).toHaveLength(137);
  expect(plan.sources).toHaveLength(4);
  expect(plan.records[0]?.id).toBe("fixture_records_FXD001");
  expect(plan.records[0]?.body.raw.unknown).toEqual({ retain: true });
  expect(plan.sources[0]?.sourceReceipt.fixtureEvidence).toEqual({
    retainedUnknown: true,
  });
  expect(plan.receipt.mappingVersion).toBe("audited-profile-map-v2");
});

import {
  parseAuditedSourceProfile,
  auditedProfileDigest,
  auditedPlanDigest,
} from "../src/application/audited-source-profile";
import {
  fixtureSource,
  fixtureSupplementedInputs,
} from "./fixtures/audited-profile-inputs";
function plan(
  profile: unknown = fixtureProfile,
  sources = fixtureInputs(),
  observedAt = 100,
) {
  return planAuditedImport(
    {
      sources,
      workspace: fixtureWorkspace,
      seriesId: fixtureProfile.seriesId,
      observedAt,
    },
    profile,
  );
}
it("denies absent, malformed, duplicate and excessive profile input with a safe category", () => {
  const cases = [
    undefined,
    {},
    {
      ...fixtureProfile,
      sources: {
        ...fixtureProfile.sources,
        notes: fixtureProfile.sources.main,
      },
    },
    {
      ...fixtureProfile,
      sources: {
        ...fixtureProfile.sources,
        main: { label: "../fixture.json" },
      },
    },
    { ...fixtureProfile, extra: "unsupported" },
    {
      ...fixtureProfile,
      expectedCounts: {
        ...fixtureProfile.expectedCounts,
        digest_listings: 257,
      },
    },
    { ...fixtureProfile, identityMode: "legacy-v1" },
    { ...fixtureProfile, supplementAssociation: undefined },
  ];
  for (const value of cases)
    expect(() => parseAuditedSourceProfile(value)).toThrow(
      "AUDIT_PROFILE_INVALID",
    );
  expect(() =>
    planAuditedImport(
      {
        sources: fixtureInputs(),
        workspace: fixtureWorkspace,
        seriesId: fixtureProfile.seriesId,
        observedAt: 100,
      },
      undefined,
    ),
  ).toThrow("AUDIT_PROFILE_INVALID");
});
it("binds changed finite record allocation to a new profile and bundle digest", () => {
  const original = plan();
  const changed = plan({
    ...fixtureProfile,
    recordIds: { ...fixtureProfile.recordIds, recordPrefix: "fixture_other" },
  });
  expect(changed.receipt.bundleDigest).not.toBe(original.receipt.bundleDigest);
  expect(changed.receipt.profileDigest).toBe(
    auditedProfileDigest(
      parseAuditedSourceProfile({
        ...fixtureProfile,
        recordIds: {
          ...fixtureProfile.recordIds,
          recordPrefix: "fixture_other",
        },
      }),
    ),
  );
  expect(changed.sources[0]?.profileDigest).toBe(changed.receipt.profileDigest);
  expect(changed.records[0]?.body.import.profileDigest).toBe(
    changed.receipt.profileDigest,
  );
});
it("retains declared optional evidence and closed precedence without current authority", () => {
  const result = plan(fixtureProfile, fixtureSupplementedInputs());
  const target = result.records.find(
    (record) =>
      record.body.source.sourceId ===
      fixtureProfile.supplementAssociation.roleSourceId,
  );
  expect(result.sources).toHaveLength(5);
  expect(target?.body.display.status).toBe("pending");
  expect(target?.body.display.history).toBe("legacy_unversioned");
  expect(target?.body.display.protection).toBe("import_pending");
  expect(result.records[0]?.body.display.status).toBe("closed");
  expect(target?.body.relatedEvidence.at(-1)?.source).toBe(
    fixtureProfile.sources.recruiter_supplement.label,
  );
  expect(target?.body.raw.after_cutoff_outreach).toEqual({
    thread_id: "fixture-original-thread",
    sent_message_id: "fixture-outbound",
  });
});
it("rejects an altered association and selected target before planning", () => {
  expect(() =>
    plan(
      {
        ...fixtureProfile,
        supplementAssociation: {
          ...fixtureProfile.supplementAssociation,
          originalThreadId: "fixture-wrong-thread",
        },
      },
      fixtureSupplementedInputs(),
    ),
  ).toThrow("AUDIT_SUPPLEMENT_PROFILE");
  expect(() =>
    plan({
      ...fixtureProfile,
      workspace: {
        ...fixtureWorkspace,
        workspaceId: "fixture-other-workspace",
      },
    }),
  ).toThrow("AUDIT_PROFILE_TARGET");
});
it("hashes full canonical plans above 512 KiB and rejects an 8 MiB excess", () => {
  const aboveComposite = {
    retained: "x".repeat(600000),
    exact: "  Fixture\r\n",
  };
  expect(auditedPlanDigest(aboveComposite)).toBe(
    createHash("sha256")
      .update(canonicalJson(aboveComposite, 8388608))
      .digest("hex"),
  );
  expect(() => auditedPlanDigest({ retained: "x".repeat(8388608) })).toThrow(
    "AUDIT_PLAN_ENCODING_OR_SIZE",
  );
});
it("admits the file profile but denies its oversized runtime representation", () => {
  const padded = {
    ...fixtureProfile,
    supplementAssociation: {
      ...fixtureProfile.supplementAssociation,
      originalThreadId: "a".repeat(1024),
      messages: [
        { id: "b".repeat(1024), threadId: "c".repeat(1024) },
        { id: "d".repeat(1024), threadId: "e".repeat(1024) },
      ],
    },
  };
  expect(
    new TextEncoder().encode(JSON.stringify(padded)).length,
  ).toBeGreaterThan(5000);
  expect(() => parseAuditedSourceProfile(padded)).not.toThrow();
  expect(() => parseAuditedSourceProfile(padded, "runtime")).toThrow(
    "AUDIT_PROFILE_INVALID",
  );
});
import { createHash } from "node:crypto";
import { canonicalJson } from "../integration/shared-contract.mjs";

it("requires a complete unique declared order and binds substitutions", () => {
  for (const sourceOrder of [
    ["main", "outreach", "notes", "notes"],
    ["main", "outreach", "coordination", "notes"],
  ]) {
    expect(() =>
      parseAuditedSourceProfile({ ...fixtureProfile, sourceOrder }),
    ).toThrow("AUDIT_PROFILE_INVALID");
  }
  const ordered = parseAuditedSourceProfile(fixtureProfile);
  const reversed = parseAuditedSourceProfile({
    ...fixtureProfile,
    sourceOrder: [
      "notes",
      "coordination",
      "outreach",
      "main",
      "recruiter_supplement",
    ],
  });
  expect(auditedProfileDigest(reversed)).not.toBe(
    auditedProfileDigest(ordered),
  );
  expect(() => plan(reversed)).toThrow("AUDIT_SOURCE_ORDER");
  const reordered = plan(reversed, fixtureInputs().reverse());
  expect(reordered.sources.map((source) => source.name)).toEqual(
    fixtureInputs()
      .reverse()
      .map((source) => source.name),
  );
  expect(reordered.receipt.bundleDigest).not.toBe(plan().receipt.bundleDigest);
});
it("denies excessive aggregate evidence despite individually bounded raw inputs", () => {
  const profile = {
    ...fixtureProfile,
    expectedCounts: { ...fixtureProfile.expectedCounts, digest_listings: 152 },
  };
  const sources = fixtureInputs();
  const mainSource = sources[0];
  if (!mainSource) throw Error("FIXTURE");
  const main = JSON.parse(new TextDecoder().decode(mainSource.bytes));
  main.digest_listings.push(
    ...Array.from({ length: 33 }, (_, i) => ({
      id: "FXMORE" + i,
      company: "Fixture memory company",
      role: "Fixture memory role",
    })),
  );
  const ids = [
    ...main.direct_opportunities,
    ...main.digest_listings,
    ...main.excluded_already_engaged,
  ].map((role: { id: string }) => role.id);
  ids.push("FXPOST001", "FXPOST002");
  main.coordination_runs = [
    {
      as_of: "2020-02-02T00:00:00Z",
      updates: [
        {
          opportunity_ids: ids,
          status: "Fixture memory boundary",
          retainedPadding: "x".repeat(50000),
        },
      ],
    },
  ];
  sources[0] = fixtureSource(fixtureProfile.sources.main.label, main);
  expect(sources[0].bytes.length).toBeLessThan(524288);
  expect(() => plan(profile, sources)).toThrow("AUDIT_PLAN_ENCODING_OR_SIZE");
});

it("rejects duplicate and escaped-equivalent raw profile keys before schema parsing", () => {
  const raw = JSON.stringify(fixtureProfile);
  const variants = [
    '{"seriesId":"substituted",' + raw.slice(1),
    '{"\\u0073eriesId":"substituted",' + raw.slice(1),
    '{"seriesId":' +
      JSON.stringify(fixtureProfile.seriesId) +
      "," +
      raw.slice(1),
    raw.replace('"workspace":{', '"workspace":{"ownerId":"substituted",'),
    raw.replace('"workspace":{', '"workspace":{"\\u006fwnerId":"substituted",'),
  ];
  expect(parseAuditedSourceProfile(raw, "file")).toEqual(fixtureProfile);
  for (const text of variants) {
    for (const admission of ["file", "runtime"] as const) {
      expect(() => parseAuditedSourceProfile(text, admission)).toThrow(
        "AUDIT_PROFILE_INVALID",
      );
    }
  }
});
it("denies a fifth supplemental source whose exact declared target role is absent", () => {
  const roleSourceId = "NO_SUCH_FIXTURE_ROLE";
  const profile = {
    ...fixtureProfile,
    supplementAssociation: {
      ...fixtureProfile.supplementAssociation,
      roleSourceId,
    },
  };
  const sources = fixtureSupplementedInputs().map((source, index) =>
    index === 4
      ? {
          ...source,
          receipt: {
            ...source.receipt,
            supplementBinding: profile.supplementAssociation,
          },
        }
      : source,
  );
  expect(() =>
    planAuditedImport(
      {
        sources,
        workspace: fixtureWorkspace,
        seriesId: profile.seriesId,
        observedAt: 100,
      },
      profile,
    ),
  ).toThrow("AUDIT_SUPPLEMENT_JOIN");
});
