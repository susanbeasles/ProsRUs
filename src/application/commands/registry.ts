import {
  coreOperations,
  operationById,
  type CoreOperationId,
} from "../../../integration/shared-contract.mjs";

/** Finite command registry keyed by catalog operation id. Every non-read catalog
 * operation has exactly one explicit availability decision; nothing else is
 * dispatchable. Reads are routed separately and never enter this registry. */
export type CommandKind =
  | "domain"
  | "version-save"
  | "upload-begin"
  | "upload-chunk"
  | "upload-complete";
export type UnavailableReason =
  | "claim-permission-resolver-unavailable"
  | "meeting-authorization-resolver-unavailable"
  | "profile-export-mechanics-unavailable";
export type CommandAvailability =
  | Readonly<{ state: "available"; kind: CommandKind }>
  | Readonly<{ state: "unavailable"; reason: UnavailableReason }>;
export type CommandOperationId = Exclude<
  CoreOperationId,
  | "job-stack.session.read.v1"
  | "job-stack.pipeline.page.read.v1"
  | "job-stack.records.read.v1"
  | "job-stack.profile.read.v1"
  | "job-stack.version.read.v1"
  | "job-stack.version.list.v1"
  | "job-stack.request.read.v1"
  | "job-stack.protection.read.v1"
  | "job-stack.recovery.status.read.v1"
  | "job-stack.artifact.read.v1"
>;
const available = (kind: CommandKind): CommandAvailability =>
  Object.freeze({ state: "available", kind });
const unavailable = (reason: UnavailableReason): CommandAvailability =>
  Object.freeze({ state: "unavailable", reason });

export const COMMAND_REGISTRY: Readonly<
  Record<CommandOperationId, CommandAvailability>
> = Object.freeze({
  // Fourteen domain local-writes through the maintained core planner/lifecycle.
  "job-stack.claim.add.v1": available("domain"),
  "job-stack.claim.review.v1": available("domain"),
  "job-stack.profile.conflict.resolve.v1": available("domain"),
  "job-stack.opportunity.capture.v1": available("domain"),
  "job-stack.opportunity.assess.v1": available("domain"),
  "job-stack.opportunity.transition.v1": available("domain"),
  // Every successful packet/submission plan requires current claim-permission
  // evidence that only Control can resolve; the shared contract has no such RPC.
  "job-stack.packet.create.v1": unavailable(
    "claim-permission-resolver-unavailable",
  ),
  "job-stack.submission.record.v1": unavailable(
    "claim-permission-resolver-unavailable",
  ),
  "job-stack.conversation.capture.v1": available("domain"),
  "job-stack.conversation.associate.v1": available("domain"),
  "job-stack.conversation.draft.save.v1": available("domain"),
  "job-stack.interview.prepare.v1": available("domain"),
  "job-stack.offer.record.v1": available("domain"),
  "job-stack.settings.update.v1": available("domain"),
  // Generic inert archival save through the maintained prepare/sign/commit path.
  "job-stack.version.save.v1": available("version-save"),
  // Meeting artifacts need a meeting authorizationRef resolver; the upload
  // session does not bind one, so the purpose cannot be verified.
  "job-stack.meeting.import.v1": unavailable(
    "meeting-authorization-resolver-unavailable",
  ),
  // No maintained change-set export/rendering module exists to wire.
  "job-stack.profile.export.v1": unavailable(
    "profile-export-mechanics-unavailable",
  ),
  // Maintained R2 upload intake (recovery-uploads.ts).
  "job-stack.upload.begin.v1": available("upload-begin"),
  "job-stack.upload.chunk.v1": available("upload-chunk"),
  "job-stack.upload.complete.v1": available("upload-complete"),
});

/** Effects outside the catalog. They are external (delivery, calendar,
 * provider reads, background execution) and stay unavailable until a separate
 * gated activation supplies current external authority and retry custody. */
export const EXTERNAL_EFFECTS = Object.freeze({
  send_reply: "external-delivery-gated",
  schedule_interview: "external-calendar-gated",
  reschedule_interview: "external-calendar-gated",
  cancel_interview: "external-calendar-gated",
  sync_mail: "provider-sync-gated",
  discover: "provider-discovery-gated",
  import_document: "provider-import-gated",
  reconcile_action: "external-reconciliation-gated",
  queue: "queue-consumer-reserved-for-gated-effects",
  scheduled: "cron-reserved-for-gated-effects",
} as const);
export type ExternalEffect = keyof typeof EXTERNAL_EFFECTS;

/** Documented reason for a retired legacy service/executor entry point. Local
 * writes execute only through COMMAND_REGISTRY via `Coordinator.invokeCore`;
 * external effects stay gated (EXTERNAL_EFFECTS). */
export function legacyAvailability(name: string): string {
  return Object.hasOwn(EXTERNAL_EFFECTS, name)
    ? EXTERNAL_EFFECTS[name as ExternalEffect]
    : "superseded-by-command-registry";
}
/** Legacy entry points never execute; this always throws the fixed public
 * denial before any storage, provider or reservation access. It is typed
 * `void` so the retired bodies behind it remain ordinary checked source. */
export function denyLegacyOperation(name: string): void {
  legacyAvailability(name);
  throw Error("operation-unavailable");
}

export type CommandDefinition = Readonly<{
  operationId: CommandOperationId;
  kind: CommandKind;
  effect: "local-write" | "intake" | "private-export";
  ownerOnly: boolean;
}>;
export function isCommandOperation(id: string): id is CommandOperationId {
  return Object.hasOwn(COMMAND_REGISTRY, id);
}
/** The only dispatch decision. Unregistered or unavailable means denial before
 * any authority call, storage read or effect. */
export function commandFor(operationId: string): CommandDefinition {
  if (!isCommandOperation(operationId)) throw Error("operation-unavailable");
  const availability = COMMAND_REGISTRY[operationId];
  const operation = operationById(operationId);
  if (
    availability.state !== "available" ||
    !operation ||
    operation.effect === "read" ||
    operation.effect === "recovery-commit" ||
    !("ownerOnly" in operation)
  )
    throw Error("operation-unavailable");
  return Object.freeze({
    operationId,
    kind: availability.kind,
    effect: operation.effect,
    ownerOnly: operation.ownerOnly,
  });
}
/** Catalog coverage check used by tests and startup assertions. */
export function registryCoverage() {
  const commands = coreOperations
    .filter((o) => o.effect !== "read")
    .map((o) => o.id)
    .sort();
  return {
    commands,
    registered: Object.keys(COMMAND_REGISTRY).sort(),
  };
}
