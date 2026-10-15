import { expect, it } from "vitest";
import { planAuditedImport } from "../src/application/audited-legacy-import";
import { parseAuditedSourceProfile } from "../src/application/audited-source-profile";
import {
  fixtureLegacyInput,
  fixtureLegacyPlan,
  fixtureLegacyProfile,
} from "./fixtures/audited-legacy-profile";

it("preserves independently synthetic original v1 full-plan arrays/body/time bytes", () => {
  const actual = planAuditedImport(fixtureLegacyInput, fixtureLegacyProfile);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(fixtureLegacyPlan));
  expect(actual.receipt.importObservedAt).toBe(100);
  expect(
    actual.sources.every((source) => !Object.hasOwn(source, "profileDigest")),
  ).toBe(true);
});
it("denies legacy clock, bundle, plan, prefix, receipt and order substitutions", () => {
  const binding =
    fixtureLegacyProfile.identityMode === "legacy-v1"
      ? fixtureLegacyProfile.legacyBinding
      : undefined;
  if (!binding) throw Error("missing-legacy-fixture-binding");
  const changedReceipt = fixtureLegacyInput.sources.map((source, index) =>
    index
      ? source
      : { ...source, receipt: { ...source.receipt, changedEvidence: true } },
  );
  const changedOrder = parseAuditedSourceProfile({
    ...fixtureLegacyProfile,
    sourceOrder: [
      "outreach",
      "main",
      "coordination",
      "notes",
      "recruiter_supplement",
    ],
  });
  const cases: [unknown, unknown][] = [
    [{ ...fixtureLegacyInput, observedAt: 999 }, fixtureLegacyProfile],
    [
      fixtureLegacyInput,
      {
        ...fixtureLegacyProfile,
        legacyBinding: { ...binding, bundleDigest: "0".repeat(64) },
      },
    ],
    [
      fixtureLegacyInput,
      {
        ...fixtureLegacyProfile,
        legacyBinding: { ...binding, planSha256: "0".repeat(64) },
      },
    ],
    [
      fixtureLegacyInput,
      {
        ...fixtureLegacyProfile,
        recordIds: {
          ...fixtureLegacyProfile.recordIds,
          recordPrefix: "changed_fixture",
        },
      },
    ],
    [{ ...fixtureLegacyInput, sources: changedReceipt }, fixtureLegacyProfile],
    [
      {
        ...fixtureLegacyInput,
        sources: [
          fixtureLegacyInput.sources[1],
          fixtureLegacyInput.sources[0],
          ...fixtureLegacyInput.sources.slice(2),
        ],
      },
      changedOrder,
    ],
  ];
  for (const [input, profile] of cases)
    expect(() => planAuditedImport(input, profile)).toThrow(
      "AUDIT_LEGACY_BINDING",
    );
});
