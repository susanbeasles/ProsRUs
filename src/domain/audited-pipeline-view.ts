import type { CheckedAuditedSourceProfile } from "../application/audited-source-profile";
import { z } from "zod";
export const rawObject = z.record(z.string(), z.json());
export type RawObject = z.infer<typeof rawObject>;
export type Observation = {
  source: string;
  pointer: string;
  basis: string;
  raw: RawObject;
  observedAt: string | null;
};
const text = (value: unknown) => (typeof value === "string" ? value : null);
/** Dated observations only; these labels never become operational states. */
export function auditedPipelineView(
  raw: RawObject,
  bucket: string,
  evidence: readonly Observation[],
  cutoff: string | null,
  profile: CheckedAuditedSourceProfile,
) {
  const supplement = evidence.find(
    (e) => e.source === profile.sources.recruiter_supplement?.label,
  );
  const closed = evidence.find((e) => e.raw.status === "closed");
  const booked = evidence.find(
    (e) => e.raw.event && typeof e.raw.event === "object",
  );
  const cancellation = evidence.find(
    (e) => e.raw.calendar_cancellation_verified === false,
  );
  const application = evidence.find(
    (e) =>
      e.raw.status ===
      "opening confirmed; application required before scheduling",
  );
  const note = evidence.find((e) => e.source === profile.sources.notes.label);
  const outreach =
    raw.after_cutoff_outreach && typeof raw.after_cutoff_outreach === "object";
  const existing = bucket === "excluded_already_engaged";
  const status = closed
    ? "closed"
    : supplement
      ? "pending"
      : cancellation || application || (existing && !note)
        ? "pending"
        : booked
          ? "active"
          : outreach || note
            ? "waiting"
            : "unreviewed";
  const selected =
    closed ?? supplement ?? cancellation ?? application ?? note ?? booked;
  const dates = evidence
    .map((e) => e.observedAt)
    .filter((v): v is string => v !== null)
    .filter((v) => Number.isFinite(Date.parse(v)));
  const verifiedAt =
    dates.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? cutoff;
  return {
    company:
      text(closed?.raw.company) ??
      text(raw.company) ??
      text(raw.employer) ??
      "Unknown",
    role: text(raw.role) ?? "Unknown",
    status,
    stage: closed
      ? "Reported closed"
      : supplement
        ? "Recruiter reply; decision pending"
        : cancellation
          ? "Replacement call decision"
          : application
            ? "Application decision"
            : note
              ? "Recruiter call reported complete"
              : booked
                ? "Recruiter call observed booked"
                : existing
                  ? "Existing relationship decision"
                  : outreach
                    ? "Outreach observed; awaiting reply"
                    : "Unreviewed observation",
    inPipeline: Boolean(outreach || existing || booked),
    summary: supplement
      ? "Reply and scheduling invitation observed; no confirmed booking, specific job description or compensation. Role match unconfirmed."
      : (text(selected?.raw.status) ??
        text(selected?.raw.next_step) ??
        text(raw.engagement_as_of_cutoff) ??
        text(raw.reason) ??
        "Source observation; current opening unverified"),
    verifiedAt,
    approval: "No current pursuit or action approval",
    history: "legacy_unversioned",
    protection: "import_pending",
    overlaySources: selected
      ? [{ source: selected.source, pointer: selected.pointer }]
      : [],
  };
}
