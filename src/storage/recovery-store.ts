import { readCommittedRecovery } from "./recovery-commit-observation";
import { validateDomainEffects } from "../application/recovery-domain-effects";
import { domainStatements } from "./recovery-domain-statements";
import { z } from "zod";
import type {
  RecoveryJobLease,
  RecoveryStore,
} from "../application/recovery-ports";
import { DomainError, demand } from "../domain/model";
import {
  auditEventSchema,
  preparedEnvelopeSchema,
  protectionReceiptSchema,
  protectionViewSchema,
  recoveryJobResultSchema,
  saveVersionResultSchema,
  versionManifestSchema,
  workspaceChainSchema,
  type AuditEvent,
  type PreparedEnvelope,
  type ProtectionReceipt,
  type RecoveryJobResult,
  type VersionManifest,
} from "../domain/recovery";
import {
  canonicalizeEnvelope,
  hashEnvelope,
  parseEnvelopeJson,
} from "../domain/recovery-canonical";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sequence = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(100);
const PAGE_SIZE = 100;
const decoder = new TextDecoder();
const rowJson = z.object({ body: z.string() });
const requestRow = z.object({
  request_digest: digestSchema,
  result: z.string(),
});
const committedRequestRow = requestRow.extend({
  owner_id: identifier,
  workspace_id: identifier,
  epoch_id: identifier,
});
const cursorSchema = z
  .object({
    format: z.literal(1),
    owner: identifier,
    workspace: identifier,
    scope: z.string().max(200),
    after: z.string().min(1).max(100),
  })
  .strict();
const leaseSchema = z
  .object({
    jobId: identifier,
    transactionId: identifier,
    owner: identifier,
    fence: sequence,
    expiresAt: timestamp,
    attempt: timestamp,
    stage: recoveryJobResultSchema.unwrap().shape.stage,
  })
  .strict();
const jobRowSchema = z.object({
  workspace_id: identifier,
  job_id: identifier,
  transaction_id: identifier,
  stage: recoveryJobResultSchema.unwrap().shape.stage,
  state: z.enum([
    "pending",
    "running",
    "completed",
    "retryable",
    "dead_letter",
    "quarantined",
  ]),
  fence: sequence,
  lease_owner: identifier.nullable(),
  lease_expires_at: timestamp.nullable(),
  attempt: timestamp,
  next_attempt_at: timestamp,
});
type JobRow = z.infer<typeof jobRowSchema>;

function json(value: unknown): string {
  return decoder.decode(canonicalizeEnvelope(value));
}
function unsigned<T extends { readonly signature: unknown }>(
  value: T,
): Omit<T, "signature"> {
  const { signature: omitted, ...payload } = value;
  void omitted;
  return payload;
}
function cursorAfter(
  cursor: string | null | undefined,
  owner: string,
  workspace: string,
  scope: string,
  numeric: boolean,
): string {
  if (cursor === null || cursor === undefined) return numeric ? "0" : "";
  try {
    demand(cursor.length <= 1500, "INVALID_RECOVERY_CURSOR");
    const parsed = cursorSchema.parse(
      parseEnvelopeJson(decodeURIComponent(cursor)),
    );
    demand(
      parsed.owner === owner &&
        parsed.workspace === workspace &&
        parsed.scope === scope,
      "INVALID_RECOVERY_CURSOR",
    );
    demand(
      !numeric ||
        (/^[1-9][0-9]{0,18}$/.test(parsed.after) &&
          BigInt(parsed.after) <= 9223372036854775807n),
      "INVALID_RECOVERY_CURSOR",
    );
    demand(
      numeric || identifier.safeParse(parsed.after).success,
      "INVALID_RECOVERY_CURSOR",
    );
    return parsed.after;
  } catch {
    throw new DomainError("INVALID_RECOVERY_CURSOR");
  }
}
function pageCursor(
  owner: string,
  workspace: string,
  scope: string,
  after: string,
): string {
  return encodeURIComponent(
    json({ format: 1, owner, workspace, scope, after }),
  );
}
function expiry(now: number, leaseMs: number): number {
  timestamp.parse(now);
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(leaseMs);
  return timestamp.parse(now + leaseMs);
}
function auditFor(
  prepared: PreparedEnvelope,
  operation: string,
  toState: string,
  now: number,
  lease: RecoveryJobLease | null = null,
  errorCategory: string | null = null,
): AuditEvent {
  return auditEventSchema.parse({
    schemaVersion: prepared.schemaVersion,
    canonicalizationVersion: prepared.canonicalizationVersion,
    hashAlgorithm: prepared.hashAlgorithm,
    workspace: prepared.workspace,
    eventId: lease === null ? prepared.transactionId : crypto.randomUUID(),
    requestId: prepared.requestKey,
    transactionId: prepared.transactionId,
    actorId: prepared.actorId,
    grantId: prepared.grant.id,
    grantRevision: prepared.grant.revision,
    resourceIds: [
      ...new Set(prepared.versions.map((version) => version.entityId)),
    ],
    operation,
    serverTime: now,
    epochId: prepared.epochId,
    sequence: prepared.sequence,
    digests: [prepared.requestDigest, prepared.result.digest],
    fromState: lease === null ? null : lease.stage,
    toState,
    leaseOwner: lease?.owner ?? null,
    fence: lease?.fence ?? null,
    attempt: lease?.attempt ?? 0,
    providerRequestRef: null,
    errorCategory,
    verificationResult:
      operation === "recovery.protection" ? "verified" : "unchecked",
    restoreDecision: null,
    outcome: "applied",
  });
}
function pendingProtection(version: VersionManifest) {
  return protectionViewSchema.parse({
    versionId: version.versionId,
    documentApproval: version.approval.state,
    primarySave: "saved_primary",
    replication: "protection_pending",
    integrity: "unchecked",
    retentionEvidence: [],
    lastCheckedAt: null,
    freshnessKnown: false,
  });
}
function ownsLease(
  row: JobRow | null,
  lease: RecoveryJobLease,
  now: number,
): row is JobRow {
  return (
    row !== null &&
    row.state === "running" &&
    row.fence === lease.fence &&
    row.lease_owner === lease.owner &&
    row.transaction_id === lease.transactionId &&
    row.attempt === lease.attempt &&
    row.lease_expires_at !== null &&
    row.lease_expires_at > now
  );
}
const stageOrder = [
  "primary_journal",
  "replicate",
  "verify",
  "receipt",
  "complete",
] as const;

/** Trusted storage adapter, not an authentication/signature-verification endpoint.
 * The first verified preparation atomically binds one workspace/initial epoch per owner.
 * Empty getChain fails; the host owns initial authority. Historical approvals stay inert.
 */
export function createRecoveryStore(
  db: D1Database,
  owner: string,
): RecoveryStore {
  identifier.parse(owner);
  const query = (sql: string, ...values: unknown[]) =>
    db.prepare(sql).bind(...values);
  async function workspace(): Promise<string | null> {
    const raw = await query(
      "SELECT workspace_id FROM recovery_workspaces WHERE owner=?",
      owner,
    ).first();
    return raw === null
      ? null
      : z.object({ workspace_id: identifier }).parse(raw).workspace_id;
  }
  async function findRequest(
    requestKey: string,
    expectedRequestDigest?: string,
  ) {
    identifier.parse(requestKey);
    if (expectedRequestDigest !== undefined)
      digestSchema.parse(expectedRequestDigest);
    const raw = await query(
      "SELECT request_digest,result FROM recovery_request_results WHERE owner=? AND request_key=?",
      owner,
      requestKey,
    ).first();
    if (raw === null) return null;
    const row = requestRow.parse(raw);
    demand(
      expectedRequestDigest === undefined ||
        row.request_digest === expectedRequestDigest,
      "REQUEST_KEY_CONFLICT",
      409,
    );
    return saveVersionResultSchema.parse(parseEnvelopeJson(row.result));
  }
  async function findCommittedResult(prepared: PreparedEnvelope) {
    const raw = await query(
      "SELECT request.owner AS owner_id,request.workspace_id,committed.epoch_id,request.request_digest,request.result FROM recovery_request_results AS request JOIN recovery_transactions AS committed ON committed.owner=request.owner AND committed.workspace_id=request.workspace_id AND committed.transaction_id=request.transaction_id WHERE request.owner=? AND request.request_key=?",
      owner,
      prepared.requestKey,
    ).first();
    if (raw === null) return null;
    const row = committedRequestRow.parse(raw);
    demand(
      row.owner_id === prepared.workspace.ownerId,
      "RECOVERY_OWNER_MISMATCH",
      403,
    );
    demand(
      row.workspace_id === prepared.workspace.workspaceId,
      "RECOVERY_WORKSPACE_MISMATCH",
      409,
    );
    demand(row.epoch_id === prepared.epochId, "RECOVERY_CHAIN_CONFLICT", 409);
    demand(
      row.request_digest === prepared.requestDigest,
      "IDEMPOTENCY_CONFLICT",
      409,
    );
    return saveVersionResultSchema.parse(parseEnvelopeJson(row.result));
  }
  async function getPrepared(transactionId: string) {
    identifier.parse(transactionId);
    const raw = await query(
      "SELECT prepared AS body FROM recovery_transactions WHERE owner=? AND transaction_id=?",
      owner,
      transactionId,
    ).first();
    return raw === null
      ? null
      : preparedEnvelopeSchema.parse(
          parseEnvelopeJson(rowJson.parse(raw).body),
        );
  }
  async function readJob(jobId: string): Promise<JobRow | null> {
    const raw = await query(
      "SELECT workspace_id,job_id,transaction_id,stage,state,fence,lease_owner,lease_expires_at,attempt,next_attempt_at FROM recovery_outbox WHERE owner=? AND job_id=?",
      owner,
      jobId,
    ).first();
    return raw === null ? null : jobRowSchema.parse(raw);
  }
  function auditStatement(event: AuditEvent) {
    return query(
      "INSERT INTO recovery_audit(owner,workspace_id,event_id,schema_version,event) VALUES(?,?,?,?,?)",
      owner,
      event.workspace.workspaceId,
      event.eventId,
      event.schemaVersion,
      json(event),
    );
  }
  // Each statement's predicate is checked at the authoritative D1 sink, within one
  // batch. A stale worker inserts neither history nor audit nor projection changes.
  const leasePredicate =
    "owner=? AND workspace_id=? AND job_id=? AND transaction_id=? AND state='running' AND fence=? AND lease_owner=? AND attempt=? AND lease_expires_at>?";
  function leaseValues(row: JobRow, lease: RecoveryJobLease, now: number) {
    return [
      owner,
      row.workspace_id,
      lease.jobId,
      lease.transactionId,
      lease.fence,
      lease.owner,
      lease.attempt,
      now,
    ];
  }
  function fencedAudit(
    event: AuditEvent,
    row: JobRow,
    lease: RecoveryJobLease,
    now: number,
  ) {
    return query(
      `INSERT INTO recovery_audit(owner,workspace_id,event_id,schema_version,event) SELECT ?,?,?,?,? FROM recovery_outbox WHERE ${leasePredicate}`,
      owner,
      row.workspace_id,
      event.eventId,
      event.schemaVersion,
      json(event),
      ...leaseValues(row, lease, now),
    );
  }
  async function commitPrepared(input: PreparedEnvelope) {
    const prepared = preparedEnvelopeSchema.parse(
      parseEnvelopeJson(json(input)),
    );
    demand(
      prepared.workspace.ownerId === owner,
      "RECOVERY_OWNER_MISMATCH",
      403,
    );
    const resultManifest = prepared.versions.find(
      (version) => version.versionId === prepared.result.versionId,
    );
    demand(resultManifest, "INVALID_PREPARED_ENVELOPE");
    const manifestDigests = await Promise.all(
      prepared.versions.map((version) => hashEnvelope("manifest", version)),
    );
    demand(
      prepared.result.digest ===
        (await hashEnvelope("manifest", resultManifest)),
      "RECOVERY_RESULT_DIGEST_MISMATCH",
    );
    const binding = await query(
      "SELECT workspace_id,epoch_id FROM recovery_chains WHERE owner=?",
      owner,
    ).first();
    if (binding !== null) {
      const bound = z
        .object({ workspace_id: identifier, epoch_id: identifier })
        .parse(binding);
      demand(
        bound.workspace_id === prepared.workspace.workspaceId,
        "RECOVERY_WORKSPACE_MISMATCH",
        409,
      );
      demand(
        bound.epoch_id === prepared.epochId,
        "RECOVERY_CHAIN_CONFLICT",
        409,
      );
    }
    const prior = await findCommittedResult(prepared);
    if (prior !== null) return prior;
    await validateDomainEffects(prepared, getVersion);
    const transactionDigest = await hashEnvelope(
      "transaction",
      unsigned(prepared),
    );
    const workspaceId = prepared.workspace.workspaceId;
    const statements = [
      query(
        "INSERT INTO recovery_workspaces(owner,workspace_id) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM recovery_workspaces WHERE owner=?)",
        owner,
        workspaceId,
        owner,
      ),
      query(
        "INSERT OR IGNORE INTO recovery_chains(owner,workspace_id,epoch_id,sequence,transaction_digest) SELECT ?,?,?,'0',NULL WHERE EXISTS(SELECT 1 FROM recovery_workspaces WHERE owner=? AND workspace_id=?)",
        owner,
        workspaceId,
        prepared.epochId,
        owner,
        workspaceId,
      ),
      query(
        "INSERT INTO recovery_transactions(owner,workspace_id,transaction_id,epoch_id,sequence,expected_sequence,previous_digest,transaction_digest,schema_version,request_key,request_digest,prepared) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        owner,
        workspaceId,
        prepared.transactionId,
        prepared.epochId,
        prepared.sequence,
        String(BigInt(prepared.sequence) - 1n),
        prepared.previousTransactionDigest,
        transactionDigest,
        prepared.schemaVersion,
        prepared.requestKey,
        prepared.requestDigest,
        json(prepared),
      ),
    ];
    for (const [index, version] of prepared.versions.entries()) {
      statements.push(
        query(
          "INSERT INTO recovery_lineages(owner,workspace_id,lineage_id,kind,entity_id) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM recovery_lineages WHERE owner=? AND workspace_id=? AND lineage_id=?)",
          owner,
          workspaceId,
          version.lineageId,
          version.kind,
          version.entityId,
          owner,
          workspaceId,
          version.lineageId,
        ),
        query(
          "INSERT INTO recovery_versions(owner,workspace_id,version_id,lineage_id,kind,entity_id,transaction_id,epoch_id,sequence,schema_version,manifest_digest,manifest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          owner,
          workspaceId,
          version.versionId,
          version.lineageId,
          version.kind,
          version.entityId,
          version.transactionId,
          version.epochId,
          version.sequence,
          version.schemaVersion,
          manifestDigests[index],
          json(version),
        ),
        query(
          "DELETE FROM recovery_heads WHERE owner=? AND workspace_id=? AND lineage_id=? AND version_id IN(SELECT value FROM json_each(?))",
          owner,
          workspaceId,
          version.lineageId,
          json(version.parentVersionIds),
        ),
        query(
          "INSERT INTO recovery_heads(owner,workspace_id,lineage_id,version_id) VALUES(?,?,?,?)",
          owner,
          workspaceId,
          version.lineageId,
          version.versionId,
        ),
        query(
          "INSERT INTO recovery_projections(owner,workspace_id,kind,entity_id,lineage_id,version_id,body) VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,workspace_id,kind,entity_id) DO UPDATE SET version_id=excluded.version_id,body=excluded.body WHERE ?=0",
          owner,
          workspaceId,
          version.kind,
          version.entityId,
          version.lineageId,
          version.versionId,
          json(version.recordSnapshot),
          Number(version.branchRequested),
        ),
        query(
          "INSERT INTO recovery_protection(owner,workspace_id,version_id,view) VALUES(?,?,?,?)",
          owner,
          workspaceId,
          version.versionId,
          json(pendingProtection(version)),
        ),
      );
    }
    for (const event of prepared.events) {
      statements.push(
        query(
          "INSERT INTO recovery_events(owner,workspace_id,event_id,transaction_id,epoch_id,sequence,schema_version,kind,body,event) VALUES(?,?,?,?,?,?,?,?,?,?)",
          owner,
          workspaceId,
          event.eventId,
          event.transactionId,
          event.epochId,
          event.sequence,
          event.schemaVersion,
          event.kind,
          json(event.body),
          json(event),
        ),
      );
    }
    statements.push(
      ...domainStatements(db, owner, prepared.domainEffects),
      query(
        "INSERT INTO recovery_commit_observations(owner,workspace_id,transaction_id,clock,precision_ms,preparation_digest,transaction_digest,result_digest) VALUES(?,?,?,'d1-unixepoch-subsec-v1',1,?,?,?)",
        owner,
        workspaceId,
        prepared.transactionId,
        await hashEnvelope("preparation", unsigned(prepared)),
        transactionDigest,
        prepared.result.digest,
      ),
      query(
        "INSERT INTO recovery_request_results(owner,workspace_id,request_key,schema_version,request_digest,transaction_id,result) VALUES(?,?,?,?,?,?,?)",
        owner,
        workspaceId,
        prepared.requestKey,
        prepared.schemaVersion,
        prepared.requestDigest,
        prepared.transactionId,
        json(prepared.result),
      ),
      auditStatement(
        auditFor(
          prepared,
          "recovery.save",
          "saved_primary",
          prepared.createdAt,
        ),
      ),
      query(
        "INSERT INTO recovery_outbox(owner,workspace_id,job_id,transaction_id,next_attempt_at,created_at) VALUES(?,?,?,?,?,?)",
        owner,
        workspaceId,
        prepared.transactionId,
        prepared.transactionId,
        prepared.createdAt,
        prepared.createdAt,
      ),
    );
    try {
      await db.batch(statements);
    } catch (error) {
      // Key/digest equality cannot stand in for separately resolved trusted identity.
      // A concurrent bootstrap winner must share owner/workspace/epoch before its
      // persisted acknowledgment can reconcile an identical race or lost response.
      const existing = await findCommittedResult(prepared);
      if (existing !== null) return existing;
      if (/RECOVERY_HISTORY_IMMUTABLE/.test(String(error))) {
        // The append-only slot guard can run before the chain CAS trigger. Keep
        // the store's stale-sequence conflict contract without weakening history.
        const occupied = await query(
          "SELECT transaction_id FROM recovery_transactions WHERE owner=? AND workspace_id=? AND epoch_id=? AND sequence=?",
          owner,
          workspaceId,
          prepared.epochId,
          prepared.sequence,
        ).first();
        if (occupied !== null)
          throw new DomainError("RECOVERY_CHAIN_CONFLICT", 409);
      }
      const code =
        /RECOVERY_(?:WORKSPACE_MISMATCH|CHAIN_CONFLICT|HEAD_CONFLICT|ENTITY_CONFLICT|PARENT_CONFLICT|DOMAIN_CONFLICT|DOMAIN_SOURCE_CONFLICT|DOMAIN_ARCHIVE_SOURCE_CONFLICT|COMMIT_OBSERVATION_CONFLICT)/.exec(
          String(error),
        )?.[0];
      if (code !== undefined) throw new DomainError(code, 409);
      throw error;
    }
    return prepared.result;
  }
  async function getVersion(versionId: string) {
    identifier.parse(versionId);
    const raw = await query(
      "SELECT manifest AS body FROM recovery_versions WHERE owner=? AND version_id=?",
      owner,
      versionId,
    ).first();
    return raw === null
      ? null
      : versionManifestSchema.parse(parseEnvelopeJson(rowJson.parse(raw).body));
  }
  async function listVersions(lineageId: string, cursor?: string) {
    identifier.parse(lineageId);
    const workspaceId = await workspace();
    if (workspaceId === null) {
      demand(cursor === undefined, "INVALID_RECOVERY_CURSOR");
      return { items: [], nextCursor: null };
    }
    const scope = `versions:${lineageId}`;
    const after = cursorAfter(cursor, owner, workspaceId, scope, true);
    const rows = (
      await query(
        "SELECT CAST(rowid AS TEXT) AS ordinal,manifest FROM recovery_versions WHERE owner=? AND workspace_id=? AND lineage_id=? AND rowid>CAST(? AS INTEGER) ORDER BY rowid LIMIT ?",
        owner,
        workspaceId,
        lineageId,
        after,
        PAGE_SIZE + 1,
      ).all()
    ).results.map((raw) =>
      z.object({ ordinal: sequence, manifest: z.string() }).parse(raw),
    );
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return {
      items: page.map((row) =>
        versionManifestSchema.parse(parseEnvelopeJson(row.manifest)),
      ),
      nextCursor:
        rows.length > PAGE_SIZE && last !== undefined
          ? pageCursor(owner, workspaceId, scope, last.ordinal)
          : null,
    };
  }
  async function readAudit(cursor: string | null) {
    const workspaceId = await workspace();
    if (workspaceId === null) {
      demand(cursor === null, "INVALID_RECOVERY_CURSOR");
      return { items: [], nextCursor: null };
    }
    const after = cursorAfter(cursor, owner, workspaceId, "audit", true);
    const rows = (
      await query(
        "SELECT CAST(rowid AS TEXT) AS ordinal,event FROM recovery_audit WHERE owner=? AND workspace_id=? AND rowid>CAST(? AS INTEGER) ORDER BY rowid LIMIT ?",
        owner,
        workspaceId,
        after,
        PAGE_SIZE + 1,
      ).all()
    ).results.map((raw) =>
      z.object({ ordinal: sequence, event: z.string() }).parse(raw),
    );
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return {
      items: page.map((row) =>
        auditEventSchema.parse(parseEnvelopeJson(row.event)),
      ),
      nextCursor:
        rows.length > PAGE_SIZE && last !== undefined
          ? pageCursor(owner, workspaceId, "audit", last.ordinal)
          : null,
    };
  }
  async function listDueJobs(now: number, cursor: string | null) {
    timestamp.parse(now);
    const workspaceId = await workspace();
    if (workspaceId === null) {
      demand(cursor === null, "INVALID_RECOVERY_CURSOR");
      return { jobIds: [], nextCursor: null };
    }
    const scope = `jobs:${now}`;
    const after = cursorAfter(cursor, owner, workspaceId, scope, false);
    const rows = (
      await query(
        "SELECT job_id FROM recovery_outbox WHERE owner=? AND workspace_id=? AND job_id>? AND next_attempt_at<=? AND (state IN ('pending','retryable') OR (state='running' AND lease_expires_at<=?)) ORDER BY job_id LIMIT ?",
        owner,
        workspaceId,
        after,
        now,
        now,
        PAGE_SIZE + 1,
      ).all()
    ).results.map((raw) => z.object({ job_id: identifier }).parse(raw));
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return {
      jobIds: page.map((row) => row.job_id),
      nextCursor:
        rows.length > PAGE_SIZE && last !== undefined
          ? pageCursor(owner, workspaceId, scope, last.job_id)
          : null,
    };
  }
  async function claimJob(
    jobId: string,
    leaseOwner: string,
    now: number,
    leaseMs: number,
  ) {
    identifier.parse(jobId);
    identifier.parse(leaseOwner);
    const expiresAt = expiry(now, leaseMs);
    const row = await readJob(jobId);
    if (
      row === null ||
      row.next_attempt_at > now ||
      !(
        ["pending", "retryable"].includes(row.state) ||
        (row.state === "running" &&
          row.lease_expires_at !== null &&
          row.lease_expires_at <= now)
      )
    )
      return null;
    const lease = leaseSchema.parse({
      jobId,
      transactionId: row.transaction_id,
      owner: leaseOwner,
      fence: String(BigInt(row.fence) + 1n),
      expiresAt,
      attempt: row.attempt + 1,
      stage: row.stage,
    });
    const prepared = await getPrepared(row.transaction_id);
    demand(prepared, "RECOVERY_COMMIT_MISSING", 500);
    const event = auditFor(prepared, "recovery.claim", "running", now, lease);
    const predicate =
      "owner=? AND workspace_id=? AND job_id=? AND fence=? AND next_attempt_at<=? AND (state IN ('pending','retryable') OR (state='running' AND lease_expires_at<=?))";
    const values = [owner, row.workspace_id, jobId, row.fence, now, now];
    const result = await db.batch([
      query(
        `INSERT INTO recovery_audit(owner,workspace_id,event_id,schema_version,event) SELECT ?,?,?,?,? FROM recovery_outbox WHERE ${predicate}`,
        owner,
        row.workspace_id,
        event.eventId,
        event.schemaVersion,
        json(event),
        ...values,
      ),
      query(
        `UPDATE recovery_outbox SET state='running',lease_owner=?,lease_expires_at=?,fence=?,attempt=? WHERE ${predicate}`,
        leaseOwner,
        expiresAt,
        lease.fence,
        lease.attempt,
        ...values,
      ),
    ]);
    return result[1]?.meta.changes === 1 ? lease : null;
  }
  async function renewJob(
    input: RecoveryJobLease,
    now: number,
    leaseMs: number,
  ) {
    const lease = leaseSchema.parse(input);
    const expiresAt = expiry(now, leaseMs);
    const row = await readJob(lease.jobId);
    if (!ownsLease(row, lease, now)) return null;
    const prepared = await getPrepared(lease.transactionId);
    demand(prepared, "RECOVERY_COMMIT_MISSING", 500);
    const result = await db.batch([
      fencedAudit(
        auditFor(prepared, "recovery.renew", "running", now, lease),
        row,
        lease,
        now,
      ),
      query(
        `UPDATE recovery_outbox SET lease_expires_at=? WHERE ${leasePredicate}`,
        expiresAt,
        ...leaseValues(row, lease, now),
      ),
    ]);
    return result[1]?.meta.changes === 1 ? { ...lease, expiresAt } : null;
  }
  async function finishJob(
    input: RecoveryJobLease,
    inputResult: RecoveryJobResult,
    now: number,
  ): Promise<"applied" | "stale_fence"> {
    const lease = leaseSchema.parse(input);
    const result = recoveryJobResultSchema.parse(inputResult);
    timestamp.parse(now);
    demand(
      result.jobId === lease.jobId &&
        result.transactionId === lease.transactionId &&
        result.fence === lease.fence &&
        result.attempt === lease.attempt,
      "RECOVERY_JOB_RESULT_MISMATCH",
    );
    const row = await readJob(lease.jobId);
    if (!ownsLease(row, lease, now)) return "stale_fence";
    demand(
      result.status !== "stale_fence" &&
        stageOrder.indexOf(result.stage) >= stageOrder.indexOf(row.stage),
      "RECOVERY_JOB_STAGE_REGRESSION",
    );
    demand(
      result.status !== "retryable" ||
        (result.nextAttemptAt !== null && result.nextAttemptAt >= now),
      "RECOVERY_RETRY_TIME_REQUIRED",
    );
    const prepared = await getPrepared(lease.transactionId);
    demand(prepared, "RECOVERY_COMMIT_MISSING", 500);
    const state =
      result.status === "completed" && result.stage !== "complete"
        ? "pending"
        : result.status;
    const event = auditFor(
      prepared,
      "recovery.finish",
      state,
      now,
      lease,
      result.errorCategory,
    );
    const applied = await db.batch([
      query(
        `INSERT INTO recovery_job_history(owner,workspace_id,event_id,job_id,schema_version,result) SELECT ?,?,?,?,?,? FROM recovery_outbox WHERE ${leasePredicate}`,
        owner,
        row.workspace_id,
        event.eventId,
        lease.jobId,
        1,
        json(result),
        ...leaseValues(row, lease, now),
      ),
      fencedAudit(event, row, lease, now),
      query(
        `UPDATE recovery_outbox SET stage=?,state=?,next_attempt_at=?,error_category=?,lease_owner=NULL,lease_expires_at=NULL WHERE ${leasePredicate}`,
        result.stage,
        state,
        result.nextAttemptAt ?? now,
        result.errorCategory,
        ...leaseValues(row, lease, now),
      ),
    ]);
    return applied[2]?.meta.changes === 1 ? "applied" : "stale_fence";
  }
  async function projectProtection(
    input: RecoveryJobLease,
    inputReceipt: ProtectionReceipt,
    now: number,
  ): Promise<"applied" | "stale_fence"> {
    const lease = leaseSchema.parse(input);
    const receipt = protectionReceiptSchema.parse(
      parseEnvelopeJson(json(inputReceipt)),
    );
    timestamp.parse(now);
    demand(receipt.verifiedAt <= now, "RECOVERY_RECEIPT_FROM_FUTURE");
    const row = await readJob(lease.jobId);
    if (!ownsLease(row, lease, now)) return "stale_fence";
    const prepared = await getPrepared(lease.transactionId);
    demand(prepared, "RECOVERY_COMMIT_MISSING", 500);
    demand(
      receipt.workspace.ownerId === owner &&
        receipt.workspace.workspaceId === row.workspace_id &&
        receipt.epochId === prepared.epochId &&
        receipt.sequence === prepared.sequence &&
        receipt.transactionDigest ===
          (await hashEnvelope("transaction", unsigned(prepared))),
      "RECOVERY_RECEIPT_COMMIT_MISMATCH",
    );
    const receiptDigest = await hashEnvelope("receipt", unsigned(receipt));
    const statements = [
      query(
        `INSERT INTO recovery_protection_receipts(owner,workspace_id,receipt_digest,transaction_id,schema_version,receipt) SELECT ?,?,?,?,?,? FROM recovery_outbox WHERE ${leasePredicate} AND NOT EXISTS(SELECT 1 FROM recovery_protection_receipts WHERE owner=? AND workspace_id=? AND receipt_digest=?)`,
        owner,
        row.workspace_id,
        receiptDigest,
        lease.transactionId,
        receipt.schemaVersion,
        json(receipt),
        ...leaseValues(row, lease, now),
        owner,
        row.workspace_id,
        receiptDigest,
      ),
    ];
    for (const version of prepared.versions) {
      const view = protectionViewSchema.parse({
        ...pendingProtection(version),
        primarySave: "journal_complete",
        replication: "verified_both",
        integrity: "verified",
        retentionEvidence: receipt.retentionEvidence,
        lastCheckedAt: receipt.verifiedAt,
        freshnessKnown: true,
      });
      statements.push(
        query(
          `UPDATE recovery_protection SET view=?,receipt_digest=? WHERE owner=? AND workspace_id=? AND version_id=? AND EXISTS(SELECT 1 FROM recovery_outbox WHERE ${leasePredicate})`,
          json(view),
          receiptDigest,
          owner,
          row.workspace_id,
          version.versionId,
          ...leaseValues(row, lease, now),
        ),
      );
    }
    statements.push(
      fencedAudit(
        auditFor(prepared, "recovery.protection", "verified_both", now, lease),
        row,
        lease,
        now,
      ),
    );
    const applied = await db.batch(statements);
    return applied.at(-1)?.meta.changes === 1 ? "applied" : "stale_fence";
  }
  return {
    readCommitted: (input) => readCommittedRecovery(db, owner, input),
    commitPrepared,
    findRequest,
    getVersion,
    listVersions,
    getPrepared,
    readAudit,
    listDueJobs,
    claimJob,
    renewJob,
    finishJob,
    projectProtection,
    async getChain() {
      const raw = await query(
        "SELECT epoch_id,sequence,transaction_digest FROM recovery_chains WHERE owner=?",
        owner,
      ).first();
      demand(raw !== null, "RECOVERY_WORKSPACE_UNINITIALIZED", 409);
      const row = z
        .object({
          epoch_id: identifier,
          sequence,
          transaction_digest: digestSchema.nullable(),
        })
        .parse(raw);
      return workspaceChainSchema.parse({
        epochId: row.epoch_id,
        sequence: row.sequence,
        previousTransactionDigest: row.transaction_digest,
      });
    },
    async getHeads(lineageId: string) {
      identifier.parse(lineageId);
      return (
        await query(
          "SELECT version_id FROM recovery_heads WHERE owner=? AND lineage_id=? ORDER BY version_id",
          owner,
          lineageId,
        ).all()
      ).results.map(
        (raw) => z.object({ version_id: identifier }).parse(raw).version_id,
      );
    },
    async getProtection(versionId: string) {
      identifier.parse(versionId);
      const raw = await query(
        "SELECT view AS body FROM recovery_protection WHERE owner=? AND version_id=?",
        owner,
        versionId,
      ).first();
      demand(raw !== null, "RECOVERY_VERSION_NOT_FOUND", 404);
      return protectionViewSchema.parse(
        parseEnvelopeJson(rowJson.parse(raw).body),
      );
    },
  };
}
