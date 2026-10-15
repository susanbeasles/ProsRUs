import { createHash } from "node:crypto";
import { canonicalJson } from "../../integration/shared-contract.mjs";
import { planAuditedImport } from "../../src/application/audited-legacy-import";
import {
  auditedPlanDigest,
  parseAuditedSourceProfile,
} from "../../src/application/audited-source-profile";
import {
  fixtureInputs,
  fixtureProfile,
  fixtureWorkspace,
} from "./audited-profile-inputs";

export const fixtureLegacyInput = {
  sources: fixtureInputs(),
  workspace: fixtureWorkspace,
  seriesId: fixtureProfile.seriesId,
  observedAt: 100,
};
export function fixtureLegacyBinding(
  input: unknown,
  suppliedProfile: unknown = fixtureProfile,
) {
  const profile = parseAuditedSourceProfile(suppliedProfile);
  if (profile.identityMode !== "profile-v2")
    throw Error("fixture-v2-profile-required");
  const v2 = planAuditedImport(input, profile);
  const mappingVersion = "audited-legacy-map-v1" as const;
  const bundleDigest = createHash("sha256")
    .update(
      canonicalJson({
        mappingVersion,
        seriesId: v2.seriesId,
        workspace: v2.workspace,
        sources: v2.receipt.sourceReceipts,
      }),
    )
    .digest("hex");
  function originalIdentity(value: object, format: string) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "profileDigest")
        .map(([key, retained]) => [
          key,
          key === "format"
            ? format
            : key === "mappingVersion"
              ? mappingVersion
              : key === "bundleDigest"
                ? bundleDigest
                : retained,
        ]),
    );
  }
  const plan = {
    workspace: v2.workspace,
    seriesId: v2.seriesId,
    records: v2.records.map((record) => ({
      ...record,
      body: {
        ...record.body,
        format: "audited-legacy-role-v1",
        source: { ...record.body.source, bundleDigest },
        import: { observedAt: record.body.import.observedAt, mappingVersion },
      },
    })),
    sources: v2.sources.map((source) =>
      originalIdentity(source, "audited-json-input-v1"),
    ),
    receipt: originalIdentity(v2.receipt, "audited-legacy-import-v1"),
  };
  const legacyProfile = parseAuditedSourceProfile({
    ...profile,
    identityMode: "legacy-v1",
    legacyBinding: {
      bundleDigest,
      importObservedAt: v2.receipt.importObservedAt,
      planSha256: auditedPlanDigest(plan),
    },
  });

  return { plan, profile: legacyProfile };
}
const fixture = fixtureLegacyBinding(fixtureLegacyInput);
export const fixtureLegacyPlan = fixture.plan;
export const fixtureLegacyProfile = fixture.profile;
