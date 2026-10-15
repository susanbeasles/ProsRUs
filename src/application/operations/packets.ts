import { z } from "zod";
import { claimSchema, demand } from "../../domain/model";
import { buildPacket, transition } from "../../domain/rules";
import { digest } from "../../identity/vault";
import { schemas } from "../contracts";
import type { OperationDependencies, OperationRequest } from "../dependencies";
export async function createPacket(
  { actor, raw, now }: OperationRequest,
  {
    store,
    owner,
    deps,
    opportunity,
  }: Pick<OperationDependencies, "store" | "owner" | "deps" | "opportunity">,
) {
  const input = schemas.create_packet.parse(raw);
  const { value, record } = await opportunity(input.opportunityId);
  demand(
    ["qualified", "packet_ready"].includes(value.state) && !value.flags.length,
    "OPPORTUNITY_NOT_READY",
  );
  const claims = await Promise.all(
    input.claimIds.map(async (id) => {
      const r = await store.get("claim", id);
      demand(r, "CLAIM_NOT_FOUND");
      return claimSchema.parse(r.body);
    }),
  );
  const packet = buildPacket({
    claims,
    claimIds: input.claimIds,
    role: value.role,
    company: value.company,
  });
  const id = crypto.randomUUID();
  const artifactKey = `${owner}/packets/${id}.json`;
  await deps.artifacts.put(artifactKey, JSON.stringify(packet), {
    httpMetadata: { contentType: "application/json" },
  });
  const result = await store.add(
    "packet",
    id,
    {
      ...packet,
      id,
      opportunityId: value.id,
      claimIds: input.claimIds,
      claimDigest: await digest(JSON.stringify(claims)),
      artifactKey,
      createdAt: now,
    },
    actor.id,
    now,
  );
  await store.update(
    "opportunity",
    value.id,
    {
      ...value,
      state: "packet_ready",
      nextAction:
        "Review packet and complete the supported employer application",
    },
    record.revision,
    actor.id,
    now,
  );
  return result;
}
export async function recordSubmission(
  { actor, raw, now }: OperationRequest,
  {
    store,
    settings,
    opportunity,
    requirePacket,
  }: Pick<
    OperationDependencies,
    "store" | "settings" | "opportunity" | "requirePacket"
  >,
) {
  const input = schemas.record_submission.parse(raw);
  const { record, value } = await opportunity(input.opportunityId);
  const { value: config } = await settings();
  demand(config.profileResolved, "PROFILE_UNRESOLVED");
  demand(
    !(await store.list("question")).some((r) => {
      const q = z.record(z.string(), z.unknown()).parse(r.body);
      return q.type === "profile_conflict" && q.status !== "resolved";
    }),
    "PROFILE_CONFLICT_UNRESOLVED",
  );
  await requirePacket(input.packetId, input.opportunityId);
  demand(actor.kind === "user", "USER_CONFIRMATION_REQUIRED");
  transition({
    from: value.state,
    to: "submitted",
    evidence: input.receipt,
    confirmed: true,
  });
  await store.add("attempt", crypto.randomUUID(), input, actor.id, now);
  return store.update(
    "opportunity",
    value.id,
    {
      ...value,
      state: "submitted",
      nextAction: "Await recruiter response",
    },
    record.revision,
    actor.id,
    now,
  );
}
