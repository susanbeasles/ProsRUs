import { z } from "zod";
import { canonicalJson, LIMITS } from "../../integration/shared-contract.mjs";
import { demand } from "../domain/model";
import {
  domainRequestDigest,
  parseDomainPlan,
  candidateVersionSchema,
  validateCandidateVersions,
  type DomainPlan,
} from "../domain/recovery-domain-plan";
import {
  saveVersionResultSchema,
  type SaveVersionResult,
} from "../domain/recovery";
import {
  parseDomainOperation,
  coreInputDigest,
  coreObservationSchema,
  type BaselineInputs,
  type CoreAllocation,
  type CoreObservation,
  type CurrentDomainEvidence,
  type DomainOperationRequest,
} from "../domain/core-operation-input";
import { planCoreOperation } from "../domain/core-operation-plan";
import { validateCoreObservation } from "../domain/core-operation-reads";

export type CoreDomainResult = Readonly<{
  entityId: string;
  revision: string;
  save: SaveVersionResult;
}>;
export type RetainedCorePlan = Readonly<{ plan: DomainPlan; digest: string }>;
export type CoreRequestRoot = Readonly<{
  operation: DomainOperationRequest;
  inputDigest: string;
  allocation: CoreAllocation;
  observation: CoreObservation | null;
  baseline: RetainedCorePlan | null;
  main: RetainedCorePlan | null;
}>;
const committedBaselineBindingSchema = z
  .object({
    observation: coreObservationSchema,
    candidateVersions: z.array(candidateVersionSchema).min(1).max(32),
  })
  .strict();
/**4I must resolve this from the exact committed retained preparation/D1 winner.
 * This shape, arbitrary version IDs or a host marker are not commitment proof. */
export type CommittedBaselineBinding = z.infer<
  typeof committedBaselineBindingSchema
>;
export type CoreLifecycleStage =
  "start" | "read" | "baseline" | "commit" | "after_commit" | "acknowledgment";
/** Every effect port is assembled by4I from the existing live shared Control
 * boundary. There is no product issuer/registry and no caller-owned callback.
 * retain* uses the existing request-root CAS; commit retains each accepted attempt
 * before the SAME4P prepare/package/sign/store path. findCommitted checks actual
 * D1 plus retained exact preparation/candidate/result mapping, never host markers.
 */
export type CoreLifecyclePorts = Readonly<{
  authorize: (
    request: DomainOperationRequest,
    stage: CoreLifecycleStage,
  ) => Promise<void>;
  loadRoot: (
    request: DomainOperationRequest,
  ) => Promise<CoreRequestRoot | null>;
  allocateRoot: (request: DomainOperationRequest) => Promise<CoreRequestRoot>;
  observe: (root: CoreRequestRoot) => Promise<CoreObservation>;
  retainObservation: (
    root: CoreRequestRoot,
    observation: CoreObservation,
  ) => Promise<CoreRequestRoot>;
  resolveBaselineInputs: (
    root: CoreRequestRoot,
    observation: CoreObservation,
  ) => Promise<BaselineInputs>;
  bindCommittedBaseline: (
    root: CoreRequestRoot,
    baseline: RetainedCorePlan,
    result: CoreDomainResult,
  ) => Promise<CommittedBaselineBinding>;
  resolveCurrentEvidence: (
    root: CoreRequestRoot,
    observation: CoreObservation,
  ) => Promise<CurrentDomainEvidence>;
  retainPlan: (
    root: CoreRequestRoot,
    phase: "baseline" | "main",
    value: RetainedCorePlan,
  ) => Promise<CoreRequestRoot>;
  findCommitted: (
    root: CoreRequestRoot,
    value: RetainedCorePlan,
  ) => Promise<CoreDomainResult | null>;
  commit: (
    root: CoreRequestRoot,
    value: RetainedCorePlan,
  ) => Promise<CoreDomainResult>;
  wake?: (result: CoreDomainResult) => Promise<void>;
}>;
const same = (a: unknown, b: unknown) =>
  canonicalJson(a, LIMITS.privateComposite) ===
  canonicalJson(b, LIMITS.privateComposite);
function assertRoot(request: DomainOperationRequest, root: CoreRequestRoot) {
  demand(
    same(root.operation, request) &&
      root.inputDigest === coreInputDigest(request) &&
      root.allocation.workspace.workspaceId === request.input.workspaceId,
    "DOMAIN_REQUEST_KEY_CONFLICT",
    409,
  );
}
function guardedBusiness(read: CoreObservation) {
  return {
    records: read.records,
    collections: read.collections,
    sourceKeys: read.sourceKeys,
    archiveSources: read.archiveSources ?? [],
  };
}
function resultFor(
  value: RetainedCorePlan,
  result: CoreDomainResult,
): CoreDomainResult {
  demand(
    result.entityId === value.plan.resultRecord.entityId &&
      result.revision === String(value.plan.resultRecord.revision),
    "DOMAIN_RETAINED_RESULT_MISMATCH",
  );
  return {
    entityId: result.entityId,
    revision: result.revision,
    save: saveVersionResultSchema.parse(result.save),
  };
}
function assertFreshBindings(
  retained: CoreObservation,
  fresh: CoreObservation,
): boolean {
  demand(
    retained.bindings.length === fresh.bindings.length,
    "DOMAIN_REQUEST_MEANING_CONFLICT",
    409,
  );
  let observedBaselineReplacement = false;
  for (const old of retained.bindings) {
    const current = fresh.bindings.find(
      (b) => b.recordKind === old.recordKind && b.entityId === old.entityId,
    );
    demand(current, "DOMAIN_REQUEST_MEANING_CONFLICT", 409);
    if (old.versionId !== null || current.versionId === null)
      demand(same(old, current), "DOMAIN_REQUEST_MEANING_CONFLICT", 409);
    else observedBaselineReplacement = true;
  }
  return observedBaselineReplacement;
}
function validateBaselineBinding(
  root: CoreRequestRoot,
  value: RetainedCorePlan,
  result: CoreDomainResult,
  raw: CommittedBaselineBinding,
): CoreObservation {
  const { observation: bound, candidateVersions } =
      committedBaselineBindingSchema.parse(raw),
    read = root.observation;
  demand(
    read && value.plan.phase === "baseline-archive-v1",
    "BASELINE_BINDING_MISMATCH",
  );
  validateCandidateVersions(value.plan, candidateVersions);
  demand(
    candidateVersions.find(
      (v) => v.role === value.plan.resultRecord.candidateRole,
    )?.versionId === result.save.versionId,
    "BASELINE_BINDING_MISMATCH",
  );
  demand(
    same(guardedBusiness(read), guardedBusiness(bound)) &&
      bound.bindings.length === read.bindings.length,
    "BASELINE_BUSINESS_OBSERVATION_CHANGED",
  );
  validateCoreObservation(root.operation, root.allocation, bound);
  for (const old of read.bindings) {
    const target = bound.bindings.find(
      (b) => b.recordKind === old.recordKind && b.entityId === old.entityId,
    );
    if (old.versionId !== null)
      demand(target && same(target, old), "BASELINE_BINDING_MISMATCH");
    else {
      const candidate = value.plan.candidates.find(
          (c) =>
            c.snapshot.recordKind === old.recordKind &&
            c.snapshot.entityId === old.entityId,
        ),
        version = candidateVersions.find((v) => v.role === candidate?.role);
      demand(
        candidate &&
          version &&
          target &&
          candidate.lineageId === old.lineageId &&
          candidate.snapshot.revision === old.revision &&
          target.lineageId === candidate.lineageId &&
          target.revision === candidate.snapshot.revision &&
          target.versionId === version.versionId &&
          same(target.heads, [version.versionId]) &&
          same(target.sourceVersionIds, candidate.sourceVersionIds),
        "BASELINE_BINDING_MISMATCH",
      );
    }
  }
  return bound;
}
async function committed(
  root: CoreRequestRoot,
  value: RetainedCorePlan,
  ports: CoreLifecyclePorts,
) {
  demand(
    (await domainRequestDigest(parseDomainPlan(value.plan))) === value.digest,
    "DOMAIN_RETAINED_PLAN_MISMATCH",
  );
  const result = await ports.findCommitted(root, value);
  return result ? resultFor(value, result) : null;
}
async function commitRetained(
  root: CoreRequestRoot,
  value: RetainedCorePlan,
  ports: CoreLifecyclePorts,
) {
  const prior = await committed(root, value, ports);
  if (prior) return prior;
  await ports.authorize(
    root.operation,
    value.plan.phase === "baseline-archive-v1" ? "baseline" : "commit",
  );
  try {
    return resultFor(value, await ports.commit(root, value));
  } catch (error) {
    const winner = await committed(root, value, ports);
    if (winner) return winner;
    throw error;
  }
}
async function acknowledge(
  request: DomainOperationRequest,
  result: CoreDomainResult,
  ports: CoreLifecyclePorts,
) {
  await ports.authorize(request, "after_commit");
  if (ports.wake) {
    try {
      await ports.wake(result);
    } catch {
      /* durable outbox owns retry */
    }
  }
  await ports.authorize(request, "acknowledgment");
  return result;
}
/** Owns product orchestration; live authority/roots/attempts remain Control-owned. */
export async function runCoreOperation(
  raw: unknown,
  ports: CoreLifecyclePorts,
): Promise<CoreDomainResult> {
  const request = parseDomainOperation(raw);
  await ports.authorize(request, "start");
  let root = await ports.loadRoot(request);
  if (root) {
    assertRoot(request, root);
    if (root.main) {
      const saved = await committed(root, root.main, ports);
      if (saved) return acknowledge(request, saved, ports);
    }
  }
  if (!root) {
    root = await ports.allocateRoot(request);
    assertRoot(request, root);
  }
  await ports.authorize(request, "read");
  const fresh = await ports.observe(root);
  if (root.observation)
    demand(
      same(guardedBusiness(root.observation), guardedBusiness(fresh)),
      "DOMAIN_REQUEST_MEANING_CONFLICT",
      409,
    );
  else {
    root = await ports.retainObservation(root, fresh);
    assertRoot(request, root);
    demand(
      root.observation && same(root.observation, fresh),
      "DOMAIN_OBSERVATION_NOT_RETAINED",
    );
  }
  let read = root.observation;
  demand(read, "DOMAIN_OBSERVATION_NOT_RETAINED");
  const needsBaseline = read.bindings.some((b) => b.versionId === null);
  validateCoreObservation(
    request,
    root.allocation,
    read,
    needsBaseline ? "baseline-archive-v1" : "mutation",
  );
  validateCoreObservation(
    request,
    root.allocation,
    fresh,
    needsBaseline ? "baseline-archive-v1" : "mutation",
  );
  const observedBaselineReplacement = assertFreshBindings(read, fresh);
  if (needsBaseline) {
    // A lost binding reply may leave the root null while current D1 already has
    // the exact baseline. Resolve that winner before permitting any new effect.
    let saved: CoreDomainResult | null = null;
    if (observedBaselineReplacement) {
      demand(root.baseline, "DOMAIN_REQUEST_MEANING_CONFLICT", 409);
      saved = await committed(root, root.baseline, ports);
      demand(saved, "DOMAIN_REQUEST_MEANING_CONFLICT", 409);
    }
    if (!root.baseline) {
      const baseline = await ports.resolveBaselineInputs(root, read);
      const plan = planCoreOperation({
        ...request,
        allocation: root.allocation,
        read,
        baseline,
        phase: "baseline-archive-v1",
        currentEvidence: {
          checkedAt: root.allocation.businessTime,
          ownerInteraction: null,
          claims: [],
          sourceArtifacts: [],
        },
      });
      const value = { plan, digest: await domainRequestDigest(plan) };
      root = await ports.retainPlan(root, "baseline", value);
      assertRoot(request, root);
      demand(
        root.baseline && same(root.baseline, value),
        "DOMAIN_PLAN_NOT_RETAINED",
      );
    }
    const value = root.baseline;
    demand(value, "DOMAIN_PLAN_NOT_RETAINED");
    saved ??= await commitRetained(root, value, ports);
    const bound = validateBaselineBinding(
      root,
      value,
      saved,
      await ports.bindCommittedBaseline(root, value, saved),
    );
    if (observedBaselineReplacement)
      demand(same(bound, fresh), "DOMAIN_REQUEST_MEANING_CONFLICT", 409);
    await ports.authorize(request, "read");
    const current = await ports.observe(root);
    demand(same(bound, current), "DOMAIN_REQUEST_MEANING_CONFLICT", 409);
    root = await ports.retainObservation(root, bound);
    assertRoot(request, root);
    demand(
      root.observation && same(root.observation, bound),
      "DOMAIN_OBSERVATION_NOT_RETAINED",
    );
    read = bound;
  }
  const currentEvidence = await ports.resolveCurrentEvidence(root, read),
    plan = planCoreOperation({
      ...request,
      allocation: root.allocation,
      read,
      currentEvidence,
    });
  const value = { plan, digest: await domainRequestDigest(plan) };
  if (root.main)
    demand(same(root.main, value), "DOMAIN_REQUEST_MEANING_CONFLICT", 409);
  else {
    root = await ports.retainPlan(root, "main", value);
    assertRoot(request, root);
    demand(root.main && same(root.main, value), "DOMAIN_PLAN_NOT_RETAINED");
  }
  return acknowledge(
    request,
    await commitRetained(root, root.main ?? value, ports),
    ports,
  );
}
