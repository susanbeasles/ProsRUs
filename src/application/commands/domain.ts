import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalJson,
  LIMITS,
  validateCoreOutput,
  type SharedInvocation,
} from "../../../integration/shared-contract.mjs";
import { demand, DomainError, id } from "../../domain/model";
import { canonicalUrl } from "../../domain/rules";
import {
  internalBaselineKey,
  ownerInteraction,
} from "../../domain/command-policy";
import {
  allocationSchema,
  baselineInputsSchema,
  coreInputDigest,
  coreObservationSchema,
  parseDomainOperation,
  type BaselineInputs,
  type CoreAllocation,
  type CoreObservation,
  type DomainOperationRequest,
} from "../../domain/core-operation-input";
import {
  selectCoreReads,
  type CoreReadSelection,
} from "../../domain/core-operation-reads";
import {
  parseDomainPlan,
  recordIdentity,
  type DomainPlan,
} from "../../domain/recovery-domain-plan";
import {
  recoveryKindForRecord,
  type DomainRecordKind,
} from "../../domain/recovery-record";
import {
  runCoreOperation,
  type CoreDomainResult,
  type CoreLifecyclePorts,
  type CoreLifecycleStage,
  type CoreRequestRoot,
  type RetainedCorePlan,
} from "../core-operation-lifecycle";
import { prepareRecoveryPackage } from "../recovery-preparation";
import type {
  AcceptedPreparation,
  PrimaryArchive,
  RecoverySigner,
} from "../recovery-ports";
import { createRecoveryStore } from "../../storage/recovery-store";
import { equalMetadata } from "../../storage/recovery-metadata";
import type { CommandLedger } from "../../storage/command-ledger";
import type { CommandSession, CommandStage } from "./session";
import {
  committedClosure,
  currentChain,
  hostPreparationAuthority,
  recoveryContext,
} from "./recovery-host";

export type DomainCommandPorts = Readonly<{
  db: D1Database;
  archive: PrimaryArchive;
  signer: RecoverySigner;
  ledger: CommandLedger;
  ids: () => string;
}>;
type Slot = CoreAllocation["records"][number];
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const retainedPlanSchema = z
  .object({ plan: z.unknown(), digest })
  .strict()
  .nullable();
const rootSchema = z
  .object({
    operation: z.unknown(),
    inputDigest: digest,
    allocation: allocationSchema,
    observation: coreObservationSchema.nullable(),
    baseline: retainedPlanSchema,
    main: retainedPlanSchema,
  })
  .strict();
const recordRow = z.object({
  body: z.string(),
  revision: z.number().int().positive(),
  updated_at: z.number().int().nonnegative(),
});
const MAX_MEMBERS = 128;
/** Lifecycle stages -> Control stages (read+ then exactly one before-ack).
 * `start` is the session's own fresh read decision. The single before-ack is
 * taken immediately before a D1 commit batch (see commit), so nothing may be
 * asked after it: `after_commit` is local, and `acknowledgment` asks for the
 * before-ack only when this invocation committed nothing (a replayed winner). */
const STAGES: Record<CoreLifecycleStage, CommandStage | null> = {
  start: null,
  read: "read",
  baseline: "read",
  commit: "read",
  after_commit: null,
  acknowledgment: null,
};
function parsePlan(value: z.infer<typeof retainedPlanSchema>) {
  return value === null
    ? null
    : { plan: parseDomainPlan(value.plan), digest: value.digest };
}
function sameIds(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value))
  );
}
function presentation(invocation: SharedInvocation) {
  return {
    entrypoint: invocation.entrypoint,
    verifiedOwnerPrincipalId: invocation.verifiedOwnerPrincipalId,
    issuerPrincipalId: invocation.grant.issuerPrincipalId,
    grantId: invocation.grant.id,
    grantRevision: invocation.grant.revision,
  };
}

/** Runs one registered domain local-write through the maintained core
 * planner/lifecycle and the maintained prepare/sign/commit save path. */
export async function runDomainCommand(
  session: CommandSession,
  ports: DomainCommandPorts,
): Promise<CoreDomainResult> {
  const request = parseDomainOperation({
    operationId: session.request.operationId,
    input: session.request.input,
  });
  const inputDigest = coreInputDigest(request);
  demand(
    inputDigest === session.invocation.operation.inputDigest,
    "operation-denied",
  );
  const { db, ledger } = ports,
    invocation = session.invocation,
    { ownerId, workspaceId } = session.workspace,
    requestKey = request.input.requestKey,
    store = createRecoveryStore(db, ownerId);
  let rootRevision = 0;

  function derivedLineage(recordKind: DomainRecordKind, entityId: string) {
    return `lineage-${createHash("sha256")
      .update(
        `job-stack.domain-lineage.v1\0${ownerId}\0${workspaceId}\0${recordKind}\0${entityId}`,
      )
      .digest("hex")
      .slice(0, 48)}`;
  }
  async function existingLineage(
    recordKind: DomainRecordKind,
    entityId: string,
  ): Promise<string | null> {
    const row = await db
      .prepare(
        "SELECT lineage_id FROM recovery_lineages WHERE owner=? AND workspace_id=? AND kind=? AND entity_id=?",
      )
      .bind(ownerId, workspaceId, recoveryKindForRecord[recordKind], entityId)
      .first();
    return row === null
      ? null
      : z.object({ lineage_id: id }).parse(row).lineage_id;
  }
  async function readRecord(recordKind: DomainRecordKind, entityId: string) {
    const row = await db
      .prepare(
        "SELECT body,revision,updated_at FROM records WHERE owner=? AND kind=? AND id=?",
      )
      .bind(ownerId, recordKind, entityId)
      .first();
    return row === null ? null : recordRow.parse(row);
  }

  /** Stable host allocation: entity/lineage/audit identities fixed before any
   * derivation and retained in the ledger root for retries. */
  async function allocate(
    operation: DomainOperationRequest,
  ): Promise<CoreAllocation> {
    const records: Slot[] = [];
    async function slot(
      role: string,
      recordKind: DomainRecordKind,
      entityId: string,
      extra: Partial<
        Pick<Slot, "transitionAuditEventId" | "ingestAuditEventId">
      > = {},
    ) {
      records.push({
        role,
        recordKind,
        entityId: id.parse(entityId),
        lineageId:
          (await existingLineage(recordKind, entityId)) ??
          derivedLineage(recordKind, entityId),
        auditEventId: ports.ids(),
        ...extra,
      });
    }
    switch (operation.operationId) {
      case "job-stack.claim.add.v1":
        await slot("claim", "claim", ports.ids());
        break;
      case "job-stack.claim.review.v1":
        await slot("claim", "claim", operation.input.body.id);
        break;
      case "job-stack.profile.conflict.resolve.v1":
        await slot("question", "question", operation.input.body.questionId);
        break;
      case "job-stack.opportunity.capture.v1": {
        const mapped = await db
          .prepare(
            "SELECT opportunity_id FROM source_keys WHERE owner=? AND source_key=?",
          )
          .bind(ownerId, canonicalUrl(operation.input.body.sourceUrl))
          .first();
        await slot(
          "opportunity",
          "opportunity",
          mapped === null
            ? ports.ids()
            : z.object({ opportunity_id: id }).parse(mapped).opportunity_id,
          { ingestAuditEventId: ports.ids() },
        );
        break;
      }
      case "job-stack.opportunity.assess.v1":
        await slot("opportunity", "opportunity", operation.input.body.id);
        break;
      case "job-stack.opportunity.transition.v1":
        await slot("opportunity", "opportunity", operation.input.body.id, {
          transitionAuditEventId: ports.ids(),
        });
        break;
      case "job-stack.packet.create.v1":
        await slot("packet", "packet", ports.ids());
        await slot(
          "opportunity",
          "opportunity",
          operation.input.body.opportunityId,
        );
        break;
      case "job-stack.submission.record.v1":
        await slot("attempt", "attempt", ports.ids());
        await slot(
          "opportunity",
          "opportunity",
          operation.input.body.opportunityId,
        );
        break;
      case "job-stack.conversation.capture.v1":
        await slot("thread", "thread", ports.ids());
        break;
      case "job-stack.conversation.associate.v1": {
        const question = await readRecord(
          "question",
          operation.input.body.questionId,
        );
        let threadId: string | null = null,
          associated = false;
        if (question !== null) {
          const body = z
            .object({ status: z.unknown(), threadId: z.unknown() })
            .partial()
            .passthrough()
            .safeParse(JSON.parse(question.body));
          if (body.success && id.safeParse(body.data.threadId).success) {
            threadId = String(body.data.threadId);
            associated =
              body.data.status === "associated" &&
              (await readRecord("thread", threadId)) !== null;
          }
        }
        await slot("thread", "thread", threadId ?? ports.ids());
        // An existing association keeps the question as a source-only guard.
        if (!associated)
          await slot("question", "question", operation.input.body.questionId);
        break;
      }
      case "job-stack.conversation.draft.save.v1":
        await slot("thread", "thread", operation.input.body.threadId);
        break;
      case "job-stack.interview.prepare.v1":
        await slot("prep", "prep", operation.input.body.interviewId);
        break;
      case "job-stack.offer.record.v1":
        await slot("offer", "offer", ports.ids());
        await slot(
          "opportunity",
          "opportunity",
          operation.input.body.opportunityId,
        );
        break;
      case "job-stack.settings.update.v1":
        await slot("settings", "settings", "main");
        break;
    }
    return allocationSchema.parse({
      workspace: { ownerId, workspaceId },
      actorId: invocation.grant.principalId,
      requestRootId: ports.ids(),
      businessTime: session.now(),
      records,
    });
  }

  async function binding(
    recordKind: DomainRecordKind,
    entityId: string,
    revision: number,
  ): Promise<CoreObservation["bindings"][number]> {
    const lineageId = await existingLineage(recordKind, entityId);
    if (lineageId === null)
      return {
        recordKind,
        entityId,
        lineageId: derivedLineage(recordKind, entityId),
        versionId: null,
        heads: [],
        revision,
        sourceVersionIds: [],
      };
    const heads = (
      await db
        .prepare(
          "SELECT version_id FROM recovery_heads WHERE owner=? AND workspace_id=? AND lineage_id=? ORDER BY version_id LIMIT 129",
        )
        .bind(ownerId, workspaceId, lineageId)
        .all()
    ).results.map((row) => z.object({ version_id: id }).parse(row).version_id);
    const versionId = heads.length === 1 ? (heads[0] ?? null) : null;
    if (versionId === null)
      return {
        recordKind,
        entityId,
        lineageId,
        versionId: null,
        heads,
        revision,
        sourceVersionIds: [],
      };
    const manifest = await store.getVersion(versionId);
    demand(manifest, "COMMITTED_DOMAIN_BINDING_REQUIRED", 409);
    const snapshot = z
      .object({
        recordKind: z.literal(recordKind),
        entityId: z.literal(entityId),
        revision: z.number().int().positive(),
      })
      .passthrough()
      .safeParse(manifest.recordSnapshot);
    demand(snapshot.success, "COMMITTED_DOMAIN_BINDING_REQUIRED", 409);
    return {
      recordKind,
      entityId,
      lineageId,
      versionId,
      heads,
      revision: snapshot.data.revision,
      sourceVersionIds: [...manifest.sourceVersionIds],
    };
  }
  async function members(kind: CoreReadSelection["collections"][number]) {
    const sql =
      kind === "all_claims"
        ? "SELECT id FROM records WHERE owner=? AND kind='claim' ORDER BY id LIMIT 129"
        : "SELECT id FROM records WHERE owner=? AND kind='question' AND json_extract(body,'$.type')='profile_conflict' AND json_extract(body,'$.status') IS NOT 'resolved' ORDER BY id LIMIT 129";
    const ids = (await db.prepare(sql).bind(ownerId).all()).results.map(
      (row) => z.object({ id }).parse(row).id,
    );
    demand(ids.length <= MAX_MEMBERS, "DOMAIN_COLLECTION_TOO_LARGE", 413);
    return { kind, memberIds: ids };
  }
  async function readSelection(
    selection: CoreReadSelection,
  ): Promise<CoreObservation> {
    const records: CoreObservation["records"][number][] = [],
      bindings: CoreObservation["bindings"][number][] = [];
    for (const { recordKind, entityId } of selection.records) {
      const row = await readRecord(recordKind, entityId);
      if (row === null) {
        records.push({ recordKind, entityId, state: "absent" });
        continue;
      }
      records.push({
        recordKind,
        entityId,
        state: "present",
        rawBody: row.body,
        revision: row.revision,
        updatedAt: row.updated_at,
      });
      bindings.push(await binding(recordKind, entityId, row.revision));
    }
    const collections = [];
    for (const kind of selection.collections)
      collections.push(await members(kind));
    const sourceKeys = [];
    for (const sourceKey of selection.sourceKeys) {
      const row = await db
        .prepare(
          "SELECT opportunity_id FROM source_keys WHERE owner=? AND source_key=?",
        )
        .bind(ownerId, sourceKey)
        .first();
      sourceKeys.push({
        sourceKey,
        opportunityId:
          row === null
            ? null
            : z.object({ opportunity_id: id }).parse(row).opportunity_id,
      });
    }
    return coreObservationSchema.parse({
      records,
      collections,
      sourceKeys,
      bindings,
    });
  }
  /** Complete current observation: the selector may add dependencies found in
   * selected rows, so read until the selection is stable (bounded). */
  async function observe(root: CoreRequestRoot): Promise<CoreObservation> {
    let read: CoreObservation | undefined, previous: string | null = null;
    for (let round = 0; round < 4; round++) {
      const selection = selectCoreReads(root.operation, root.allocation, read),
        key = canonicalJson(selection, LIMITS.privateComposite);
      if (read !== undefined && key === previous) return read;
      previous = key;
      read = await readSelection(selection);
    }
    throw new DomainError("DOMAIN_READSET_UNSTABLE", 409);
  }

  async function retain(root: CoreRequestRoot): Promise<CoreRequestRoot> {
    rootRevision = await ledger.retainRoot({
      requestKey,
      inputDigest,
      expectedRevision: rootRevision,
      root,
      now: session.now(),
    });
    return root;
  }
  async function loadRoot(): Promise<CoreRequestRoot | null> {
    const stored = await ledger.loadRoot(requestKey, inputDigest);
    if (stored === null) return null;
    const raw = rootSchema.parse(stored.root);
    rootRevision = stored.revision;
    return {
      operation: parseDomainOperation(raw.operation),
      inputDigest: raw.inputDigest,
      allocation: raw.allocation,
      observation: raw.observation,
      baseline: parsePlan(raw.baseline),
      main: parsePlan(raw.main),
    };
  }
  async function baselineInputs(
    root: CoreRequestRoot,
    read: CoreObservation,
  ): Promise<BaselineInputs> {
    const migrations = [];
    for (const b of read.bindings.filter((x) => x.versionId === null)) {
      const row = await db
        .prepare(
          "SELECT source_revision,source_snapshot,artifact_availability FROM recovery_import_baselines WHERE owner=? AND source_table='records' AND source_kind=? AND source_id=?",
        )
        .bind(ownerId, b.recordKind, b.entityId)
        .first();
      if (row === null) continue;
      const value = z
        .object({
          source_revision: z.string().regex(/^[1-9][0-9]*$/),
          source_snapshot: z.string().max(131072),
          artifact_availability: z.enum([
            "not_applicable",
            "unobserved",
            "missing",
            "observed",
          ]),
        })
        .parse(row);
      migrations.push({
        recordKind: b.recordKind,
        entityId: b.entityId,
        sourceRevision: value.source_revision,
        sourceSnapshot: value.source_snapshot,
        provenance: "imported_legacy_baseline" as const,
        artifactAvailability: value.artifact_availability,
      });
    }
    // Binary originals (artifact/packet locators) have no finite resolver
    // here; the planner denies those baselines rather than inventing absence.
    return baselineInputsSchema.parse({
      requestKey: internalBaselineKey(root.allocation.requestRootId),
      originals: [],
      migrations,
    });
  }
  async function headsFor(plan: DomainPlan) {
    const heads = [];
    for (const candidate of plan.candidates)
      heads.push({
        role: candidate.role,
        versionIds: [...(await store.getHeads(candidate.lineageId))],
      });
    return heads;
  }
  /** Product-hosted acceptance, Control-custody signing, before-ack, then the
   * single atomic D1 commit batch. No committed state without before-ack. */
  async function commit(value: RetainedCorePlan): Promise<CoreDomainResult> {
    const plan = parseDomainPlan(value.plan);
    const chain = await currentChain(db, store, invocation),
      context = recoveryContext(invocation, chain),
      heads = await headsFor(plan);
    for (const candidate of plan.candidates)
      demand(
        sameIds(
          heads.find((h) => h.role === candidate.role)?.versionIds ?? [],
          candidate.parentVersionIds,
        ),
        "RECOVERY_HEAD_CONFLICT",
        409,
      );
    const closure = await committedClosure(
      store,
      plan.candidates.flatMap((c) => [
        ...c.parentVersionIds,
        ...c.sourceVersionIds,
        ...c.approval.evidenceVersionIds,
      ]),
    );
    const candidateVersions = plan.candidates.map((c) => ({
      role: c.role,
      versionId: ports.ids(),
    }));
    const primary = plan.candidates.find(
      (c) => c.role === plan.resultRecord.candidateRole,
    );
    const versionId = candidateVersions.find(
      (v) => v.role === plan.resultRecord.candidateRole,
    )?.versionId;
    demand(primary && versionId, "DOMAIN_RESULT_MISMATCH");
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
    const accepted: AcceptedPreparation = {
      format: "bound-primary-v1",
      domainPlan: { plan, candidateVersions, currentHeads: heads },
      input,
      context,
      now: session.now(),
      currentChain: chain,
      currentHeads: primary.parentVersionIds,
      transactionId: ports.ids(),
      versionId,
      namespace: invocation.capability.namespace,
      parents: closure,
      sources: [],
    };
    const authority = hostPreparationAuthority(accepted, async () => ({
      fresh:
        equalMetadata(await currentChain(db, store, invocation), chain) &&
        equalMetadata(await headsFor(plan), heads),
      now: session.now(),
    }));
    const prepared = await prepareRecoveryPackage(input, context, {
      archive: ports.archive,
      signer: ports.signer,
      authority,
    });
    const result = {
      entityId: plan.resultRecord.entityId,
      revision: String(plan.resultRecord.revision),
      save: prepared.result,
    };
    if (plan.phase === "mutation")
      validateCoreOutput(session.request.operationId, result, {
        grantId: invocation.grant.id,
      });
    await session.authorize("before-ack");
    const save = await store.commitPrepared(prepared);
    return { ...result, save };
  }

  const lifecycle: CoreLifecyclePorts = {
    async authorize(_request, stage) {
      const next = STAGES[stage];
      if (next !== null) await session.authorize(next);
      else if (stage === "acknowledgment" && !session.acknowledged())
        await session.authorize("before-ack");
    },
    loadRoot,
    async allocateRoot(operation) {
      return retain({
        operation,
        inputDigest: coreInputDigest(operation),
        allocation: await allocate(operation),
        observation: null,
        baseline: null,
        main: null,
      });
    },
    observe,
    retainObservation: (root, observation) => retain({ ...root, observation }),
    resolveBaselineInputs: baselineInputs,
    async bindCommittedBaseline(root, value, result) {
      // This invocation spent its single before-ack on the baseline batch and
      // may not ask Control again; the retained root resumes on a new request.
      if (session.acknowledged())
        throw new DomainError("DOMAIN_BASELINE_COMMITTED_RETRY", 409);
      const read = root.observation;
      demand(read, "BASELINE_BINDING_MISMATCH");
      const winner = await store.findRequest(
        value.plan.requestKey,
        value.digest,
      );
      demand(
        winner && equalMetadata(winner, result.save),
        "BASELINE_BINDING_MISMATCH",
      );
      const prepared = await store.getPrepared(winner.transactionId);
      demand(
        prepared?.domainEffects &&
          equalMetadata(prepared.domainEffects.plan, value.plan),
        "BASELINE_BINDING_MISMATCH",
      );
      const effects = prepared.domainEffects;
      return {
        observation: {
          ...read,
          bindings: read.bindings.map((b) => {
            if (b.versionId !== null) return b;
            const candidate = value.plan.candidates.find(
                (c) => recordIdentity(c.snapshot) === recordIdentity(b),
              ),
              assigned = effects.candidateVersions.find(
                (v) => v.role === candidate?.role,
              ),
              manifest = prepared.versions.find(
                (v) => v.versionId === assigned?.versionId,
              );
            demand(manifest, "BASELINE_BINDING_MISMATCH");
            return {
              ...b,
              versionId: manifest.versionId,
              heads: [manifest.versionId],
              sourceVersionIds: [...manifest.sourceVersionIds],
            };
          }),
        },
        candidateVersions: [...effects.candidateVersions],
      };
    },
    async resolveCurrentEvidence(root) {
      // Claim/source permission evidence has no shared Control resolver, so it
      // is honestly empty; plans that need it deny. Stable per retained root.
      return {
        checkedAt: root.allocation.businessTime,
        ownerInteraction: ownerInteraction(presentation(invocation)),
        claims: [],
        sourceArtifacts: [],
      };
    },
    retainPlan: (root, phase, value) => retain({ ...root, [phase]: value }),
    async findCommitted(_root, value) {
      const save = await store.findRequest(value.plan.requestKey, value.digest);
      return save
        ? {
            entityId: value.plan.resultRecord.entityId,
            revision: String(value.plan.resultRecord.revision),
            save,
          }
        : null;
    },
    commit: (_root, value) => commit(value),
  };
  return runCoreOperation(request, lifecycle);
}
