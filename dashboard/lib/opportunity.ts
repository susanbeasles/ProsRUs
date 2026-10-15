import { domainBodySchemas } from "../../integration/shared-contract.mjs";
import { objectFields, type ReadRecord } from "./api";

/** Opportunity states exactly as the catalog's transition schema declares them. */
export const OPPORTUNITY_STATES: readonly string[] = (() => {
  const properties = objectFields(objectFields(domainBodySchemas.transition_opportunity).properties);
  const values = objectFields(properties.state).enum;
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === "string") : [];
})();

/**
 * Mirror of the domain's allowed transitions (src/domain/rules.ts keeps its table private).
 * tests/dashboard-transitions.test.ts proves this table agrees with the domain's transition().
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  discovered: ["researching", "qualified", "blocked", "declined"],
  researching: ["qualified", "blocked", "declined"],
  qualified: ["packet_ready", "researching", "blocked", "declined"],
  packet_ready: ["submitted", "researching", "blocked", "declined"],
  submitted: ["recruiter_screen", "interviewing", "rejected", "withdrawn", "blocked"],
  recruiter_screen: ["interviewing", "rejected", "withdrawn", "blocked"],
  interviewing: ["offer", "rejected", "withdrawn", "blocked"],
  offer: ["declined", "withdrawn"],
  declined: [],
  rejected: [],
  withdrawn: [],
  blocked: ["researching"],
};

export function allowedTransitions(from: string): readonly string[] {
  return ALLOWED[from] ?? [];
}

/** Withdrawing or declining requires explicit confirmation in the domain. */
export function requiresConfirmation(to: string): boolean {
  return to === "withdrawn" || to === "declined";
}

export type OpportunityView = {
  readonly entityId: string;
  readonly revision: number;
  readonly state: string | null;
  readonly body: Record<string, unknown>;
};

/** A domain opportunity the dashboard may act on; imported observations and archives are read-only. */
export function actionableOpportunity(row: ReadRecord | undefined): OpportunityView | null {
  if (!row || row.kind !== "opportunity" || row.origin !== "domain_record" || row.bodyStatus !== "available") return null;
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  const body = objectFields(row.body);
  const state = typeof body.state === "string" && OPPORTUNITY_STATES.includes(body.state) ? body.state : null;
  return { entityId: row.entityId, revision, state, body };
}

/** The revision of a domain record as the integer that revision-aware writes expect. */
export function recordRevision(row: ReadRecord | undefined): number | null {
  if (!row || row.revision === null) return null;
  const revision = Number(row.revision);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}
