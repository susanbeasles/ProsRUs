import { corePlannerIdentity } from "./core-operation-identity";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  operationById,
} from "../../integration/shared-contract.mjs";
import { demand } from "./model";
import {
  assessFit,
  buildPacket,
  canonicalUrl,
  inspectText,
  transition,
} from "./rules";
import { rankListing } from "./ranking";
import { parseDomainPlan, type DomainPlan } from "./recovery-domain-plan";
import { parseDomainRecordSnapshot } from "./recovery-record";
import {
  coreInputDigest,
  parseCorePlanningInput,
  recordGuard,
  type CorePlanningInput,
} from "./core-operation-input";
import {
  claimEvidenceText,
  committedBinding,
  currentClaimEvidence,
  currentRecord,
  currentSourceArtifacts,
} from "./core-operation-evidence";

import { validateCoreObservation } from "./core-operation-reads";

import { planObservedBaseline } from "./core-operation-baseline";

type Candidate = DomainPlan["candidates"][number];

function slotFor(request: CorePlanningInput, role: string) {
  const slot = request.allocation.records.find((r) => r.role === role);
  demand(slot, "DOMAIN_ALLOCATION_REQUIRED");
  return slot;
}
function candidate(
  request: CorePlanningInput,
  role: string,
  body: unknown,
  sources: readonly string[] = [],
  artifacts: Candidate["artifacts"] = [],
  preserve = false,
): Candidate {
  const slot = slotFor(request, role);
  const guard = recordGuard(request.read, slot.recordKind, slot.entityId);
  const binding =
    guard.state === "present"
      ? committedBinding(request.read, slot.recordKind, slot.entityId)
      : null;
  demand(
    !binding || binding.lineageId === slot.lineageId,
    "DOMAIN_LINEAGE_MISMATCH",
  );
  demand(!preserve || guard.state === "present", "DOMAIN_PRESERVE_MISMATCH");
  return {
    role,
    lineageId: slot.lineageId,
    snapshot: parseDomainRecordSnapshot({
      formatVersion: 1,
      type: "domain_record",
      recordKind: slot.recordKind,
      entityId: slot.entityId,
      revision:
        guard.state === "present" ? guard.revision + (preserve ? 0 : 1) : 1,
      updatedAt:
        preserve && guard.state === "present"
          ? guard.updatedAt
          : request.allocation.businessTime,
      body,
    }),
    parentVersionIds: binding ? [...binding.heads] : [],
    sourceVersionIds: [...new Set(sources)],
    artifacts,
    approval: { state: "draft", evidenceVersionIds: [] },
  };
}
/** Registered creation semantics never depend on a host allocation collision. */
function createCandidate(
  request: CorePlanningInput,
  role: string,
  body: unknown,
  sources: readonly string[] = [],
  artifacts: Candidate["artifacts"] = [],
): Candidate {
  const slot = slotFor(request, role);
  demand(
    recordGuard(request.read, slot.recordKind, slot.entityId).state ===
      "absent",
    "DOMAIN_CREATE_TARGET_EXISTS",
    409,
  );
  return candidate(request, role, body, sources, artifacts);
}
function generated(role: string, text: string): Candidate["artifacts"][number] {
  return {
    role,
    source: { type: "utf8", text, mediaType: "application/json" },
  };
}
function revision(
  request: CorePlanningInput,
  kind: "claim" | "opportunity" | "thread" | "settings",
  entityId: string,
  expected: number,
) {
  const guard = recordGuard(request.read, kind, entityId);
  demand(
    (guard.state === "present" ? guard.revision : 0) === expected,
    "REVISION_CONFLICT",
    409,
  );
}
function opportunity(request: CorePlanningInput, entityId: string) {
  const record = currentRecord(request.read, "opportunity", entityId);
  demand(record.recordKind === "opportunity", "OPPORTUNITY_NOT_FOUND");
  return record;
}
function currentTargeting(request: CorePlanningInput) {
  const guard = recordGuard(request.read, "settings", "main");
  if (guard.state === "absent") return undefined;
  const settings = currentRecord(request.read, "settings", "main");
  demand(settings.recordKind === "settings", "DOMAIN_SETTINGS_REQUIRED");
  return settings.body.targetingProfile;
}
function ownerInteraction(request: CorePlanningInput) {
  demand(
    request.currentEvidence.ownerInteraction,
    "CURRENT_OWNER_INTERACTION_REQUIRED",
  );
}
function finishCorePlan(
  request: CorePlanningInput,
  candidates: Candidate[],
  resultRole: string,
  sourceKeys: DomainPlan["sourceKeys"] = [],
  extraAudit: DomainPlan["audit"] = [],
): DomainPlan {
  const result = candidates.find((c) => c.role === resultRole);
  demand(result, "DOMAIN_RESULT_MISMATCH");
  result.artifacts.push(
    generated(
      "trusted-read-evidence",
      canonicalJson({
        format: "trusted-domain-read-v1",
        bindings: request.read.bindings,
        archiveSources: request.read.archiveSources ?? [],
        ownerInteraction: request.currentEvidence.ownerInteraction,
        claims: request.currentEvidence.claims,
        sourceArtifacts: request.currentEvidence.sourceArtifacts,
      }),
    ),
  );
  result.sourceVersionIds = [
    ...new Set([
      ...result.sourceVersionIds,
      ...request.read.bindings.flatMap((b) =>
        b.versionId === null ? [] : [b.versionId],
      ),
      ...(request.read.archiveSources ?? []).map((a) => a.versionId),
    ]),
  ];
  const mutations = candidates.map((c) => {
    const guard = recordGuard(
      request.read,
      c.snapshot.recordKind,
      c.snapshot.entityId,
    );
    return {
      candidateRole: c.role,
      mode:
        guard.state === "absent"
          ? ("insert" as const)
          : c.snapshot.revision === guard.revision
            ? ("preserve" as const)
            : ("update" as const),
    };
  });
  const audit = candidates
    .filter(
      (c) =>
        mutations.find((m) => m.candidateRole === c.role)?.mode !== "preserve",
    )
    .map((c) => {
      const slot = slotFor(request, c.role),
        mode = mutations.find((m) => m.candidateRole === c.role)?.mode;
      return {
        eventId: slot.auditEventId,
        actorId: request.allocation.actorId,
        operation: `${c.snapshot.recordKind}.${mode === "insert" ? "created" : "updated"}`,
        entityId: c.snapshot.entityId,
        decision: "allow",
        createdAt: c.snapshot.updatedAt,
      };
    });
  return parseDomainPlan({
    format: "domain-plan-v1",
    phase: "mutation",
    operationId: request.operationId,
    inputDigest: coreInputDigest(request),
    planner: { version: 1, sourceDigest: corePlannerIdentity.sourceDigest },
    workspace: request.allocation.workspace,
    actorId: request.allocation.actorId,
    requestRootId: request.allocation.requestRootId,
    requestKey: request.input.requestKey,
    readSet: {
      records: request.read.records,
      collections: request.read.collections,
      sourceKeys: request.read.sourceKeys,
      ...(request.read.archiveSources
        ? { archiveSources: request.read.archiveSources }
        : {}),
    },
    mutations,
    candidates,
    sourceKeys,
    audit: [...audit, ...extraAudit],
    resultRecord: {
      candidateRole: result.role,
      recordKind: result.snapshot.recordKind,
      entityId: result.snapshot.entityId,
      revision: result.snapshot.revision,
    },
  });
}
function additionalAudit(
  request: CorePlanningInput,
  role: string,
  operation: "transition.evidence" | "opportunity.ingested",
) {
  const slot = slotFor(request, role),
    eventId =
      operation === "transition.evidence"
        ? slot.transitionAuditEventId
        : slot.ingestAuditEventId;
  demand(eventId, "DOMAIN_ALLOCATION_REQUIRED");
  return {
    eventId,
    actorId: request.allocation.actorId,
    operation,
    entityId: slot.entityId,
    decision: "allow" as const,
    createdAt: request.allocation.businessTime,
  };
}
function packetCandidates(
  request: Extract<
    CorePlanningInput,
    { operationId: "job-stack.packet.create.v1" }
  >,
) {
  const body = request.input.body,
    op = opportunity(request, body.opportunityId);
  demand(
    ["qualified", "packet_ready"].includes(op.body.state) &&
      !op.body.flags.length,
    "OPPORTUNITY_NOT_READY",
  );
  const claims = body.claimIds.map((id) =>
    currentClaimEvidence(request.read, request.currentEvidence, id),
  );
  const packet = buildPacket({
    claims: claims.map((c) => c.claim),
    claimIds: body.claimIds,
    role: op.body.role,
    company: op.body.company,
  });
  const slot = slotFor(request, "packet");
  demand(slot.recordKind === "packet", "DOMAIN_ALLOCATION_REQUIRED");
  const packetBody = {
    ...packet,
    id: slot.entityId,
    opportunityId: op.entityId,
    claimIds: [...body.claimIds],
    claimDigest: createHash("sha256")
      .update(JSON.stringify(claims.map((c) => c.claim)))
      .digest("hex"),
    artifactKey: `${request.allocation.workspace.ownerId}/packets/${slot.entityId}.json`,
    createdAt: request.allocation.businessTime,
  };
  return [
    createCandidate(
      request,
      "packet",
      packetBody,
      [
        committedBinding(request.read, "opportunity", op.entityId).versionId,
        ...claims.flatMap((c) => [
          c.binding.versionId,
          ...c.approval.sourceVersionIds,
        ]),
      ],
      [
        generated("generated-packet", JSON.stringify(packet)),
        generated("current-claim-evidence", claimEvidenceText(claims)),
      ],
    ),
    candidate(request, "opportunity", {
      ...op.body,
      state: "packet_ready",
      nextAction:
        "Review packet and complete the supported employer application",
    }),
  ];
}
export function planCoreOperation(input: unknown): DomainPlan {
  const request = parseCorePlanningInput(input);
  validateCoreObservation(
    request,
    request.allocation,
    request.read,
    request.phase,
  );
  if (request.phase === "baseline-archive-v1")
    return planObservedBaseline(request, corePlannerIdentity.sourceDigest);
  const definition = operationById(request.operationId);
  if (definition && "ownerOnly" in definition && definition.ownerOnly)
    ownerInteraction(request);
  const now = request.allocation.businessTime;
  switch (request.operationId) {
    case "job-stack.claim.add.v1": {
      const body = request.input.body,
        slot = slotFor(request, "claim");
      demand(slot.recordKind === "claim", "DOMAIN_ALLOCATION_MISMATCH");
      const sources = body.sourceIds.length
        ? currentSourceArtifacts(
            request.read,
            request.currentEvidence,
            body.sourceIds,
          ).map((s) => s.versionId)
        : [];
      return finishCorePlan(
        request,
        [
          createCandidate(
            request,
            "claim",
            {
              ...body,
              id: slot.entityId,
              status: "unverified",
              flags: inspectText(body.text),
            },
            sources,
          ),
        ],
        "claim",
      );
    }
    case "job-stack.claim.review.v1": {
      const body = request.input.body,
        record = currentRecord(request.read, "claim", body.id);
      demand(record.recordKind === "claim", "CLAIM_NOT_FOUND");
      revision(request, "claim", body.id, body.revision);
      const sources =
        body.status === "source_supported"
          ? currentSourceArtifacts(
              request.read,
              request.currentEvidence,
              record.body.sourceIds,
            ).map((s) => s.versionId)
          : record.body.sourceIds.map(
              (id) =>
                request.read.archiveSources?.find((a) => a.entityId === id)
                  ?.versionId ??
                committedBinding(request.read, "artifact", id).versionId,
            );
      const value = candidate(
        request,
        "claim",
        { ...record.body, status: body.status, permitted: body.permitted },
        sources,
        [
          generated(
            "current-owner-review",
            canonicalJson({
              format: "current-owner-review-v1",
              review: request.currentEvidence.ownerInteraction,
              inputDigest: coreInputDigest(request),
            }),
          ),
        ],
      );
      value.approval = {
        state:
          body.permitted &&
          ["source_supported", "user_confirmed"].includes(body.status)
            ? "approved"
            : "revoked",
        evidenceVersionIds: sources,
      };
      return finishCorePlan(request, [value], "claim");
    }
    case "job-stack.profile.conflict.resolve.v1": {
      const body = request.input.body,
        record = currentRecord(request.read, "question", body.questionId);
      demand(
        record.recordKind === "question" &&
          "type" in record.body &&
          record.body.type === "profile_conflict",
        "PROFILE_CONFLICT_REQUIRED",
      );
      const sources = [
        ...new Set(
          record.body.values.map(
            (v) =>
              request.read.archiveSources?.find(
                (a) => a.entityId === v.sourceId,
              )?.versionId ??
              committedBinding(request.read, "artifact", v.sourceId).versionId,
          ),
        ),
      ];
      return finishCorePlan(
        request,
        [
          candidate(
            request,
            "question",
            {
              ...record.body,
              status: "resolved",
              confirmedValue: body.value,
              reason: body.reason,
            },
            sources,
          ),
        ],
        "question",
      );
    }
    case "job-stack.opportunity.capture.v1": {
      const body = request.input.body,
        sourceKey = canonicalUrl(body.sourceUrl),
        slot = slotFor(request, "opportunity");
      const guard = request.read.sourceKeys.find(
        (s) => s.sourceKey === sourceKey,
      );
      demand(guard, "DOMAIN_SOURCE_KEY_GUARD_REQUIRED");
      if (guard.opportunityId !== null) {
        demand(
          slot.entityId === guard.opportunityId,
          "DOMAIN_SOURCE_KEY_TARGET_MISMATCH",
        );
        const old = opportunity(request, guard.opportunityId);
        return finishCorePlan(
          request,
          [candidate(request, "opportunity", old.body, [], [], true)],
          "opportunity",
          [{ sourceKey, opportunityId: old.entityId, mode: "same" }],
        );
      }
      const fit = assessFit(body.terms, currentTargeting(request)),
        flags = inspectText(
          body.description + " " + body.role + " " + body.company,
        );
      return finishCorePlan(
        request,
        [
          createCandidate(request, "opportunity", {
            ...body,
            sourceUrl: sourceKey,
            id: slot.entityId,
            fit,
            ranking: rankListing(
              body.description,
              body.role,
              body.terms.baseUsd,
              currentTargeting(request),
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
          }),
        ],
        "opportunity",
        [{ sourceKey, opportunityId: slot.entityId, mode: "insert" }],
        [additionalAudit(request, "opportunity", "opportunity.ingested")],
      );
    }
    case "job-stack.opportunity.assess.v1": {
      const body = request.input.body,
        old = opportunity(request, body.id),
        fit = assessFit(body.terms, currentTargeting(request));
      revision(request, "opportunity", body.id, body.revision);
      return finishCorePlan(
        request,
        [
          candidate(request, "opportunity", {
            ...old.body,
            terms: body.terms,
            fit,
            state: ["discovered", "researching", "qualified"].includes(
              old.body.state,
            )
              ? fit.status === "qualified"
                ? "qualified"
                : "researching"
              : old.body.state,
          }),
        ],
        "opportunity",
      );
    }
    case "job-stack.opportunity.transition.v1": {
      const body = request.input.body,
        old = opportunity(request, body.id);
      revision(request, "opportunity", body.id, body.revision);
      demand(
        !["submitted", "packet_ready", "offer"].includes(body.state),
        "USE_EVIDENCED_OPERATION",
      );
      if (["withdrawn", "declined"].includes(body.state))
        ownerInteraction(request);
      const state = transition({
        from: old.body.state,
        to: body.state,
        evidence: body.evidence,
        confirmed:
          body.confirmed && request.currentEvidence.ownerInteraction !== null,
      });
      return finishCorePlan(
        request,
        [
          candidate(request, "opportunity", {
            ...old.body,
            state,
            nextAction: body.evidence,
          }),
        ],
        "opportunity",
        [],
        [additionalAudit(request, "opportunity", "transition.evidence")],
      );
    }
    case "job-stack.packet.create.v1":
      return finishCorePlan(request, packetCandidates(request), "packet");
    case "job-stack.submission.record.v1": {
      const body = request.input.body,
        op = opportunity(request, body.opportunityId),
        config = currentRecord(request.read, "settings", "main");
      demand(
        config.recordKind === "settings" && config.body.profileResolved,
        "PROFILE_UNRESOLVED",
      );
      const conflicts = request.read.collections.find(
        (c) => c.kind === "unresolved_profile_conflicts",
      );
      demand(
        conflicts && conflicts.memberIds.length === 0,
        "PROFILE_CONFLICT_UNRESOLVED",
      );
      const packet = currentRecord(request.read, "packet", body.packetId);
      demand(
        packet.recordKind === "packet" &&
          packet.body.opportunityId === op.entityId,
        "PACKET_MISMATCH",
      );
      const binding = committedBinding(request.read, "packet", body.packetId);
      const claims = packet.body.claimIds.map((id) =>
        currentClaimEvidence(request.read, request.currentEvidence, id),
      );
      const pinned = request.read.packetEvidence?.find(
        (p) =>
          p.packetId === packet.entityId && p.versionId === binding.versionId,
      );
      demand(
        pinned &&
          pinned.text === claimEvidenceText(claims) &&
          claims.every((c) =>
            binding.sourceVersionIds.includes(c.binding.versionId),
          ),
        "STALE_PACKET_VERSION",
        409,
      );
      demand(
        createHash("sha256")
          .update(JSON.stringify(claims.map((c) => c.claim)))
          .digest("hex") === packet.body.claimDigest,
        "STALE_PACKET",
        409,
      );
      transition({
        from: op.body.state,
        to: "submitted",
        evidence: body.receipt,
        confirmed: true,
      });
      return finishCorePlan(
        request,
        [
          createCandidate(
            request,
            "attempt",
            body,
            [
              binding.versionId,
              ...claims.flatMap((c) => [
                c.binding.versionId,
                ...c.approval.sourceVersionIds,
              ]),
            ],
            [generated("current-claim-evidence", claimEvidenceText(claims))],
          ),
          candidate(request, "opportunity", {
            ...op.body,
            state: "submitted",
            nextAction: "Await recruiter response",
          }),
        ],
        "opportunity",
      );
    }
    case "job-stack.conversation.capture.v1": {
      const body = request.input.body;
      opportunity(request, body.opportunityId);
      const slot = slotFor(request, "thread"),
        flags = inspectText(body.message);
      return finishCorePlan(
        request,
        [
          createCandidate(request, "thread", {
            id: slot.entityId,
            opportunityId: body.opportunityId,
            recipient: body.recipient,
            subject: body.subject,
            messages: [{ text: body.message, at: now }],
            draft: "",
            status: flags.length ? "blocked" : "needs_reply",
            flags,
            nextAction: "Compose a recruiting reply",
            dueAt: now + 86400000,
          }),
        ],
        "thread",
      );
    }
    case "job-stack.conversation.associate.v1": {
      const body = request.input.body;
      opportunity(request, body.opportunityId);
      const question = currentRecord(request.read, "question", body.questionId);
      demand(
        question.recordKind === "question" &&
          "providerThreadId" in question.body,
        "MAIL_QUESTION_REQUIRED",
      );
      const mail = question.body,
        slot = slotFor(request, "thread"),
        existing = recordGuard(request.read, "thread", slot.entityId);
      if (existing.state === "present") {
        const old = currentRecord(request.read, "thread", slot.entityId);
        demand(
          old.recordKind === "thread" &&
            old.body.opportunityId === body.opportunityId &&
            old.body.providerThreadId === mail.providerThreadId &&
            mail.status === "associated" &&
            mail.threadId === slot.entityId,
          "THREAD_ASSOCIATION_MISMATCH",
        );
        return finishCorePlan(
          request,
          [candidate(request, "thread", old.body, [], [], true)],
          "thread",
        );
      }
      demand(
        mail.status === "unassociated" || mail.threadId === slot.entityId,
        "THREAD_ASSOCIATION_MISMATCH",
      );
      const { status: _status, threadId: _threadId, ...message } = mail;
      void _status;
      void _threadId;
      return finishCorePlan(
        request,
        [
          createCandidate(request, "thread", {
            id: slot.entityId,
            opportunityId: body.opportunityId,
            recipient: mail.recipient,
            subject: mail.subject,
            messages: [{ text: mail.preview, at: question.updatedAt }],
            draft: "",
            status: mail.flags.length ? "blocked" : "needs_reply",
            providerThreadId: mail.providerThreadId,
            ...(mail.replyMessageId === undefined
              ? {}
              : { replyMessageId: mail.replyMessageId }),
            flags: mail.flags,
            nextAction: "Compose recruiting reply",
            dueAt: now + 86400000,
          }),
          candidate(request, "question", {
            ...message,
            status: "associated",
            threadId: slot.entityId,
          }),
        ],
        "thread",
      );
    }
    case "job-stack.conversation.draft.save.v1": {
      const body = request.input.body,
        old = currentRecord(request.read, "thread", body.threadId);
      demand(old.recordKind === "thread", "THREAD_NOT_FOUND");
      revision(request, "thread", body.threadId, body.revision);
      demand(!inspectText(body.body).length, "DRAFT_REVIEW_REQUIRED");
      return finishCorePlan(
        request,
        [
          candidate(request, "thread", {
            ...old.body,
            draft: body.body,
            status: "draft",
          }),
        ],
        "thread",
      );
    }
    case "job-stack.interview.prepare.v1": {
      const interviewId = request.input.body.interviewId,
        interview = currentRecord(request.read, "interview", interviewId);
      demand(interview.recordKind === "interview", "INTERVIEW_NOT_FOUND");
      const op = opportunity(request, interview.body.opportunityId),
        old = recordGuard(request.read, "prep", interviewId);
      demand(
        slotFor(request, "prep").entityId === interviewId,
        "DOMAIN_ALLOCATION_MISMATCH",
      );
      if (old.state === "present")
        return finishCorePlan(
          request,
          [
            candidate(
              request,
              "prep",
              currentRecord(request.read, "prep", interviewId).body,
              [],
              [],
              true,
            ),
          ],
          "prep",
        );
      const selected = request.read.collections.find(
        (c) => c.kind === "all_claims",
      );
      demand(selected, "COMPLETE_CLAIM_COLLECTION_REQUIRED");
      const claims = [...selected.memberIds].sort().flatMap((id) => {
        const c = currentRecord(request.read, "claim", id);
        demand(c.recordKind === "claim", "CLAIM_NOT_FOUND");
        return c.body.permitted &&
          ["user_confirmed", "source_supported"].includes(c.body.status)
          ? [currentClaimEvidence(request.read, request.currentEvidence, id)]
          : [];
      });
      return finishCorePlan(
        request,
        [
          createCandidate(
            request,
            "prep",
            {
              interviewId,
              company: op.body.company,
              role: op.body.role,
              sourceUrl: op.body.sourceUrl,
              roleBrief: op.body.description,
              examples: claims.map((c) => ({
                claim: c.claim.text,
                sources: c.claim.sourceIds,
              })),
              questions: [
                "What outcomes define success in the first six months?",
                "How are technical decisions owned and reviewed?",
                "What recurring meetings and on-call responsibilities are expected?",
                ...op.body.fit.rationale
                  .filter((x) => x.endsWith("unknown"))
                  .map((x) => `Please clarify ${x.replace(": unknown", "")}.`),
              ],
              assumptions: [
                "Company information comes from the captured listing; independent research has not been verified.",
              ],
              createdAt: now,
            },
            [
              committedBinding(request.read, "interview", interviewId)
                .versionId,
              committedBinding(request.read, "opportunity", op.entityId)
                .versionId,
              ...claims.flatMap((c) => [
                c.binding.versionId,
                ...c.approval.sourceVersionIds,
              ]),
            ],
            [generated("current-claim-evidence", claimEvidenceText(claims))],
          ),
        ],
        "prep",
      );
    }
    case "job-stack.offer.record.v1": {
      const body = request.input.body,
        op = opportunity(request, body.opportunityId);
      transition({
        from: op.body.state,
        to: "offer",
        evidence: body.notes,
        confirmed: true,
      });
      return finishCorePlan(
        request,
        [
          createCandidate(request, "offer", {
            ...body,
            status: "recorded",
            recordedAt: now,
          }),
          candidate(request, "opportunity", {
            ...op.body,
            state: "offer",
            nextAction: "Review offer; acceptance is your decision",
          }),
        ],
        "offer",
      );
    }
    case "job-stack.settings.update.v1": {
      const { revision: expected, ...body } = request.input.body;
      demand(
        slotFor(request, "settings").entityId === "main",
        "DOMAIN_ALLOCATION_MISMATCH",
      );
      revision(request, "settings", "main", expected);
      demand(
        !body.sendingEnabled ||
          (body.sender && body.profileResolved && body.integrationVerified),
        "SENDING_PREREQUISITES",
      );
      return finishCorePlan(
        request,
        [candidate(request, "settings", body)],
        "settings",
      );
    }
  }
}
export type {
  CorePlanningInput,
  CoreObservation,
  CoreAllocation,
  CurrentDomainEvidence,
} from "./core-operation-input";
