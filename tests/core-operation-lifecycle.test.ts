import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planCoreOperation } from "../src/domain/core-operation-plan";
import {
  parseCorePlanningInput,
  parseDomainOperation,
  presentGuard,
  coreInputDigest,
} from "../src/domain/core-operation-input";
import { domainRequestDigest } from "../src/domain/recovery-domain-plan";
import {
  runCoreOperation,
  type CoreLifecyclePorts,
} from "../src/application/core-operation-lifecycle";
import { packetRequest } from "./fixtures/core-operation";
import { claimBody, present } from "./fixtures/domain-preparation";

function legacyReview() {
  const base = packetRequest(),
    rawBody =
      '{ "id":"claim-1", "field":"experience", "text":"Built \\u0073ervices", "status":"user_confirmed", "permitted":true, "sourceIds":[] }';
  const result = parseCorePlanningInput({
    ...base,
    operationId: "job-stack.claim.review.v1",
    input: {
      workspaceId: base.input.workspaceId,
      requestKey: "public-review",
      body: {
        id: claimBody.id,
        revision: 7,
        status: "disputed",
        permitted: false,
      },
    },
    allocation: {
      ...base.allocation,
      records: [
        {
          role: "claim",
          recordKind: "claim",
          entityId: claimBody.id,
          lineageId: "lineage-claim-1",
          auditEventId: "audit-review",
        },
      ],
    },
    read: {
      records: [
        { ...present("claim", claimBody.id, claimBody, 7, 100), rawBody },
      ],
      collections: [],
      sourceKeys: [],
      bindings: [
        {
          recordKind: "claim",
          entityId: claimBody.id,
          lineageId: "lineage-claim-1",
          versionId: null,
          heads: [],
          revision: 7,
          sourceVersionIds: [],
        },
      ],
    },
    currentEvidence: {
      ...base.currentEvidence,
      ownerInteraction: { id: "owner-review", revision: 1 },
      claims: [],
    },
    phase: "baseline-archive-v1",
    baseline: {
      requestKey: "internal-baseline-review",
      originals: [],
      migrations: [
        {
          recordKind: "claim",
          entityId: claimBody.id,
          sourceRevision: "3",
          sourceSnapshot:
            '{"body":{"text":"Older migration"},"revision":"3","updatedAt":50}',
          provenance: "imported_legacy_baseline",
          artifactAvailability: "not_applicable",
        },
      ],
    },
  });
  if (result.operationId !== "job-stack.claim.review.v1" || !result.baseline)
    throw Error("FIXTURE");
  return { ...result, baseline: result.baseline };
}
describe("baseline prerequisite planning", () => {
  it("preserves observed revision7 raw bytes and distinct older migration provenance with zero operational effects", () => {
    const request = legacyReview(),
      plan = planCoreOperation(request);
    expect(plan.phase).toBe("baseline-archive-v1");
    expect(plan.requestKey).toBe("internal-baseline-review");
    expect(plan.mutations).toEqual([]);
    expect(plan.sourceKeys).toEqual([]);
    expect(plan.audit).toEqual([]);
    expect(plan.candidates[0]?.snapshot.revision).toBe(7);
    expect(plan.candidates[0]?.snapshot.updatedAt).toBe(100);
    expect(plan.readSet.records[0]).toEqual(request.read.records[0]);
    expect(
      plan.candidates[0]?.artifacts.some(
        (a) => a.source.type === "legacy_body",
      ),
    ).toBe(true);
    expect(
      plan.candidates[0]?.artifacts.some(
        (a) =>
          a.role === "migration-baseline" &&
          a.source.type === "utf8" &&
          a.source.text.includes("Older migration"),
      ),
    ).toBe(true);
    expect(plan.candidates[0]?.approval).toEqual({
      state: "unverified",
      evidenceVersionIds: [],
    });
  });
});
it("returns a retained committed domain result before mutable derivation", async () => {
  const plan = planCoreOperation(packetRequest());
  const save = {
    digest: "b".repeat(64),
    statusUrl: "/versions/version-original/protection",
    versionId: "version-original",
    transactionId: "transaction-original",
    status: "saved_primary" as const,
    protection: "protection_pending" as const,
  };
  const result = await runCoreOperation(
    { operationId: plan.operationId, input: packetRequest().input },
    {
      async authorize() {},
      async loadRoot() {
        const request = packetRequest();
        return {
          operation: parseDomainOperation({
            operationId: request.operationId,
            input: request.input,
          }),
          inputDigest: coreInputDigest(request),
          allocation: request.allocation,
          observation: request.read,
          baseline: null,
          main: { plan, digest: await domainRequestDigest(plan) },
        };
      },
      async findCommitted() {
        return { entityId: "packet-1", revision: "1", save };
      },
      async observe() {
        throw Error("MUTABLE_READ_MUST_NOT_RUN");
      },
      async allocateRoot() {
        throw Error("NO_ALLOCATION");
      },
      async retainObservation() {
        throw Error("NO_RETAIN");
      },
      async resolveBaselineInputs() {
        throw Error("NO_BASELINE");
      },
      async bindCommittedBaseline() {
        throw Error("NO_BASELINE");
      },
      async resolveCurrentEvidence() {
        throw Error("NO_EVIDENCE");
      },
      async retainPlan() {
        throw Error("NO_PLAN");
      },
      async commit() {
        throw Error("NO_COMMIT");
      },
    },
  );
  expect(result).toEqual({ entityId: "packet-1", revision: "1", save });
});

it("quarantines safe incomplete legacy claims without activating them", () => {
  const request = legacyReview();
  presentGuard(request.read, "claim", claimBody.id).rawBody =
    '{"text":"Incomplete legacy fact"}';
  const plan = planCoreOperation(request);
  expect(plan.candidates[0]?.snapshot.type).toBe("legacy_record_quarantine");
  expect(plan.mutations).toEqual([]);
});
it("preserves unsafe malformed old rows by denying archive interpretation", () => {
  const request = legacyReview();
  presentGuard(request.read, "claim", claimBody.id).rawBody =
    '{"text":"Legacy","refresh_token":"not-a-real-secret"}';
  expect(() => planCoreOperation(request)).toThrow();
  expect(presentGuard(request.read, "claim", claimBody.id).rawBody).toContain(
    "refresh_token",
  );
});
it("denies baseline rows that were not selected by the registered invocation", () => {
  const request = legacyReview();
  request.read.records.push({
    ...present("claim", "unselected", { ...claimBody, id: "unselected" }),
    recordKind: "claim",
  });
  request.read.bindings.push({
    recordKind: "claim",
    entityId: "unselected",
    lineageId: "unselected",
    versionId: null,
    heads: [],
    revision: 1,
    sourceVersionIds: [],
  });
  expect(() => planCoreOperation(request)).toThrow("UNSELECTED_DOMAIN_READ");
});

function memoryLifecycle(request: ReturnType<typeof legacyReview>) {
  let root:
    | import("../src/application/core-operation-lifecycle").CoreRequestRoot
    | null = null;
  const commits: string[] = [],
    saved = new Map<
      string,
      import("../src/application/core-operation-lifecycle").CoreDomainResult
    >();
  let live = structuredClone(request.read);
  let failMain = false,
    loseMainResponse = false;
  const operation = { operationId: request.operationId, input: request.input };
  const ports: CoreLifecyclePorts = {
    async authorize() {},
    async loadRoot() {
      return root;
    },
    async allocateRoot(validated) {
      const next = {
        operation: validated,
        inputDigest: coreInputDigest(validated),
        allocation: request.allocation,
        observation: null,
        baseline: null,
        main: null,
      };
      root = next;
      return next;
    },
    async observe() {
      return live;
    },
    async retainObservation(current, observation) {
      root = { ...current, observation };
      return root;
    },
    async resolveBaselineInputs() {
      return request.baseline;
    },
    async bindCommittedBaseline(current, value) {
      const read = current.observation;
      if (!read) throw Error("FIXTURE");
      const observation = {
        ...read,
        bindings: read.bindings.map((b) =>
          b.versionId === null
            ? {
                ...b,
                versionId: `baseline-version-${b.entityId}`,
                heads: [`baseline-version-${b.entityId}`],
                sourceVersionIds:
                  value.plan.candidates.find(
                    (c) => c.snapshot.entityId === b.entityId,
                  )?.sourceVersionIds ?? [],
              }
            : b,
        ),
      };
      return {
        observation,
        candidateVersions: value.plan.candidates.map((c) => ({
          role: c.role,
          versionId: `baseline-version-${c.snapshot.entityId}`,
        })),
      };
    },
    async resolveCurrentEvidence() {
      return request.currentEvidence;
    },
    async retainPlan(current, phase, value) {
      root = { ...current, [phase]: value };
      return root;
    },
    async findCommitted(_current, value) {
      return saved.get(value.plan.requestKey) ?? null;
    },
    async commit(_current, value) {
      commits.push(value.plan.phase);
      if (failMain && value.plan.phase === "mutation")
        throw Error("MAIN_BATCH_FAILED");
      const result = {
        entityId: value.plan.resultRecord.entityId,
        revision: String(value.plan.resultRecord.revision),
        save: {
          versionId:
            value.plan.phase === "baseline-archive-v1"
              ? `baseline-version-${value.plan.resultRecord.entityId}`
              : `version-${commits.length}`,
          transactionId: `transaction-${commits.length}`,
          digest: "a".repeat(64),
          statusUrl: `/versions/version-${commits.length}/protection`,
          status: "saved_primary" as const,
          protection: "protection_pending" as const,
        },
      };
      saved.set(value.plan.requestKey, result);
      if (value.plan.phase === "baseline-archive-v1")
        live = {
          ...live,
          bindings: live.bindings.map((b) => {
            const candidate = value.plan.candidates.find(
              (c) =>
                c.snapshot.recordKind === b.recordKind &&
                c.snapshot.entityId === b.entityId,
            );
            return candidate
              ? {
                  ...b,
                  versionId: `baseline-version-${b.entityId}`,
                  heads: [`baseline-version-${b.entityId}`],
                  sourceVersionIds: candidate.sourceVersionIds,
                }
              : b;
          }),
        };
      if (loseMainResponse && value.plan.phase === "mutation")
        throw Error("LOST_RESPONSE");
      return result;
    },
  };
  return {
    operation,
    ports,
    commits,
    saved,
    get root() {
      return root;
    },
    set failMain(value: boolean) {
      failMain = value;
    },
    set loseMainResponse(value: boolean) {
      loseMainResponse = value;
    },
  };
}
it("retains baseline success with an unsaved public operation and reuses it on retry", async () => {
  const fixture = memoryLifecycle(legacyReview());
  fixture.failMain = true;
  await expect(
    runCoreOperation(fixture.operation, fixture.ports),
  ).rejects.toThrow("MAIN_BATCH_FAILED");
  expect(fixture.saved.has("internal-baseline-review")).toBe(true);
  expect(fixture.saved.has("public-review")).toBe(false);
  const digest = fixture.root?.main?.digest;
  fixture.failMain = false;
  const result = await runCoreOperation(fixture.operation, fixture.ports);
  expect(result.revision).toBe("8");
  expect(
    fixture.commits.filter((p) => p === "baseline-archive-v1"),
  ).toHaveLength(1);
  expect(fixture.root?.main?.digest).toBe(digest);
});
it("reconciles a lost actual-result response before stale reads or a second mutation", async () => {
  const fixture = memoryLifecycle(legacyReview());
  fixture.loseMainResponse = true;
  const first = await runCoreOperation(fixture.operation, fixture.ports);
  const calls = fixture.commits.length;
  const again = await runCoreOperation(fixture.operation, {
    ...fixture.ports,
    async observe() {
      throw Error("STALE_READ");
    },
  });
  expect(again).toEqual(first);
  expect(fixture.commits).toHaveLength(calls);
});
it("conflicts changed operation/input under a retained root before effects", async () => {
  const fixture = memoryLifecycle(legacyReview());
  await runCoreOperation(fixture.operation, fixture.ports);
  const calls = fixture.commits.length;
  const raw = {
    ...fixture.operation,
    input: {
      ...fixture.operation.input,
      body: { ...fixture.operation.input.body, status: "unverified" },
    },
  };
  await expect(runCoreOperation(raw, fixture.ports)).rejects.toThrow(
    "DOMAIN_REQUEST_KEY_CONFLICT",
  );
  expect(fixture.commits).toHaveLength(calls);
});
it("conflicts changed original raw readset under an uncommitted retained plan", async () => {
  const fixture = memoryLifecycle(legacyReview());
  fixture.failMain = true;
  await expect(
    runCoreOperation(fixture.operation, fixture.ports),
  ).rejects.toThrow("MAIN_BATCH_FAILED");
  fixture.failMain = false;
  await expect(
    runCoreOperation(fixture.operation, {
      ...fixture.ports,
      async observe(root) {
        const read = structuredClone(root.observation);
        if (!read) throw Error("FIXTURE");
        const guard = read.records[0];
        if (guard?.state === "present")
          guard.rawBody = guard.rawBody
            .replace("services", "systems")
            .replace("0073", "0074");
        return read;
      },
    }),
  ).rejects.toThrow("DOMAIN_REQUEST_MEANING_CONFLICT");
});

function legacyFileReview() {
  const request = legacyReview();
  const claim = presentGuard(request.read, "claim", claimBody.id);
  claim.rawBody = JSON.stringify({
    ...claimBody,
    sourceIds: ["legacy-resume"],
  });
  const artifact = {
    id: "legacy-resume",
    name: "Resume",
    key: "owner/legacy-resume.pdf",
    flags: [],
    facts: [],
    status: "available",
    createdAt: 100,
  };
  const rawBody = JSON.stringify(artifact);
  return parseCorePlanningInput({
    ...request,
    read: {
      ...request.read,
      records: [
        ...request.read.records,
        {
          recordKind: "artifact",
          entityId: artifact.id,
          state: "present",
          rawBody,
          revision: 3,
          updatedAt: 100,
        },
      ],
      bindings: [
        ...request.read.bindings,
        {
          recordKind: "artifact",
          entityId: artifact.id,
          lineageId: "lineage-legacy-resume",
          versionId: null,
          heads: [],
          revision: 3,
          sourceVersionIds: [],
        },
      ],
    },
    baseline: {
      ...request.baseline,
      originals: [
        {
          recordKind: "artifact",
          entityId: artifact.id,
          locator: artifact.key,
          recordRevision: 3,
          rawBodyDigest: createHash("sha256").update(rawBody).digest("hex"),
          state: "missing",
        },
      ],
    },
  });
}
it("records an honestly missing legacy file without original bytes or source-supported approval", () => {
  const plan = planCoreOperation(legacyFileReview());
  const candidate = plan.candidates.find(
    (c) => c.snapshot.recordKind === "artifact",
  );
  expect(candidate?.observation?.originalArtifact).toBe("missing");
  expect(candidate?.artifacts.some((a) => a.role === "original-file")).toBe(
    false,
  );
  expect(candidate?.approval.state).toBe("unverified");
  expect(plan.mutations).toEqual([]);
});
it("blocks unavailable original resolution rather than asserting absence", () => {
  const request = legacyFileReview();
  const original = request.baseline?.originals[0];
  if (!original) throw Error("FIXTURE");
  expect(() =>
    planCoreOperation({
      ...request,
      baseline: {
        ...request.baseline,
        originals: [
          {
            ...original,
            state: "unavailable",
            reason: "permission_unavailable",
          },
        ],
      },
    }),
  ).toThrow("BASELINE_ORIGINAL_UNAVAILABLE");
});
it.each(["locator", "recordRevision", "rawBodyDigest"])(
  "rejects mismatched baseline original %s",
  (field) => {
    const request = legacyFileReview(),
      original = request.baseline?.originals[0];
    if (!original) throw Error("FIXTURE");
    const value =
      field === "recordRevision"
        ? 4
        : field === "rawBodyDigest"
          ? "a".repeat(64)
          : "owner/other.pdf";
    expect(() =>
      planCoreOperation({
        ...request,
        baseline: {
          ...request.baseline,
          originals: [{ ...original, [field]: value }],
        },
      }),
    ).toThrow("BASELINE_ORIGINAL_CORRESPONDENCE_REQUIRED");
  },
);
it("cannot label generated row or snapshot JSON as an observed original file", () => {
  const request = legacyFileReview(),
    original = request.baseline?.originals[0];
  if (!original) throw Error("FIXTURE");
  expect(() =>
    planCoreOperation({
      ...request,
      baseline: {
        ...request.baseline,
        originals: [
          {
            ...original,
            state: "observed",
            digest: "a".repeat(64),
            sizeBytes: 2,
            mediaType: "application/json",
            source: { type: "utf8", text: "{}", mediaType: "application/json" },
          },
        ],
      },
    }),
  ).toThrow("DOMAIN_ORIGINAL_SOURCE_REQUIRED");
});

function mixedBaselineLifecycle(
  options: {
    moveBefore?: boolean;
    moveDuring?: boolean;
    loseBinding?: boolean;
    wrongBound?: boolean;
    allNull?: boolean;
    foreignNull?: boolean;
    wrongMapping?: "primary" | "companion";
  } = {},
) {
  const base = packetRequest();
  const operation = parseDomainOperation({
    operationId: "job-stack.conversation.associate.v1",
    input: {
      workspaceId: "workspace",
      requestKey: "association-public",
      body: { opportunityId: "opportunity-1", questionId: "mail-1" },
    },
  });
  const allocation = {
    ...base.allocation,
    requestRootId: "root-association",
    records: [
      {
        role: "thread",
        recordKind: "thread" as const,
        entityId: "thread-new",
        lineageId: "lineage-thread-new",
        auditEventId: "audit-thread",
      },
      {
        role: "question",
        recordKind: "question" as const,
        entityId: "mail-1",
        lineageId: "lineage-mail-1",
        auditEventId: "audit-mail",
      },
    ],
  };
  const opportunity = base.read.records.find(
      (r) => r.recordKind === "opportunity",
    ),
    opBinding = base.read.bindings.find((b) => b.recordKind === "opportunity");
  if (!opportunity || !opBinding) throw Error("FIXTURE");
  const observation = parseCorePlanningInput({
    ...base,
    operationId: operation.operationId,
    input: operation.input,
    allocation,
    read: {
      records: [
        opportunity,
        {
          recordKind: "question",
          entityId: "mail-1",
          state: "present",
          rawBody: JSON.stringify({
            providerThreadId: "mail-provider",
            recipient: "recruiter@example.com",
            subject: "Subject",
            preview: "Message",
            flags: [],
            status: "unassociated",
          }),
          revision: 1,
          updatedAt: 100,
        },
        { recordKind: "thread", entityId: "thread-new", state: "absent" },
      ],
      bindings: [
        {
          ...opBinding,
          ...(options.allNull ? { versionId: null, heads: [] } : {}),
        },
        {
          recordKind: "question",
          entityId: "mail-1",
          lineageId: "lineage-mail-1",
          versionId: null,
          heads: [],
          revision: 1,
          sourceVersionIds: [],
        },
      ],
      collections: [],
      sourceKeys: [],
    },
  }).read;
  let root: import("../src/application/core-operation-lifecycle").CoreRequestRoot =
    {
      operation,
      inputDigest: coreInputDigest(operation),
      allocation,
      observation,
      baseline: null,
      main: null,
    };
  let live = structuredClone(observation),
    lost = false;
  const commits: string[] = [],
    saved = new Map<
      string,
      import("../src/application/core-operation-lifecycle").CoreDomainResult
    >();
  function moveSource() {
    const op = live.bindings.find((b) => b.recordKind === "opportunity");
    if (!op) throw Error("FIXTURE");
    op.versionId = "opportunity-version-2";
    op.heads = [op.versionId];
  }
  if (options.moveBefore) moveSource();
  if (options.foreignNull) {
    const question = live.bindings.find((b) => b.recordKind === "question");
    if (!question) throw Error("FIXTURE");
    question.versionId = "unrelated-current-version";
    question.heads = [question.versionId];
  }
  function bound(
    current: typeof root,
    value: import("../src/application/core-operation-lifecycle").RetainedCorePlan,
  ) {
    if (!current.observation) throw Error("FIXTURE");
    return {
      ...current.observation,
      bindings: current.observation.bindings.map((b) => {
        if (b.versionId !== null) return b;
        const candidate = value.plan.candidates.find(
          (c) =>
            c.snapshot.recordKind === b.recordKind &&
            c.snapshot.entityId === b.entityId,
        );
        if (!candidate) throw Error("FIXTURE");
        const versionId = options.wrongBound
          ? "unrelated-baseline-version"
          : `committed-${candidate.role}`;
        return {
          ...b,
          versionId,
          heads: [versionId],
          sourceVersionIds: candidate.sourceVersionIds,
        };
      }),
    };
  }
  const ports: CoreLifecyclePorts = {
    async authorize() {},
    async loadRoot() {
      return root;
    },
    async allocateRoot() {
      throw Error("NO_ALLOCATION");
    },
    async observe() {
      return structuredClone(live);
    },
    async retainObservation(current, read) {
      root = { ...current, observation: read };
      return root;
    },
    async resolveBaselineInputs() {
      return {
        requestKey: "internal-association-baseline",
        originals: [],
        migrations: [],
      };
    },
    async bindCommittedBaseline(current, value) {
      if (options.loseBinding && !lost) {
        lost = true;
        throw Error("LOST_BINDING_RESPONSE");
      }
      return {
        observation: bound(current, value),
        candidateVersions: value.plan.candidates.map((c, index) => ({
          role: c.role,
          versionId:
            (options.wrongMapping === "primary" &&
              c.role === value.plan.resultRecord.candidateRole) ||
            (options.wrongMapping === "companion" && index === 1)
              ? "unrelated-mapped-version"
              : `committed-${c.role}`,
        })),
      };
    },
    async resolveCurrentEvidence() {
      return {
        checkedAt: 1000,
        ownerInteraction: null,
        claims: [],
        sourceArtifacts: [],
      };
    },
    async retainPlan(current, phase, value) {
      root = { ...current, [phase]: value };
      return root;
    },
    async findCommitted(_root, value) {
      return saved.get(value.plan.requestKey) ?? null;
    },
    async commit(current, value) {
      commits.push(value.plan.phase);
      const versionId = `committed-${value.plan.resultRecord.candidateRole}`;
      const result = {
        entityId: value.plan.resultRecord.entityId,
        revision: String(value.plan.resultRecord.revision),
        save: {
          versionId,
          transactionId: `transaction-${commits.length}`,
          digest: "a".repeat(64),
          statusUrl: `/versions/${versionId}/protection`,
          status: "saved_primary" as const,
          protection: "protection_pending" as const,
        },
      };
      saved.set(value.plan.requestKey, result);
      if (value.plan.phase === "baseline-archive-v1") {
        live = structuredClone(bound(current, value));
        if (options.moveDuring) moveSource();
      }
      return result;
    },
  };
  return {
    operation,
    ports,
    commits,
    get root() {
      return root;
    },
    get live() {
      return live;
    },
  };
}
it("rejects fresh committed source movement in a mixed baseline root before any baseline effect", async () => {
  const fixture = mixedBaselineLifecycle({ moveBefore: true });
  await expect(
    runCoreOperation(fixture.operation, fixture.ports),
  ).rejects.toThrow("DOMAIN_REQUEST_MEANING_CONFLICT");
  expect(fixture.commits).toEqual([]);
});
it("re-reads all current bindings after baseline and blocks source movement before main", async () => {
  const fixture = mixedBaselineLifecycle({ moveDuring: true });
  await expect(
    runCoreOperation(fixture.operation, fixture.ports),
  ).rejects.toThrow("DOMAIN_REQUEST_MEANING_CONFLICT");
  expect(fixture.commits).toEqual(["baseline-archive-v1"]);
});
it("reconciles the exact committed multi-candidate baseline after a lost binding response", async () => {
  const fixture = mixedBaselineLifecycle({ loseBinding: true, allNull: true });
  await expect(
    runCoreOperation(fixture.operation, fixture.ports),
  ).rejects.toThrow("LOST_BINDING_RESPONSE");
  const result = await runCoreOperation(fixture.operation, fixture.ports);
  expect(result.entityId).toBe("thread-new");
  expect(fixture.commits).toEqual(["baseline-archive-v1", "mutation"]);
  expect(fixture.root.baseline?.plan.candidates).toHaveLength(2);
  const replay = await runCoreOperation(fixture.operation, {
    ...fixture.ports,
    async observe() {
      throw Error("STALE_READ_MUST_NOT_RUN");
    },
  });
  expect(replay).toEqual(result);
});
it("rejects unrelated rebound version IDs instead of accepting non-null baseline-shaped data", async () => {
  const fixture = mixedBaselineLifecycle({ wrongBound: true });
  await expect(
    runCoreOperation(fixture.operation, fixture.ports),
  ).rejects.toThrow("BASELINE_BINDING_MISMATCH");
  expect(fixture.commits).toEqual(["baseline-archive-v1"]);
});

it("denies a fresh null-to-version replacement without an exact retained prerequisite", async () => {
  const fixture = mixedBaselineLifecycle({ foreignNull: true });
  await expect(
    runCoreOperation(fixture.operation, fixture.ports),
  ).rejects.toThrow("DOMAIN_REQUEST_MEANING_CONFLICT");
  expect(fixture.commits).toEqual([]);
});
it("denies null-to-version replacement when a retained baseline has no actual committed winner", async () => {
  const fixture = mixedBaselineLifecycle({ foreignNull: true }),
    read = fixture.root.observation;
  if (!read) throw Error("FIXTURE");
  const plan = planCoreOperation({
    ...fixture.operation,
    allocation: fixture.root.allocation,
    read,
    phase: "baseline-archive-v1",
    baseline: {
      requestKey: "internal-association-baseline",
      originals: [],
      migrations: [],
    },
    currentEvidence: {
      checkedAt: 1000,
      ownerInteraction: null,
      claims: [],
      sourceArtifacts: [],
    },
  });
  const baseline = { plan, digest: await domainRequestDigest(plan) };
  await expect(
    runCoreOperation(fixture.operation, {
      ...fixture.ports,
      async loadRoot() {
        return { ...fixture.root, baseline };
      },
    }),
  ).rejects.toThrow("DOMAIN_REQUEST_MEANING_CONFLICT");
  expect(fixture.commits).toEqual([]);
});
it.each(["primary", "companion"] as const)(
  "binds every baseline %s role to its exact committed candidate version",
  async (wrongMapping) => {
    const fixture = mixedBaselineLifecycle({ allNull: true, wrongMapping });
    await expect(
      runCoreOperation(fixture.operation, fixture.ports),
    ).rejects.toThrow("BASELINE_BINDING_MISMATCH");
    expect(fixture.commits).toEqual(["baseline-archive-v1"]);
  },
);
