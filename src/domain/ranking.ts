import {
  targetingProfileSchema,
  type TargetingProfile,
} from "./targeting-profile";
export function rankListing(
  description: string,
  role: string,
  baseUsd: number | null,
  suppliedTargeting?: TargetingProfile,
) {
  const targeting =
    suppliedTargeting === undefined
      ? undefined
      : targetingProfileSchema.parse(suppliedTargeting);
  const value = `${role} ${description}`.toLowerCase();
  const signal = (terms: readonly string[] | undefined) =>
    terms?.some((term) => value.includes(term.toLowerCase())) ?? false;
  return {
    technicalScope: signal(targeting?.technicalScopeTerms)
      ? "aligned"
      : "unknown",
    aiAlignment: signal(targeting?.aiAlignmentTerms) ? "aligned" : "unknown",
    meetingLoad: signal(targeting?.meetingLoadTerms)
      ? "potentially_aligned"
      : "unknown",
    compensation:
      targeting === undefined || baseUsd === null
        ? "unknown"
        : baseUsd >= targeting.targetBaseLowUsd
          ? "target"
          : baseUsd >= targeting.baseFloorUsd
            ? "floor"
            : "below_floor",
    rationale:
      targeting === undefined
        ? "Targeting profile is unconfigured"
        : "Keyword signals guide research; they do not verify employer promises.",
  };
}
