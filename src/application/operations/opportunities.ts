import { demand } from "../../domain/model";
import { rankListing } from "../../domain/ranking";
import {
  assessFit,
  canonicalUrl,
  inspectText,
  transition,
} from "../../domain/rules";
import { schemas } from "../contracts";
import type { OperationDependencies, OperationRequest } from "../dependencies";
export async function captureOpportunity(
  { actor, raw, now }: OperationRequest,
  { store, settings }: Pick<OperationDependencies, "store" | "settings">,
) {
  const input = schemas.capture_opportunity.parse(raw);
  const sourceUrl = canonicalUrl(input.sourceUrl);
  const { value: config } = await settings();
  const fit = assessFit(input.terms, config.targetingProfile);
  const flags = inspectText(
    input.description + " " + input.role + " " + input.company,
  );
  const id = crypto.randomUUID();
  return store.ingest(
    sourceUrl,
    id,
    {
      ...input,
      sourceUrl,
      id,
      fit,
      ranking: rankListing(
        input.description,
        input.role,
        input.terms.baseUsd,
        config.targetingProfile,
      ),
      lastSeenAt: now,
      flags,
      state: flags.length
        ? "blocked"
        : fit.status === "qualified"
          ? "qualified"
          : "researching",
      nextAction: flags.length
        ? "Review flagged source content"
        : "Verify requirements and prepare application",
      dueAt: null,
      createdAt: now,
    },
    actor.id,
    now,
  );
}
export async function assessOpportunity(
  { actor, raw, now }: OperationRequest,
  {
    store,
    opportunity,
    settings,
  }: Pick<OperationDependencies, "store" | "opportunity" | "settings">,
) {
  const input = schemas.assess_opportunity.parse(raw);
  const { value } = await opportunity(input.id);
  const { value: config } = await settings();
  const fit = assessFit(input.terms, config.targetingProfile);
  return store.update(
    "opportunity",
    input.id,
    {
      ...value,
      terms: input.terms,
      fit,
      state: ["discovered", "researching", "qualified"].includes(value.state)
        ? fit.status === "qualified"
          ? "qualified"
          : "researching"
        : value.state,
    },
    input.revision,
    actor.id,
    now,
  );
}
export async function transitionOpportunity(
  { actor, raw, now }: OperationRequest,
  { store, opportunity }: Pick<OperationDependencies, "store" | "opportunity">,
) {
  const input = schemas.transition_opportunity.parse(raw);
  demand(
    !["submitted", "packet_ready", "offer"].includes(input.state),
    "USE_EVIDENCED_OPERATION",
  );
  const { value } = await opportunity(input.id);
  const state = transition({
    from: value.state,
    to: input.state,
    evidence: input.evidence,
    confirmed: input.confirmed && actor.kind === "user",
  });
  await store.audit(
    actor.id,
    "transition.evidence",
    input.id,
    `allow:${value.state}->${state}`,
    now,
  );
  return store.update(
    "opportunity",
    input.id,
    { ...value, state, nextAction: input.evidence },
    input.revision,
    actor.id,
    now,
  );
}
export async function recordOffer(
  { actor, raw, now }: OperationRequest,
  { store, opportunity }: Pick<OperationDependencies, "store" | "opportunity">,
) {
  const input = schemas.record_offer.parse(raw);
  const { record, value } = await opportunity(input.opportunityId);
  transition({
    from: value.state,
    to: "offer",
    evidence: input.notes,
    confirmed: true,
  });
  const result = await store.add(
    "offer",
    crypto.randomUUID(),
    { ...input, status: "recorded", recordedAt: now },
    actor.id,
    now,
  );
  await store.update(
    "opportunity",
    value.id,
    {
      ...value,
      state: "offer",
      nextAction: "Review offer; acceptance is your decision",
    },
    record.revision,
    actor.id,
    now,
  );
  return result;
}
