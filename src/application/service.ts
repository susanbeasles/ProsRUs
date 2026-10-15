import { denyLegacyOperation } from "./commands/registry";
import { z } from "zod";
import { effectDigestInput } from "../domain/effects";
import {
  type Principal,
  type Settings,
  claimSchema,
  demand,
  initialSettings,
  opportunitySchema,
  settingsSchema,
} from "../domain/model";
import { authorize } from "../domain/rules";
import { digest } from "../identity/vault";
import type { Google } from "../providers/google";
import { type Store } from "../storage/store";
import { type Operation } from "./contracts";
import { updateSettings } from "./operations/configuration";
import {
  associateThread,
  captureThread,
  saveDraft,
  sendReply,
} from "./operations/conversations";
import {
  prepareInterview,
  rescheduleInterview,
  scheduleInterview,
} from "./operations/interviews";
import {
  assessOpportunity,
  captureOpportunity,
  recordOffer,
  transitionOpportunity,
} from "./operations/opportunities";
import { createPacket, recordSubmission } from "./operations/packets";
import {
  addClaim,
  resolveProfileConflict,
  reviewClaim,
} from "./operations/profile";
import {
  discover,
  importDocument,
  reconcileAction,
  syncMail,
} from "./operations/sources";
export type Dependencies = {
  store: Store;
  owner: string;
  now: () => number;
  artifacts: R2Bucket;
  enqueue: (id: string) => Promise<void>;
  google: () => Promise<Google>;
};
export function createService(deps: Dependencies) {
  const { store, owner } = deps;
  async function settings(): Promise<{ value: Settings; revision: number }> {
    const r = await store.get("settings", "main");
    return {
      value: r ? settingsSchema.parse(r.body) : initialSettings,
      revision: r?.revision ?? 0,
    };
  }
  async function opportunity(id: string) {
    const r = await store.get("opportunity", id);
    demand(r, "NOT_FOUND", 404);
    return { record: r, value: opportunitySchema.parse(r.body) };
  }
  async function requirePacket(packetId: string, opportunityId: string) {
    const p = await store.get("packet", packetId);
    demand(p, "PACKET_NOT_FOUND", 404);
    const packet = z
      .object({
        opportunityId: z.string(),
        claimIds: z.array(z.string()),
        claimDigest: z.string(),
        artifactKey: z.string(),
      })
      .passthrough()
      .parse(p.body);
    demand(packet.opportunityId === opportunityId, "PACKET_MISMATCH");
    const current = await Promise.all(
      packet.claimIds.map(async (id) => {
        const c = await store.get("claim", id);
        demand(c, "CLAIM_NOT_FOUND");
        return claimSchema.parse(c.body);
      }),
    );
    demand(
      (await digest(JSON.stringify(current))) === packet.claimDigest,
      "STALE_PACKET",
      409,
    );
    demand(
      current.every(
        (c) =>
          c.permitted &&
          ["user_confirmed", "source_supported"].includes(c.status),
      ),
      "CLAIM_NOT_PERMITTED",
    );
    return packet;
  }
  async function reserve(kind: string, id: string, payload: unknown) {
    const saved = await store.reserveIntent({
      id,
      kind,
      payload,
      digest: await digest(
        JSON.stringify(
          effectDigestInput(
            kind,
            z.record(z.string(), z.unknown()).parse(payload),
          ),
        ),
      ),
      now: deps.now(),
    });
    if (saved.state === "pending") await deps.enqueue(saved.id);
    return saved;
  }
  async function invoke(
    actor: Principal,
    operation: Operation,
    raw: unknown,
  ): Promise<unknown> {
    denyLegacyOperation(operation);
    const now = deps.now();
    try {
      authorize({
        actor,
        ownerId: owner,
        scope:
          operation === "send_reply"
            ? "send"
            : [
                  "schedule_interview",
                  "reschedule_interview",
                  "cancel_interview",
                ].includes(operation)
              ? "schedule"
              : "write",
        now,
      });
    } catch (e) {
      await store.audit(actor.id, operation, "none", "deny", now);
      throw e;
    }
    const operations = {
      reschedule_interview: rescheduleInterview,
      cancel_interview: rescheduleInterview,
      resolve_profile_conflict: resolveProfileConflict,
      associate_thread: associateThread,
      add_claim: addClaim,
      review_claim: reviewClaim,
      capture_opportunity: captureOpportunity,
      assess_opportunity: assessOpportunity,
      transition_opportunity: transitionOpportunity,
      create_packet: createPacket,
      record_submission: recordSubmission,
      capture_thread: captureThread,
      save_draft: saveDraft,
      send_reply: sendReply,
      schedule_interview: scheduleInterview,
      record_offer: recordOffer,
      prepare_interview: prepareInterview,
      update_settings: updateSettings,
      discover: discover,
      sync_mail: syncMail,
      reconcile_action: reconcileAction,
      import_document: importDocument,
    };
    return operations[operation](
      { actor, raw, now, operation },
      {
        store,
        owner,
        deps,
        settings,
        opportunity,
        requirePacket,
        reserve,
        invoke,
      },
    );
  }
  async function snapshot(actor: Principal) {
    denyLegacyOperation("snapshot");
    authorize({ actor, ownerId: owner, scope: "read", now: deps.now() });
    const names = [
      "claim",
      "opportunity",
      "packet",
      "thread",
      "interview",
      "offer",
      "artifact",
      "connection",
      "reminder",
      "prep",
      "question",
    ] as const;
    const result = Object.fromEntries(
      await Promise.all(
        names.map(async (kind) => [kind, await store.list(kind)]),
      ),
    );
    return {
      ...result,
      settings: await settings(),
      activity: await store.auditLog(),
      intents: await store.intents(),
    };
  }
  return { invoke, snapshot, settings, requirePacket };
}
