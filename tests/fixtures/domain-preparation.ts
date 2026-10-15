import type {
  AuthenticatedRecoveryContext,
  VersionManifest,
} from "../../src/domain/recovery";
import { recoveryKindForRecord } from "../../src/domain/recovery-record";
import type { DomainPlan } from "../../src/domain/recovery-domain-plan";
import { parseDomainPlan } from "../../src/domain/recovery-domain-plan";
import type { PrimaryArchive } from "../../src/application/recovery-ports";
import { primaryContext, preparationFixture } from "./primary-preparation";
import { buildPacket } from "../../src/domain/rules";

export const domainWorkspace = primaryContext.workspace;
export const domainActor = primaryContext.actor.id;
export const claimBody = {
  id: "claim-1",
  field: "experience",
  text: "Built reliable services",
  status: "user_confirmed" as const,
  permitted: true,
  sourceIds: [],
};
export const opportunityBody = {
  id: "opportunity-1",
  company: "Example",
  role: "Staff Engineer",
  sourceUrl: "https://example.com/job",
  description: "Build reliable systems",
  terms: {
    employment: "full_time" as const,
    baseUsd: 240000,
    hourlyUsd: null,
    remote: true,
    match401k: true,
    zeroPremium: true,
    affordableCare: true,
  },
  state: "qualified" as const,
  flags: [],
  fit: { status: "qualified" as const, rationale: [] },
  nextAction: "Prepare packet",
  dueAt: null,
  createdAt: 100,
  lastSeenAt: 100,
};
export function snapshot(
  recordKind: string,
  entityId: string,
  revision: number,
  body: unknown,
  updatedAt = 1000,
) {
  return {
    formatVersion: 1 as const,
    type: "domain_record" as const,
    recordKind,
    entityId,
    revision,
    updatedAt,
    body,
  };
}
export function present(
  recordKind: string,
  entityId: string,
  body: unknown,
  revision = 1,
  updatedAt = 100,
) {
  return {
    recordKind,
    entityId,
    state: "present" as const,
    rawBody: JSON.stringify(body),
    revision,
    updatedAt,
  };
}
export function packetPlan() {
  const packet = buildPacket({
    claims: [claimBody],
    claimIds: [claimBody.id],
    role: opportunityBody.role,
    company: opportunityBody.company,
  });
  const body = {
    ...packet,
    id: "packet-1",
    opportunityId: opportunityBody.id,
    claimIds: [claimBody.id],
    claimDigest: "a".repeat(64),
    artifactKey: "owner/packets/packet-1.json",
    createdAt: 1000,
  };
  const snapshots = [
    snapshot("packet", body.id, 1, body),
    snapshot("opportunity", opportunityBody.id, 2, {
      ...opportunityBody,
      state: "packet_ready",
      nextAction:
        "Review packet and complete the supported employer application",
    }),
  ];
  return parseDomainPlan({
    format: "domain-plan-v1" as const,
    phase: "mutation" as const,
    operationId: "job-stack.packet.create.v1",
    inputDigest: "b".repeat(64),
    planner: { version: 1 as const, sourceDigest: "c".repeat(64) },
    workspace: domainWorkspace,
    actorId: domainActor,
    requestRootId: "root-packet",
    requestKey: "request-packet",
    readSet: {
      records: [
        {
          recordKind: "packet",
          entityId: "packet-1",
          state: "absent" as const,
        },
        present("opportunity", opportunityBody.id, opportunityBody),
        present("claim", claimBody.id, claimBody),
      ],
      collections: [],
      sourceKeys: [],
    },
    mutations: [
      { candidateRole: "packet", mode: "insert" as const },
      { candidateRole: "opportunity", mode: "update" as const },
    ],
    candidates: snapshots.map((record, index) => ({
      role: index === 0 ? "packet" : "opportunity",
      lineageId: `lineage-${record.entityId}`,
      snapshot: record,
      parentVersionIds: [],
      sourceVersionIds: [],
      artifacts:
        index === 0
          ? [
              {
                role: "generated-packet",
                source: {
                  type: "utf8" as const,
                  text: JSON.stringify(packet),
                  mediaType: "application/json",
                },
              },
            ]
          : [],
      approval: { state: "draft" as const, evidenceVersionIds: [] },
    })),
    sourceKeys: [],
    audit: snapshots.map((record, index) => ({
      eventId: `audit-${record.entityId}`,
      actorId: domainActor,
      operation: index === 0 ? "packet.created" : "opportunity.updated",
      entityId: record.entityId,
      decision: "allow" as const,
      createdAt: 1000,
    })),
    resultRecord: {
      candidateRole: "packet",
      recordKind: "packet",
      entityId: "packet-1",
      revision: 1,
    },
  });
}
export async function domainFixture(
  archive?: PrimaryArchive,
  plan: DomainPlan = packetPlan(),
  context: AuthenticatedRecoveryContext = primaryContext,
) {
  const fixture = await preparationFixture();
  const primary = plan.candidates.find(
    (c) => c.role === plan.resultRecord.candidateRole,
  );
  if (!primary) throw Error("FIXTURE_PRIMARY_MISSING");
  const input = {
    requestKey: plan.requestKey,
    lineageId: primary.lineageId,
    entityId: primary.snapshot.entityId,
    kind: recoveryKindForRecord[primary.snapshot.recordKind],
    expectedParentIds: primary.parentVersionIds,
    branchRequested: false,
    sourceVersionIds: primary.sourceVersionIds,
    content: primary.snapshot,
  };
  const parents: VersionManifest[] = [];
  const sources: VersionManifest[] = [];
  const accepted = {
    format: "bound-primary-v1" as const,
    input,
    context,
    now: context.serverTime,
    currentChain: context.chain,
    currentHeads: [],
    transactionId: `transaction-${plan.requestRootId}`,
    versionId: `version-${primary.role}`,
    namespace: `recovery-${plan.requestRootId}`,
    parents,
    sources,
    domainPlan: {
      plan,
      candidateVersions: plan.candidates.map((c) => ({
        role: c.role,
        versionId: `version-${c.role}`,
      })),
      currentHeads: plan.candidates.map((c) => ({
        role: c.role,
        versionIds: c.parentVersionIds,
      })),
    },
  };
  const authority = {
    async accept() {
      return accepted;
    },
    async resolveAccepted() {
      return accepted;
    },
  };
  return {
    ...fixture,
    archive: archive ?? fixture.archive,
    authority,
    accepted,
    input,
    context,
  };
}

export function companionPlan(
  kind: "offer" | "attempt" | "thread",
): DomainPlan {
  const base = packetPlan();
  const op = {
    ...opportunityBody,
    state: kind === "offer" ? "interviewing" : "packet_ready",
  };
  let firstBody: unknown,
    secondBody: unknown,
    firstKind: string,
    secondKind: string,
    secondId: string,
    secondGuard: unknown;
  if (kind === "offer") {
    firstKind = "offer";
    firstBody = {
      opportunityId: op.id,
      baseUsd: 240000,
      bonusUsd: 20000,
      equityUsd: 0,
      equityType: "none",
      notes: "Supplied written offer",
      status: "recorded",
      recordedAt: 1000,
    };
    secondKind = "opportunity";
    secondId = op.id;
    secondBody = {
      ...op,
      state: "offer",
      nextAction: "Review offer; acceptance is your decision",
    };
    secondGuard = present("opportunity", op.id, op);
  } else if (kind === "attempt") {
    firstKind = "attempt";
    firstBody = {
      opportunityId: op.id,
      packetId: "packet-1",
      receipt: "Supplied application receipt",
      submittedAt: 900,
      confirmed: true,
    };
    secondKind = "opportunity";
    secondId = op.id;
    secondBody = {
      ...op,
      state: "submitted",
      nextAction: "Await recruiter response",
    };
    secondGuard = present("opportunity", op.id, op);
  } else {
    firstKind = "thread";
    firstBody = {
      id: "thread-1",
      opportunityId: op.id,
      recipient: "recruiter@example.com",
      subject: "Interview",
      messages: [{ text: "Supplied recruiting reply", at: 100 }],
      draft: "",
      status: "needs_reply",
      providerThreadId: "provider-thread",
      flags: [],
      nextAction: "Compose recruiting reply",
      dueAt: 86401000,
    };
    secondKind = "question";
    secondId = "question-1";
    const question = {
      providerThreadId: "provider-thread",
      recipient: "recruiter@example.com",
      subject: "Interview",
      preview: "Supplied recruiting reply",
      flags: [],
      status: "unassociated",
    };
    secondBody = { ...question, status: "associated", threadId: "thread-1" };
    secondGuard = present("question", secondId, question);
  }
  const firstId = `${firstKind}-1`;
  const records = [
    snapshot(firstKind, firstId, 1, firstBody),
    snapshot(secondKind, secondId, 2, secondBody),
  ];
  return parseDomainPlan({
    ...base,
    operationId:
      kind === "offer"
        ? "job-stack.offer.record.v1"
        : kind === "attempt"
          ? "job-stack.submission.record.v1"
          : "job-stack.conversation.associate.v1",
    requestRootId: `root-${kind}`,
    requestKey: `request-${kind}`,
    readSet: {
      records: [
        { recordKind: firstKind, entityId: firstId, state: "absent" },
        secondGuard,
        ...(kind === "thread" ? [present("opportunity", op.id, op)] : []),
      ],
      collections: [],
      sourceKeys: [],
    },
    mutations: records.map((r, i) => ({
      candidateRole: r.recordKind,
      mode: i === 0 ? "insert" : "update",
    })),
    candidates: records.map((r) => ({
      role: r.recordKind,
      lineageId: `lineage-${r.entityId}`,
      snapshot: r,
      parentVersionIds: [],
      sourceVersionIds: [],
      artifacts: [],
      approval: { state: "draft", evidenceVersionIds: [] },
    })),
    audit: records.map((r, i) => ({
      eventId: `audit-${r.entityId}`,
      actorId: domainActor,
      operation: `${r.recordKind}.${i === 0 ? "created" : "updated"}`,
      entityId: r.entityId,
      decision: "allow",
      createdAt: 1000,
    })),
    resultRecord:
      kind === "attempt"
        ? {
            candidateRole: "opportunity",
            recordKind: "opportunity",
            entityId: op.id,
            revision: 2,
          }
        : {
            candidateRole: firstKind,
            recordKind: firstKind,
            entityId: firstId,
            revision: 1,
          },
  });
}
export function baselinePlan(rawBody = JSON.stringify(claimBody)): DomainPlan {
  const base = packetPlan();
  const record = snapshot("claim", claimBody.id, 7, JSON.parse(rawBody), 90);
  return parseDomainPlan({
    ...base,
    phase: "baseline-archive-v1",
    requestRootId: "root-baseline",
    requestKey: "request-baseline",
    readSet: {
      records: [
        { ...present("claim", claimBody.id, record.body, 7, 90), rawBody },
      ],
      collections: [],
      sourceKeys: [],
    },
    mutations: [],
    candidates: [
      {
        role: "claim",
        lineageId: "lineage-claim-1",
        snapshot: record,
        parentVersionIds: [],
        sourceVersionIds: [],
        artifacts: [
          {
            role: "legacy-json",
            source: {
              type: "legacy_body",
              recordKind: "claim",
              entityId: claimBody.id,
            },
          },
        ],
        approval: { state: "unverified", evidenceVersionIds: [] },
        observation: {
          kind: "legacy_baseline",
          originalArtifact: "not_applicable",
          originalLocator: null,
          approvalProvenance: "inert_observed",
        },
      },
    ],
    sourceKeys: [],
    audit: [],
    resultRecord: {
      candidateRole: "claim",
      recordKind: "claim",
      entityId: claimBody.id,
      revision: 7,
    },
  });
}
