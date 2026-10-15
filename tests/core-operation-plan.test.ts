import { describe, expect, it } from "vitest";
import { parseCorePlanningInput } from "../src/domain/core-operation-input";
import {
  claimEvidenceText,
  currentClaimEvidence,
} from "../src/domain/core-operation-evidence";
import { planCoreOperation } from "../src/domain/core-operation-plan";
import {
  claimBody,
  opportunityBody,
  present,
} from "./fixtures/domain-preparation";

import { packetRequest } from "./fixtures/core-operation";

describe("registered core-operation planner", () => {
  it("derives one deterministic packet and opportunity plan from current exact claim-version permission", () => {
    const request = packetRequest();
    const before = JSON.stringify(request);
    const result = planCoreOperation(request);
    expect(result.candidates.map((c) => c.snapshot.recordKind)).toEqual([
      "packet",
      "opportunity",
    ]);
    expect(result.mutations).toEqual([
      { candidateRole: "packet", mode: "insert" },
      { candidateRole: "opportunity", mode: "update" },
    ]);
    expect(result.candidates[0]?.sourceVersionIds).toContain("claim-version-1");
    expect(result.audit.map((a) => a.operation)).toEqual([
      "packet.created",
      "opportunity.updated",
    ]);
    expect(result.resultRecord).toEqual({
      candidateRole: "packet",
      recordKind: "packet",
      entityId: "packet-1",
      revision: 1,
    });
    expect(planCoreOperation(request)).toEqual(result);
    expect(JSON.stringify(request)).toBe(before);
  });
  it("denies a status-shaped claim without current version-bound permission", () => {
    const request = packetRequest();
    request.currentEvidence.claims = [];
    expect(() => planCoreOperation(request)).toThrow(
      "CURRENT_CLAIM_PERMISSION_REQUIRED",
    );
  });
});

function operationRequest(
  operationId: string,
  body: unknown,
  rows: ReturnType<typeof present>[],
  slots: { role: string; recordKind: string; entityId: string }[],
) {
  const base = packetRequest();
  return parseCorePlanningInput({
    ...base,
    operationId,
    input: {
      workspaceId: base.input.workspaceId,
      requestKey: "request-matrix",
      body,
    },
    allocation: {
      ...base.allocation,
      records: slots.map((s) => ({
        ...s,
        lineageId: `lineage-${s.entityId}`,
        auditEventId: `audit-${s.role}`,
        transitionAuditEventId: `transition-${s.role}`,
        ingestAuditEventId: `ingest-${s.role}`,
      })),
    },
    read: {
      records: [
        ...rows,
        ...([
          "job-stack.opportunity.capture.v1",
          "job-stack.opportunity.assess.v1",
        ].includes(operationId) &&
        !rows.some(
          (row) => row.recordKind === "settings" && row.entityId === "main",
        )
          ? [{ recordKind: "settings", entityId: "main", state: "absent" }]
          : []),
        ...slots
          .filter(
            (s) =>
              !rows.some(
                (r) =>
                  r.recordKind === s.recordKind && r.entityId === s.entityId,
              ),
          )
          .map((s) => ({
            recordKind: s.recordKind,
            entityId: s.entityId,
            state: "absent",
          })),
      ],
      sourceKeys: [],
      collections: [],
      bindings: rows.map((r) => ({
        recordKind: r.recordKind,
        entityId: r.entityId,
        lineageId: `lineage-${r.entityId}`,
        versionId: `version-${r.entityId}`,
        heads: [`version-${r.entityId}`],
        revision: r.revision,
        sourceVersionIds: [],
      })),
    },
    currentEvidence: {
      ...base.currentEvidence,
      ownerInteraction: { id: "owner-review", revision: 1 },
      claims: base.currentEvidence.claims.map((a) => ({
        ...a,
        versionId: "version-claim-1",
      })),
    },
  });
}
const thread = {
  id: "thread-1",
  opportunityId: opportunityBody.id,
  recipient: "recruiter@example.com",
  subject: "Role",
  messages: [{ text: "Hello", at: 100 }],
  draft: "",
  status: "needs_reply",
  flags: [],
  nextAction: "Compose recruiting reply",
  dueAt: 10000,
};
const profileQuestion = {
  type: "profile_conflict",
  field: "phone",
  values: [],
  status: "unresolved",
  nextAction: "Resolve profile",
};
const interview = {
  id: "interview-1",
  opportunityId: opportunityBody.id,
  threadId: thread.id,
  start: 10000,
  end: 20000,
  title: "Interview",
  attendee: thread.recipient,
  eventId: "event-1",
  status: "scheduled",
  calendarId: "calendar-1",
};
const settings = {
  discoveryEnabled: false,
  correspondenceEnabled: false,
  remindersEnabled: true,
  sendingEnabled: false,
  profileResolved: true,
  integrationVerified: false,
  sender: null,
  notificationEmail: null,
  calendarId: null,
  interviewWindows: [],
  approvedRecipients: [],
  boards: [],
};
const matrix = [
  {
    id: "job-stack.claim.add.v1",
    body: {
      field: "experience",
      text: "Built services",
      permitted: true,
      sourceIds: [],
    },
    rows: [],
    slots: [{ role: "claim", recordKind: "claim", entityId: "new-claim" }],
    kinds: ["claim"],
    result: "new-claim",
  },
  {
    id: "job-stack.claim.review.v1",
    body: {
      id: claimBody.id,
      revision: 1,
      status: "disputed",
      permitted: false,
    },
    rows: [present("claim", claimBody.id, claimBody)],
    slots: [{ role: "claim", recordKind: "claim", entityId: claimBody.id }],
    kinds: ["claim"],
    result: claimBody.id,
  },
  {
    id: "job-stack.profile.conflict.resolve.v1",
    body: { questionId: "question-1", value: "123", reason: "Owner confirmed" },
    rows: [present("question", "question-1", profileQuestion)],
    slots: [
      { role: "question", recordKind: "question", entityId: "question-1" },
    ],
    kinds: ["question"],
    result: "question-1",
  },
  {
    id: "job-stack.opportunity.capture.v1",
    body: {
      company: opportunityBody.company,
      role: opportunityBody.role,
      sourceUrl: opportunityBody.sourceUrl,
      description: opportunityBody.description,
      terms: opportunityBody.terms,
    },
    rows: [],
    slots: [
      {
        role: "opportunity",
        recordKind: "opportunity",
        entityId: "new-opportunity",
      },
    ],
    kinds: ["opportunity"],
    result: "new-opportunity",
  },
  {
    id: "job-stack.opportunity.assess.v1",
    body: { id: opportunityBody.id, revision: 1, terms: opportunityBody.terms },
    rows: [present("opportunity", opportunityBody.id, opportunityBody)],
    slots: [
      {
        role: "opportunity",
        recordKind: "opportunity",
        entityId: opportunityBody.id,
      },
    ],
    kinds: ["opportunity"],
    result: opportunityBody.id,
  },
  {
    id: "job-stack.opportunity.transition.v1",
    body: {
      id: opportunityBody.id,
      revision: 1,
      state: "declined",
      evidence: "Owner declined",
      confirmed: true,
    },
    rows: [present("opportunity", opportunityBody.id, opportunityBody)],
    slots: [
      {
        role: "opportunity",
        recordKind: "opportunity",
        entityId: opportunityBody.id,
      },
    ],
    kinds: ["opportunity"],
    result: opportunityBody.id,
  },
  {
    id: "job-stack.conversation.capture.v1",
    body: {
      opportunityId: opportunityBody.id,
      recipient: thread.recipient,
      subject: "Role",
      message: "Hello",
    },
    rows: [present("opportunity", opportunityBody.id, opportunityBody)],
    slots: [{ role: "thread", recordKind: "thread", entityId: thread.id }],
    kinds: ["thread"],
    result: thread.id,
  },
  {
    id: "job-stack.conversation.associate.v1",
    body: { opportunityId: opportunityBody.id, questionId: "mail-1" },
    rows: [
      present("opportunity", opportunityBody.id, opportunityBody),
      present("question", "mail-1", {
        providerThreadId: "provider-exact-long:@",
        recipient: thread.recipient,
        subject: "Role",
        preview: "Hello",
        flags: [],
        status: "unassociated",
      }),
    ],
    slots: [
      { role: "thread", recordKind: "thread", entityId: thread.id },
      { role: "question", recordKind: "question", entityId: "mail-1" },
    ],
    kinds: ["thread", "question"],
    result: thread.id,
  },
  {
    id: "job-stack.conversation.draft.save.v1",
    body: { threadId: thread.id, revision: 1, body: "A private reply" },
    rows: [present("thread", thread.id, thread)],
    slots: [{ role: "thread", recordKind: "thread", entityId: thread.id }],
    kinds: ["thread"],
    result: thread.id,
  },
  {
    id: "job-stack.interview.prepare.v1",
    body: { interviewId: interview.id },
    rows: [
      present("interview", interview.id, interview),
      present("opportunity", opportunityBody.id, opportunityBody),
      present("claim", claimBody.id, claimBody),
    ],
    slots: [{ role: "prep", recordKind: "prep", entityId: interview.id }],
    kinds: ["prep"],
    result: interview.id,
  },
  {
    id: "job-stack.offer.record.v1",
    body: {
      opportunityId: opportunityBody.id,
      baseUsd: 240000,
      bonusUsd: 0,
      equityUsd: 0,
      equityType: "none",
      notes: "Supplied written offer",
    },
    rows: [
      present("opportunity", opportunityBody.id, {
        ...opportunityBody,
        state: "interviewing",
      }),
    ],
    slots: [
      { role: "offer", recordKind: "offer", entityId: "offer-1" },
      {
        role: "opportunity",
        recordKind: "opportunity",
        entityId: opportunityBody.id,
      },
    ],
    kinds: ["offer", "opportunity"],
    result: "offer-1",
  },
  {
    id: "job-stack.settings.update.v1",
    body: { ...settings, revision: 0 },
    rows: [],
    slots: [{ role: "settings", recordKind: "settings", entityId: "main" }],
    kinds: ["settings"],
    result: "main",
  },
];
it.each(matrix)(
  "derives registered $id with exact companion and result mapping",
  (scenario) => {
    const request = operationRequest(
      scenario.id,
      scenario.body,
      scenario.rows,
      scenario.slots,
    );
    if (scenario.id === "job-stack.opportunity.capture.v1")
      request.read.sourceKeys = [
        { sourceKey: opportunityBody.sourceUrl, opportunityId: null },
      ];
    if (scenario.id === "job-stack.interview.prepare.v1")
      request.read.collections = [
        { kind: "all_claims", memberIds: [claimBody.id] },
      ];
    const result = planCoreOperation(request);
    expect(result.candidates.map((c) => c.snapshot.recordKind)).toEqual(
      scenario.kinds,
    );
    expect(result.resultRecord.entityId).toBe(scenario.result);
    expect(result.audit.length).toBe(
      [
        "job-stack.opportunity.transition.v1",
        "job-stack.opportunity.capture.v1",
      ].includes(scenario.id)
        ? 2
        : scenario.kinds.length,
    );
    expect(planCoreOperation(request)).toEqual(result);
  },
);

function submissionRequest() {
  const packet = planCoreOperation(packetRequest()).candidates[0];
  if (!packet || packet.snapshot.recordKind !== "packet")
    throw Error("FIXTURE");
  const request = operationRequest(
    "job-stack.submission.record.v1",
    {
      opportunityId: opportunityBody.id,
      packetId: "packet-1",
      receipt: "Supplied receipt",
      submittedAt: 900,
      confirmed: true,
    },
    [
      present("opportunity", opportunityBody.id, {
        ...opportunityBody,
        state: "packet_ready",
      }),
      present("packet", "packet-1", packet.snapshot.body),
      present("settings", "main", settings),
      present("claim", claimBody.id, claimBody),
    ],
    [
      { role: "attempt", recordKind: "attempt", entityId: "attempt-1" },
      {
        role: "opportunity",
        recordKind: "opportunity",
        entityId: opportunityBody.id,
      },
    ],
  );
  request.read.collections = [
    { kind: "unresolved_profile_conflicts", memberIds: [] },
  ];
  const packetBinding = request.read.bindings.find(
    (b) => b.entityId === "packet-1",
  );
  if (!packetBinding || !packetBinding.versionId) throw Error("FIXTURE");
  packetBinding.sourceVersionIds = ["version-claim-1"];
  request.read.packetEvidence = [
    {
      packetId: "packet-1",
      versionId: packetBinding.versionId,
      text: claimEvidenceText([
        currentClaimEvidence(
          request.read,
          request.currentEvidence,
          claimBody.id,
        ),
      ]),
    },
  ];
  return request;
}
it("records supplied submission evidence with attempt and opportunity in one plan and exact current packet sources", () => {
  const request = submissionRequest(),
    result = planCoreOperation(request);
  expect(result.candidates.map((c) => c.snapshot.recordKind)).toEqual([
    "attempt",
    "opportunity",
  ]);
  expect(result.resultRecord.entityId).toBe(opportunityBody.id);
  expect(result.candidates[0]?.snapshot.body).toEqual(request.input.body);
});

it("denies surplus rows that were never selected by the registered operation", () => {
  const request = packetRequest();
  request.read.records.push({
    ...present("claim", "unselected-claim", {
      ...claimBody,
      id: "unselected-claim",
    }),
    recordKind: "claim",
  });
  expect(() => planCoreOperation(request)).toThrow("UNSELECTED_DOMAIN_READ");
});
it("denies a complete collection with an omitted membership guard", () => {
  const scenario = matrix.find(
    (s) => s.id === "job-stack.interview.prepare.v1",
  );
  if (!scenario) throw Error("FIXTURE");
  const request = operationRequest(
    scenario.id,
    scenario.body,
    scenario.rows,
    scenario.slots,
  );
  request.read.collections = [
    { kind: "all_claims", memberIds: [claimBody.id, "omitted-claim"] },
  ];
  expect(() => planCoreOperation(request)).toThrow(
    "DOMAIN_SELECTION_INCOMPLETE",
  );
});

it("denies an injected prepared packet-evidence row unrelated to the operation", () => {
  const request = packetRequest();
  request.read.packetEvidence = [
    { packetId: "other-packet", versionId: "foreign-version", text: "{}" },
  ];
  expect(() => planCoreOperation(request)).toThrow(
    "UNSELECTED_PACKET_EVIDENCE",
  );
});
it("denies a duplicated live approval rather than choosing one by array order", () => {
  const request = packetRequest();
  const first = request.currentEvidence.claims[0];
  if (!first) throw Error("FIXTURE");
  request.currentEvidence.claims.push({ ...first, approvalRevision: 2 });
  expect(() => planCoreOperation(request)).toThrow(
    "DUPLICATE_CURRENT_EVIDENCE",
  );
});
it("pins source-only opportunity content into generated packet support", () => {
  const plan = planCoreOperation(packetRequest());
  expect(plan.candidates[0]?.sourceVersionIds).toContain(
    "opportunity-version-1",
  );
});
it.each(["expired", "different-version", "different-revision"])(
  "denies %s current claim permission",
  (variant) => {
    const request = packetRequest(),
      approval = request.currentEvidence.claims[0];
    if (!approval) throw Error("FIXTURE");
    if (variant === "expired") approval.expiresAt = 1000;
    if (variant === "different-version")
      approval.versionId = "later-claim-version";
    if (variant === "different-revision") approval.revision = 2;
    expect(() => planCoreOperation(request)).toThrow(
      "CURRENT_CLAIM_PERMISSION_REQUIRED",
    );
  },
);
it("never calls clock or randomness while deriving the deterministic plan", async () => {
  const { vi } = await import("vitest");
  const now = vi.spyOn(Date, "now").mockImplementation(() => {
    throw Error("CLOCK");
  });
  const random = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    throw Error("RANDOM");
  });
  try {
    expect(planCoreOperation(packetRequest()).candidates).toHaveLength(2);
  } finally {
    now.mockRestore();
    random.mockRestore();
  }
});

it("identifies the actual maintained planner graph rather than a fixture digest", async () => {
  const { readFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const plan = planCoreOperation(packetRequest());
  expect(plan.planner.sourceDigest).not.toBe("0".repeat(64));
  const manifest = JSON.parse(
    readFileSync("integration/core-planner-source.json", "utf8"),
  );
  expect(manifest.sourceDigest).toBe(plan.planner.sourceDigest);
  expect(
    manifest.files.some(
      (f: { path: string }) => f.path === "src/domain/core-operation-plan.ts",
    ),
  ).toBe(true);
  expect(
    manifest.files.some(
      (f: { path: string }) =>
        f.path === "src/domain/core-operation-identity.ts",
    ),
  ).toBe(false);
  expect(() =>
    execFileSync("node", [
      "scripts/generate-core-planner-identity.mjs",
      "--check",
    ]),
  ).not.toThrow();
});

function matrixRequest(operationId: string) {
  const scenario = matrix.find((s) => s.id === operationId);
  if (!scenario) throw Error("FIXTURE");
  const request = operationRequest(
    scenario.id,
    scenario.body,
    scenario.rows,
    scenario.slots,
  );
  if (scenario.id === "job-stack.opportunity.capture.v1")
    request.read.sourceKeys = [
      { sourceKey: opportunityBody.sourceUrl, opportunityId: null },
    ];
  if (scenario.id === "job-stack.interview.prepare.v1")
    request.read.collections = [
      { kind: "all_claims", memberIds: [claimBody.id] },
    ];
  return request;
}
it.each([
  ["job-stack.claim.add.v1", "claim"],
  ["job-stack.conversation.capture.v1", "thread"],
  ["job-stack.offer.record.v1", "offer"],
  ["job-stack.opportunity.capture.v1", "opportunity"],
  ["job-stack.packet.create.v1", "packet"],
  ["job-stack.submission.record.v1", "attempt"],
])(
  "rejects existing allocated create-only target for %s/%s",
  (operationId, role) => {
    const request =
      operationId === "job-stack.packet.create.v1"
        ? packetRequest()
        : operationId === "job-stack.submission.record.v1"
          ? submissionRequest()
          : matrixRequest(operationId);
    const generated = planCoreOperation(request).candidates.find(
      (c) => c.role === role,
    );
    if (!generated) throw Error("FIXTURE");
    request.read.records = request.read.records.map((g) =>
      g.entityId === generated.snapshot.entityId &&
      g.recordKind === generated.snapshot.recordKind
        ? {
            ...g,
            state: "present",
            rawBody: JSON.stringify(generated.snapshot.body),
            revision: 1,
            updatedAt: 1000,
          }
        : g,
    );
    request.read.bindings.push({
      recordKind: generated.snapshot.recordKind,
      entityId: generated.snapshot.entityId,
      lineageId: generated.lineageId,
      versionId: "existing-target-version",
      heads: ["existing-target-version"],
      revision: 1,
      sourceVersionIds: [],
    });
    const before = JSON.stringify(request);
    expect(() => planCoreOperation(request)).toThrow(
      "DOMAIN_CREATE_TARGET_EXISTS",
    );
    expect(JSON.stringify(request)).toBe(before);
  },
);
it.each(
  (
    [
      ["job-stack.conversation.capture.v1", "opportunity"],
      ["job-stack.conversation.associate.v1", "opportunity"],
      ["job-stack.interview.prepare.v1", "interview"],
      ["job-stack.submission.record.v1", "settings"],
      ["job-stack.profile.conflict.resolve.v1", "question"],
    ] as const
  ).flatMap(([operationId, kind]) =>
    ["null", "revision", "head"].map((invalid) => ({
      operationId,
      kind,
      invalid,
    })),
  ),
)(
  "rejects every selected present $kind binding $invalid for $operationId",
  ({ operationId, kind, invalid }) => {
    const request =
      operationId === "job-stack.submission.record.v1"
        ? submissionRequest()
        : matrixRequest(operationId);
    const binding = request.read.bindings.find((b) => b.recordKind === kind);
    if (!binding) throw Error("FIXTURE");
    if (invalid === "null") {
      binding.versionId = null;
      binding.heads = [];
    } else if (invalid === "revision") binding.revision = 9;
    else binding.heads = ["different-version"];
    expect(() => planCoreOperation(request)).toThrow(
      "COMMITTED_DOMAIN_BINDING_REQUIRED",
    );
  },
);
it("validates committed source-only bindings while other selected rows need a baseline", () => {
  const request = matrixRequest("job-stack.conversation.associate.v1"),
    question = request.read.bindings.find((b) => b.recordKind === "question"),
    opportunity = request.read.bindings.find(
      (b) => b.recordKind === "opportunity",
    );
  if (!question || !opportunity) throw Error("FIXTURE");
  question.versionId = null;
  question.heads = [];
  opportunity.heads = ["different-version"];
  expect(() =>
    planCoreOperation({
      ...request,
      phase: "baseline-archive-v1",
      baseline: { requestKey: "internal-mixed", originals: [], migrations: [] },
    }),
  ).toThrow("COMMITTED_DOMAIN_BINDING_REQUIRED");
});

it("preserves existing interview prep through the deliberate preserve path", () => {
  const request = matrixRequest("job-stack.interview.prepare.v1"),
    prep = planCoreOperation(request).candidates[0];
  if (!prep) throw Error("FIXTURE");
  request.read.records = request.read.records.map((g) =>
    g.recordKind === "prep"
      ? {
          ...g,
          state: "present",
          rawBody: JSON.stringify(prep.snapshot.body),
          revision: 1,
          updatedAt: 100,
        }
      : g,
  );
  request.read.bindings.push({
    recordKind: "prep",
    entityId: prep.snapshot.entityId,
    lineageId: prep.lineageId,
    versionId: "existing-prep",
    heads: ["existing-prep"],
    revision: 1,
    sourceVersionIds: [],
  });
  const result = planCoreOperation(request);
  expect(result.mutations).toEqual([
    { candidateRole: "prep", mode: "preserve" },
  ]);
  expect(result.candidates[0]?.snapshot.revision).toBe(1);
  expect(result.audit).toEqual([]);
});

import { targeting } from "./fixtures/targeting";
it("uses only checked current settings targeting and keeps absence unconfigured", () => {
  const scenario = matrix.find(
    (entry) => entry.id === "job-stack.opportunity.capture.v1",
  );
  if (!scenario) throw Error("FIXTURE");
  const request = operationRequest(
    scenario.id,
    scenario.body,
    [],
    scenario.slots,
  );
  request.read.sourceKeys = [
    { sourceKey: opportunityBody.sourceUrl, opportunityId: null },
  ];
  const unknown = planCoreOperation(request).candidates[0]?.snapshot;
  expect(unknown?.recordKind).toBe("opportunity");
  if (!unknown || unknown.recordKind !== "opportunity") throw Error("FIXTURE");
  expect(unknown.body.fit.status).toBe("researching");
  const configured = operationRequest(
    scenario.id,
    scenario.body,
    [present("settings", "main", { ...settings, targetingProfile: targeting })],
    scenario.slots,
  );
  configured.read.sourceKeys = request.read.sourceKeys;
  const result = planCoreOperation(configured).candidates[0]?.snapshot;
  if (!result || result.recordKind !== "opportunity") throw Error("FIXTURE");
  expect(result.body.fit.status).toBe("qualified");
  const changed = structuredClone(configured);
  const guard = changed.read.records.find(
    (row) => row.recordKind === "settings",
  );
  if (!guard || guard.state !== "present") throw Error("FIXTURE");
  const body = JSON.parse(guard.rawBody);
  body.targetingProfile.baseFloorUsd = -1;
  guard.rawBody = JSON.stringify(body);
  expect(() => planCoreOperation(changed)).toThrow();
});
