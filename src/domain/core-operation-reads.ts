import { canonicalUrl } from "./rules";
import { demand } from "./model";
import { parseEnvelopeJson } from "./recovery-canonical";
import { recordIdentity } from "./recovery-domain-plan";
import {
  parseDomainRecordSnapshot,
  parseDomainRecoverySnapshot,
  type DomainRecordKind,
} from "./recovery-record";
import {
  parseDomainOperation,
  allocationSchema,
  coreObservationSchema,
  type CoreAllocation,
  type CoreObservation,
  type DomainOperationRequest,
} from "./core-operation-input";

export type CoreReadSelection = Readonly<{
  records: readonly Readonly<{
    recordKind: DomainRecordKind;
    entityId: string;
  }>[];
  collections: readonly ("all_claims" | "unresolved_profile_conflicts")[];
  sourceKeys: readonly string[];
}>;
/** The only selector derives names/IDs from catalog-validated input, stable host
 * allocation and previously verified selected rows. No caller SQL/predicate/key. */
export function selectCoreReads(
  operation: DomainOperationRequest,
  allocation: CoreAllocation,
  observed?: CoreObservation,
): CoreReadSelection {
  const request = parseDomainOperation({
      operationId: operation.operationId,
      input: operation.input,
    }),
    stable = allocationSchema.parse(allocation),
    read = observed ? coreObservationSchema.parse(observed) : null;
  const records = new Map<
    string,
    { recordKind: DomainRecordKind; entityId: string }
  >();
  const collections: ("all_claims" | "unresolved_profile_conflicts")[] = [],
    sourceKeys: string[] = [];
  function add(recordKind: DomainRecordKind, entityId: string) {
    records.set(recordIdentity({ recordKind, entityId }), {
      recordKind,
      entityId,
    });
    demand(records.size <= 128, "DOMAIN_READSET_TOO_LARGE");
  }
  function record(kind: DomainRecordKind, entityId: string) {
    const guard = read?.records.find(
      (r) => r.recordKind === kind && r.entityId === entityId,
    );
    if (!guard || guard.state === "absent") return null;
    const fields = {
      formatVersion: 1,
      recordKind: kind,
      entityId,
      revision: guard.revision,
      updatedAt: guard.updatedAt,
      body: parseEnvelopeJson(guard.rawBody),
    };
    try {
      return parseDomainRecordSnapshot({ ...fields, type: "domain_record" });
    } catch {
      return parseDomainRecoverySnapshot({
        ...fields,
        type: "legacy_record_quarantine",
        reason: "incomplete_legacy_claim",
      });
    }
  }
  function claimSources(entityId: string) {
    const value = record("claim", entityId);
    if (value?.recordKind === "claim")
      for (const source of value.body.sourceIds ?? []) add("artifact", source);
  }
  const roles: string[] = [];
  function allocated(
    role: string,
    kind: DomainRecordKind,
    expectedId?: string,
  ) {
    roles.push(role);
    const slot = stable.records.find((s) => s.role === role);
    demand(
      slot &&
        slot.recordKind === kind &&
        (expectedId === undefined || slot.entityId === expectedId),
      "DOMAIN_ALLOCATION_MISMATCH",
    );
    add(kind, slot.entityId);
  }
  switch (request.operationId) {
    case "job-stack.claim.add.v1":
      allocated("claim", "claim");
      for (const id of request.input.body.sourceIds) add("artifact", id);
      break;
    case "job-stack.claim.review.v1":
      allocated("claim", "claim", request.input.body.id);
      claimSources(request.input.body.id);
      break;
    case "job-stack.profile.conflict.resolve.v1": {
      allocated("question", "question", request.input.body.questionId);
      const q = record("question", request.input.body.questionId);
      if (q?.recordKind === "question" && "type" in q.body)
        for (const v of q.body.values) add("artifact", v.sourceId);
      break;
    }
    case "job-stack.opportunity.capture.v1": {
      add("settings", "main");
      const key = canonicalUrl(request.input.body.sourceUrl);
      sourceKeys.push(key);
      const mapping = read?.sourceKeys.find((s) => s.sourceKey === key);
      allocated(
        "opportunity",
        "opportunity",
        mapping?.opportunityId ?? undefined,
      );
      break;
    }
    case "job-stack.opportunity.assess.v1":
      add("settings", "main");
      allocated("opportunity", "opportunity", request.input.body.id);
      break;
    case "job-stack.opportunity.transition.v1":
      allocated("opportunity", "opportunity", request.input.body.id);
      break;
    case "job-stack.packet.create.v1":
      allocated("packet", "packet");
      allocated("opportunity", "opportunity", request.input.body.opportunityId);
      for (const id of request.input.body.claimIds) {
        add("claim", id);
        claimSources(id);
      }
      break;
    case "job-stack.submission.record.v1": {
      allocated("attempt", "attempt");
      allocated("opportunity", "opportunity", request.input.body.opportunityId);
      add("packet", request.input.body.packetId);
      add("settings", "main");
      collections.push("unresolved_profile_conflicts");
      const packet = record("packet", request.input.body.packetId);
      if (packet?.recordKind === "packet")
        for (const id of packet.body.claimIds) {
          add("claim", id);
          claimSources(id);
        }
      break;
    }
    case "job-stack.conversation.capture.v1":
      allocated("thread", "thread");
      add("opportunity", request.input.body.opportunityId);
      break;
    case "job-stack.conversation.associate.v1": {
      allocated("thread", "thread");
      add("opportunity", request.input.body.opportunityId);
      add("question", request.input.body.questionId);
      const q = record("question", request.input.body.questionId);
      if (
        q?.recordKind === "question" &&
        "threadId" in q.body &&
        q.body.threadId
      )
        demand(
          q.body.threadId ===
            stable.records.find((s) => s.role === "thread")?.entityId,
          "THREAD_ASSOCIATION_MISMATCH",
        );
      // Existing-thread no-change semantics omit a question candidate, but still
      // pin the exact selected question and association as a source-only guard.
      if (stable.records.some((s) => s.role === "question"))
        allocated("question", "question", request.input.body.questionId);
      break;
    }
    case "job-stack.conversation.draft.save.v1":
      allocated("thread", "thread", request.input.body.threadId);
      break;
    case "job-stack.interview.prepare.v1": {
      allocated("prep", "prep", request.input.body.interviewId);
      add("interview", request.input.body.interviewId);
      collections.push("all_claims");
      const interview = record("interview", request.input.body.interviewId);
      if (interview?.recordKind === "interview")
        add("opportunity", interview.body.opportunityId);
      break;
    }
    case "job-stack.offer.record.v1":
      allocated("offer", "offer");
      allocated("opportunity", "opportunity", request.input.body.opportunityId);
      break;
    case "job-stack.settings.update.v1":
      allocated("settings", "settings", "main");
      break;
  }
  demand(
    stable.records.every((s) => roles.includes(s.role)),
    "DOMAIN_ALLOCATION_MISMATCH",
  );
  for (const kind of collections) {
    const collection = read?.collections.find((c) => c.kind === kind);
    if (collection)
      for (const id of collection.memberIds) {
        add(kind === "all_claims" ? "claim" : "question", id);
        if (kind === "all_claims") claimSources(id);
      }
  }
  return {
    records: [...records.values()].sort((a, b) =>
      recordIdentity(a) < recordIdentity(b)
        ? -1
        : recordIdentity(a) > recordIdentity(b)
          ? 1
          : 0,
    ),
    collections,
    sourceKeys,
  };
}
export function validateCoreObservation(
  operation: DomainOperationRequest,
  allocation: CoreAllocation,
  read: CoreObservation,
  phase: "mutation" | "baseline-archive-v1" = "mutation",
): CoreObservation {
  const selection = selectCoreReads(operation, allocation, read),
    wanted = new Set(selection.records.map(recordIdentity));
  demand(
    new Set(read.records.map(recordIdentity)).size === read.records.length,
    "DUPLICATE_DOMAIN_ID",
  );
  demand(
    read.records.every((r) => wanted.has(recordIdentity(r))),
    "UNSELECTED_DOMAIN_READ",
  );
  demand(
    selection.records.every((r) =>
      read.records.some((g) => recordIdentity(g) === recordIdentity(r)),
    ),
    "DOMAIN_SELECTION_INCOMPLETE",
  );
  demand(
    selection.collections.length === read.collections.length &&
      selection.collections.every((kind) =>
        read.collections.some((c) => c.kind === kind),
      ),
    "DOMAIN_COLLECTION_SELECTION_MISMATCH",
  );
  for (const collection of read.collections)
    for (const id of collection.memberIds) {
      const guard = read.records.find(
        (r) =>
          r.recordKind ===
            (collection.kind === "all_claims" ? "claim" : "question") &&
          r.entityId === id,
      );
      demand(guard?.state === "present", "DOMAIN_SELECTION_INCOMPLETE");
    }
  demand(
    selection.sourceKeys.length === read.sourceKeys.length &&
      selection.sourceKeys.every((key) =>
        read.sourceKeys.some((s) => s.sourceKey === key),
      ),
    "DOMAIN_SOURCE_SELECTION_MISMATCH",
  );
  const present = new Set(
    read.records.filter((r) => r.state === "present").map(recordIdentity),
  );
  demand(
    new Set(read.bindings.map(recordIdentity)).size === read.bindings.length &&
      read.bindings.length === present.size &&
      read.bindings.every((b) => present.has(recordIdentity(b))),
    "DOMAIN_BINDING_SELECTION_MISMATCH",
  );
  for (const binding of read.bindings) {
    const guard = read.records.find(
      (r) => recordIdentity(r) === recordIdentity(binding),
    );
    demand(
      guard?.state === "present" &&
        binding.revision === guard.revision &&
        (binding.versionId === null
          ? phase === "baseline-archive-v1" &&
            binding.heads.length === 0 &&
            binding.sourceVersionIds.length === 0
          : binding.heads.length === 1 &&
            binding.heads[0] === binding.versionId),
      "COMMITTED_DOMAIN_BINDING_REQUIRED",
    );
  }
  const archives = read.archiveSources ?? [];
  demand(
    new Set(archives.map((a) => a.entityId)).size === archives.length &&
      archives.every((a) =>
        read.records.some(
          (r) =>
            r.recordKind === "artifact" &&
            r.entityId === a.entityId &&
            r.state === "absent",
        ),
      ),
    "UNSELECTED_ARCHIVE_SOURCE",
  );
  const packetRows = read.records.filter(
    (r) => r.recordKind === "packet" && r.state === "present",
  );
  const evidence = read.packetEvidence ?? [];
  demand(
    new Set(evidence.map((p) => p.packetId)).size === evidence.length &&
      evidence.every(
        (p) =>
          packetRows.some((r) => r.entityId === p.packetId) &&
          read.bindings.some(
            (b) =>
              b.recordKind === "packet" &&
              b.entityId === p.packetId &&
              b.versionId === p.versionId,
          ),
      ),
    "UNSELECTED_PACKET_EVIDENCE",
  );
  return read;
}
