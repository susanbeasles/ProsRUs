import {
  fixtureProfile,
  fixtureSupplementedInputs,
  fixtureSource,
} from "./audited-profile-inputs";
import { parseAuditedSourceProfile } from "../../src/application/audited-source-profile";
export function pipelineFixture(
  owner = "pipeline_owner",
  empty = false,
  count = 154,
  largeDisplay = false,
) {
  const sources = empty ? fixtureSupplementedInputs().slice(0, 4) : fixtureSupplementedInputs();
  const original = sources[0];
  if (!original) throw Error("Synthetic fixture requires a main source");
  const main = JSON.parse(new TextDecoder().decode(original.bytes));
  main.direct_opportunities = main.direct_opportunities.map(
    (row: Record<string, unknown>, i: number) => {
      const { after_cutoff_outreach: _prior, ...rest } = row;
      void _prior;
      return {
        ...rest,
        ...(i < 6 && !empty
          ? {
              after_cutoff_outreach: {
                thread_id: "fixture-original-thread",
                sent_message_id: "synthetic",
              },
            }
          : {}),
        ...(largeDisplay && i === 0
          ? { company: "Oversized".repeat(400) }
          : {}),
      };
    },
  );
  if (empty) main.excluded_already_engaged = [];
  const digestCount = count - 12 - (empty ? 0 : 4) - 2;
  main.digest_listings = Array.from({ length: digestCount }, (_, i) => ({
    id: "FXL" + String(i + 1).padStart(3, "0"),
    company: "Synthetic company " + i,
    role: "Synthetic role " + i,
  }));
  sources[0] = fixtureSource(original.name, main);
  const workspace = { ownerId: owner, workspaceId: owner + "_workspace" };
  const profile = parseAuditedSourceProfile({
    ...fixtureProfile,
    workspace,
    seriesId: owner + "_series",
    expectedCounts: {
      ...fixtureProfile.expectedCounts,
      digest_listings: digestCount,
      excluded_already_engaged: empty ? 0 : 4,
    },
  });
  return { sources, workspace, profile };
}
