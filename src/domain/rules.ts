import {
  targetingProfileSchema,
  discoveryWindowSchema,
  type TargetingProfile,
  type DiscoveryWindow,
} from "./targeting-profile";
import {
  type Claim,
  type Terms,
  type Principal,
  type Scope,
  type OpportunityState,
  type Window,
  demand,
} from "./model";
export function assessFit(
  terms: Terms,
  suppliedTargeting?: TargetingProfile,
): {
  status: "qualified" | "researching" | "ineligible";
  rationale: string[];
} {
  if (suppliedTargeting === undefined)
    return {
      status: "researching",
      rationale: ["Targeting profile is unconfigured"],
    };
  const targeting = targetingProfileSchema.parse(suppliedTargeting);
  const rationale: string[] = [];
  let unknown = false;
  let failed = false;
  function requireFact(value: boolean | null, label: string) {
    if (value === null) {
      unknown = true;
      rationale.push(`${label}: unknown`);
    } else if (!value) {
      failed = true;
      rationale.push(`${label}: does not meet requirement`);
    } else rationale.push(`${label}: meets requirement`);
  }
  if (targeting.requireRemote) requireFact(terms.remote, "Remote eligibility");
  if (terms.employment === "full_time") {
    requireFact(
      terms.baseUsd === null ? null : terms.baseUsd >= targeting.baseFloorUsd,
      `Base salary at least USD ${targeting.baseFloorUsd}`,
    );
    if (targeting.require401kMatch)
      requireFact(terms.match401k, "Employer 401(k) match");
    if (targeting.requireZeroPremium)
      requireFact(terms.zeroPremium, "Zero employee health premium");
    if (targeting.requireAffordableCare)
      requireFact(terms.affordableCare, "Affordable visits and prescriptions");
  } else
    requireFact(
      terms.hourlyUsd === null
        ? null
        : terms.hourlyUsd >= targeting.hourlyFloorUsd,
      `Contract floor USD ${targeting.hourlyFloorUsd}/hour`,
    );
  return {
    status: failed ? "ineligible" : unknown ? "researching" : "qualified",
    rationale,
  };
}
export function inspectText(value: string): string[] {
  const flags: string[] = [];
  if (
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(
      value,
    )
  )
    flags.push("Hidden control characters");
  if (
    /ignore (?:all |previous |prior )*instructions|system prompt|developer message|send.{0,40}(?:token|secret|credential)|curl\s|\b(?:eval|exec)\s*\(|<script|base64[,\s:]/iu.test(
      value,
    )
  )
    flags.push("Possible embedded instructions or executable content");
  if (/[^\x00-\x7f]/u.test(value)) flags.push("Non-ASCII text requires review");
  return flags;
}
export function buildPacket(input: {
  claims: readonly Claim[];
  claimIds: readonly string[];
  role: string;
  company: string;
}) {
  demand(input.claimIds.length > 0, "NO_CLAIMS");
  const claims = input.claimIds.map((id) => {
    const c = input.claims.find((c) => c.id === id);
    demand(
      c &&
        c.permitted &&
        ["user_confirmed", "source_supported"].includes(c.status),
      "CLAIM_NOT_PERMITTED",
    );
    demand(
      c.status !== "source_supported" || c.sourceIds.length > 0,
      "MISSING_EVIDENCE",
    );
    demand(!inspectText(c.text).length, "CLAIM_REVIEW_REQUIRED");
    return { ...c, sourceIds: [...c.sourceIds] };
  });
  return {
    company: input.company,
    role: input.role,
    claims,
    resume: claims.map((c) => `- ${c.text}`).join("\n"),
    coverNote: `I am interested in the ${input.role} role at ${input.company}. My relevant experience includes:\n\n${claims.map((c) => `- ${c.text}`).join("\n")}\n\nI would welcome a conversation about the role.`,
  };
}
export function authorize({
  actor,
  ownerId,
  scope,
  now,
}: {
  actor: Principal;
  ownerId: string;
  scope: Scope;
  now: number;
}) {
  demand(actor.expiresAt > now, "UNAUTHENTICATED", 401);
  demand(
    actor.id === ownerId && actor.scopes.includes(scope),
    "FORBIDDEN",
    403,
  );
}
const allowed: Record<OpportunityState, readonly OpportunityState[]> = {
  discovered: ["researching", "qualified", "blocked", "declined"],
  researching: ["qualified", "blocked", "declined"],
  qualified: ["packet_ready", "researching", "blocked", "declined"],
  packet_ready: ["submitted", "researching", "blocked", "declined"],
  submitted: [
    "recruiter_screen",
    "interviewing",
    "rejected",
    "withdrawn",
    "blocked",
  ],
  recruiter_screen: ["interviewing", "rejected", "withdrawn", "blocked"],
  interviewing: ["offer", "rejected", "withdrawn", "blocked"],
  offer: ["declined", "withdrawn"],
  declined: [],
  rejected: [],
  withdrawn: [],
  blocked: ["researching"],
};
export function transition({
  from,
  to,
  evidence,
  confirmed,
}: {
  from: OpportunityState;
  to: OpportunityState;
  evidence: string;
  confirmed: boolean;
}) {
  demand(allowed[from].includes(to), "INVALID_TRANSITION");
  demand(evidence.trim(), "EVIDENCE_REQUIRED");
  if (["withdrawn", "declined"].includes(to))
    demand(confirmed, "CONFIRMATION_REQUIRED");
  return to;
}
export function discoveryKey(
  now: Date,
  suppliedWindow?: DiscoveryWindow,
): string | null {
  if (suppliedWindow === undefined) return null;
  const window = discoveryWindowSchema.parse(suppliedWindow);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: window.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour"));
  return hour >= window.startHour && hour <= window.endHour
    ? `${get("year")}-${get("month")}-${get("day")}:${get("hour")}`
    : null;
}
export function validateSlot({
  start,
  end,
  windows,
  busy,
  now,
}: {
  start: number;
  end: number;
  windows: readonly Window[];
  busy: readonly Window[];
  now: number;
}) {
  demand(
    Number.isFinite(start) &&
      Number.isFinite(end) &&
      start > now &&
      end > start &&
      end - start <= 4 * 3600000,
    "INVALID_SLOT",
  );
  demand(
    windows.some((w) => start >= w.start && end <= w.end),
    "OUTSIDE_AVAILABILITY",
  );
  demand(!busy.some((w) => start < w.end && end > w.start), "CONFLICT", 409);
}
export function canonicalUrl(value: string) {
  const u = new URL(value);
  demand(
    u.protocol === "https:" && !u.username && !u.password,
    "INVALID_SOURCE_URL",
  );
  u.hash = "";
  for (const key of [...u.searchParams.keys()])
    if (key.startsWith("utm_") || ["ref", "source"].includes(key))
      u.searchParams.delete(key);
  u.searchParams.sort();
  return u.href;
}
