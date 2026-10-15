import { createHash } from "node:crypto";
import { z } from "zod";
import { demand } from "../domain/model";
import {
  planAuditedImport,
  createAuditedSchemas,
  type AuditedImportPlan,
} from "../application/audited-legacy-import";
import {
  parseAuditedSourceProfile,
  type CheckedAuditedSourceProfile,
} from "../application/audited-source-profile";
const encode = JSON.stringify,
  encoder = new TextEncoder();
const hash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
export const PENDING_CLOCK_SQL =
  "CAST(ROUND(unixepoch('subsec')*1000) AS INTEGER)";
export const PENDING_CLOCK_GUARD =
  "observed IS NULL OR typeof(observed)<>'integer' OR observed<0 OR observed>9007199254740991 OR observed<? OR observed>=?";
export type ObservationStage = {
  id: string;
  admit: (sources: number, chunks: number) => void;
  beforeBatch: () => Promise<{ nowMs: number; expiresAtMs: number }>;
  prefix: (plan: AuditedImportPlan, nowMs: number) => string;
  verify: (
    text: string,
    plan: AuditedImportPlan,
    clock: number,
  ) => Promise<unknown>;
};
export interface PendingStatement {
  bind(...params: (string | number | null)[]): PendingStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface PendingDatabase {
  prepare(sql: string): PendingStatement;
  batch(statements: PendingStatement[]): Promise<unknown>;
}
export type PendingObservationPorts = {
  db: PendingDatabase;
  currentWorkspace: () => Promise<AuditedImportPlan["workspace"]>;
  readOriginalCopy: (name: string) => Promise<Uint8Array>;
  resultOnly?: boolean;
  stage?: ObservationStage;
  operator?: OperatorWindow;
};
export type OperatorWindow = {
  window: Readonly<{ nowMs: number; expiresAtMs: number }>;
  current: () => Promise<void>;
};
export type OperatorPendingPorts = Omit<
  PendingObservationPorts,
  "stage" | "operator"
> &
  OperatorWindow;
export type OperatorCompleteReadEvidence = {
  format: "job-stack.remote-original-read.v1";
  accountId: string;
  bucket: string;
  key: string;
  sourceName: string;
  actionDigest: string;
  sequence: number;
  requestDigest: string;
  status: 200;
  complete: true;
  sizeBytes: number;
  sha256: string;
  literalBytesEqual: true;
};
export type OperatorCompleteReads = {
  kind: "operator-complete-read.v1";
  accountId: string;
  bucket: string;
  actionDigest: string;
  sources: readonly {
    name: string;
    key: string;
    sizeBytes: number;
    sha256: string;
  }[];
  read: (name: string) => Promise<OperatorCompleteReadEvidence>;
};
export type OperatorCompleteReadPorts = Omit<
  OperatorPendingPorts,
  "readOriginalCopy"
> & {
  originalReads: OperatorCompleteReads;
};
function admitOperator(ports: Omit<OperatorPendingPorts, "readOriginalCopy">) {
  demand(
    ports.window &&
      Object.isFrozen(ports.window) &&
      Object.keys(ports.window).sort().join(",") === "expiresAtMs,nowMs" &&
      Number.isSafeInteger(ports.window.nowMs) &&
      ports.window.nowMs >= 0 &&
      Number.isSafeInteger(ports.window.expiresAtMs) &&
      ports.window.expiresAtMs > ports.window.nowMs &&
      typeof ports.current === "function" &&
      !("stage" in ports) &&
      !("operator" in ports),
    "AUDIT_OPERATOR_WINDOW_REQUIRED",
  );
  return Object.freeze({
    window: Object.freeze({ ...ports.window }),
    current: ports.current,
  });
}
/** Existing operator/raw-copy callers still must supply actual Uint8Array readback. */
export async function observeOperatorPending(
  ports: OperatorPendingPorts,
  plan: AuditedImportPlan,
  profile: CheckedAuditedSourceProfile,
) {
  const operator = admitOperator(ports);
  await operator.current();
  return observeAuditedPending({ ...ports, operator }, plan, profile);
}
/** Trusted source adapter entry only. A public DTO cannot select this evidence mode.
 * It verifies remote-read evidence, explicitly never claims to retrieve raw copies. */
export async function observeOperatorPendingCompleteReads(
  ports: OperatorCompleteReadPorts,
  plan: AuditedImportPlan,
  profile: CheckedAuditedSourceProfile,
) {
  const operator = admitOperator(ports);
  const reads = ports.originalReads;
  demand(
    !("readOriginalCopy" in ports) &&
      reads &&
      Object.keys(reads).sort().join(",") ===
        "accountId,actionDigest,bucket,kind,read,sources" &&
      reads.kind === "operator-complete-read.v1" &&
      typeof reads.read === "function" &&
      /^[a-f0-9]{32}$/.test(reads.accountId) &&
      /^[a-f0-9]{64}$/.test(reads.actionDigest) &&
      /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(reads.bucket) &&
      reads.sources.length === plan.sources.length &&
      new Set(reads.sources.map((s) => s.key)).size === reads.sources.length &&
      reads.sources.every((source, index) => {
        const expected = plan.sources[index];
        return (
          expected &&
          Object.keys(source).sort().join(",") ===
            "key,name,sha256,sizeBytes" &&
          source.name === expected.name &&
          source.sizeBytes === expected.sizeBytes &&
          source.sha256 === expected.rawSha256 &&
          source.key.length > 0 &&
          bytes(source.key) <= 1024 &&
          source.key
            .split("/")
            .every(
              (part) =>
                /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..",
            )
        );
      }),
    "AUDIT_OPERATOR_EVIDENCE_REQUIRED",
  );
  // Copy the identity before the first await; never retain caller-mutable authority.
  const admitted = Object.freeze({
    ...reads,
    sources: Object.freeze(
      reads.sources.map((source) => Object.freeze({ ...source })),
    ),
  });
  await operator.current();
  return observePending({ ...ports, operator }, plan, profile, admitted);
}
const fixed = {
  provenance: "imported_legacy_baseline",
  artifact_availability: "not_applicable",
  archive_state: "pending",
  schema_version: 1,
};
function bytes(text: string) {
  return encoder.encode(text).length;
}
function rowBound(values: readonly (string | number | null)[]) {
  demand(
    values.reduce<number>(
      (n, v) => n + (typeof v === "string" ? bytes(v) : 16),
      256,
    ) <= 2000000,
    "AUDIT_D1_ROW_BOUND",
  );
}
export function pendingChunks(plan: AuditedImportPlan) {
  const chunks: { ids: string[]; text: string }[] = [];
  let rows: [string, string][] = [],
    maxRows: [string, string][] = [];
  for (const record of plan.records) {
    const body = encode(record.body);
    rowBound([
      plan.workspace.ownerId,
      "opportunity",
      record.id,
      body,
      1,
      record.updatedAt,
    ]);
    rowBound([
      plan.workspace.ownerId,
      "records",
      "opportunity",
      record.id,
      "1",
      `{"body":${body},"revision":"1","updatedAt":${record.updatedAt}}`,
      ...Object.values(fixed),
    ]);
    const safeBody = encode({
      ...record.body,
      import: { ...record.body.import, observedAt: Number.MAX_SAFE_INTEGER },
    });
    const candidate = [...maxRows, [record.id, safeBody] as [string, string]];
    if (
      rows.length &&
      (candidate.length > 64 || bytes(encode(candidate)) > 1500000)
    ) {
      chunks.push({ ids: rows.map((r) => r[0]), text: encode(rows) });
      rows = [];
      maxRows = [];
    }
    rows.push([record.id, body]);
    maxRows.push([record.id, safeBody]);
    demand(bytes(encode(rows)) <= 1500000, "AUDIT_D1_TEXT_BOUND");
  }
  if (rows.length)
    chunks.push({ ids: rows.map((r) => r[0]), text: encode(rows) });
  const sourceCount = plan.sources.length,
    budget = 3 * chunks.length + sourceCount + 7,
    ids = encode(plan.records.map((r) => r.id));
  demand(
    chunks.length <= 12 && budget <= 48 && bytes(ids) <= 26369,
    "AUDIT_D1_QUERY_BOUND",
  );
  for (const [kind, id, text] of [
    ["import_receipt", plan.seriesId, encode(plan.receipt)],
    ...plan.sources.map((s) => ["raw_input", s.rawSha256, encode(s)]),
  ]) {
    demand(
      text !== undefined && id !== undefined && kind !== undefined,
      "AUDIT_D1_TEXT_BOUND",
    );
    demand(bytes(text) <= 1500000, "AUDIT_D1_TEXT_BOUND");
    rowBound([
      plan.workspace.ownerId,
      "audited_json",
      kind,
      id,
      null,
      text,
      ...Object.values(fixed),
    ]);
  }
  return { chunks, sourceCount, budget, ids };
}
const columns =
  "owner,source_table,source_kind,source_id,source_revision,source_snapshot,provenance,artifact_availability,archive_state,schema_version";
const headerSQL = `SELECT i.owner,i.source_table,i.source_kind,i.source_id,i.source_revision,i.source_snapshot,i.provenance,i.artifact_availability,i.archive_state,i.schema_version,
 p.owner AS p_owner,p.source_table AS p_table,p.source_kind AS p_kind,p.source_id AS p_id,p.source_revision AS p_revision,p.source_snapshot AS p_snapshot,p.provenance AS p_provenance,p.artifact_availability AS p_availability,p.archive_state AS p_state,p.schema_version AS p_schema,
 (SELECT count(*) FROM records WHERE owner=? AND kind='opportunity' AND json_extract(body,'$.source.seriesId')=?) AS record_count,
 (SELECT count(*) FROM recovery_import_baselines WHERE owner=? AND source_table='records' AND source_kind='opportunity' AND json_extract(source_snapshot,'$.body.source.seriesId')=?) AS baseline_count,
 (SELECT count(*) FROM recovery_import_baselines WHERE owner=? AND source_table='audited_json' AND source_kind='raw_input' AND json_extract(source_snapshot,'$.seriesId')=?) AS source_count,
 (SELECT count(*) FROM recovery_import_baselines WHERE owner=? AND source_table='audited_json' AND source_kind='pending_action' AND json_extract(source_snapshot,'$.seriesId')=?) AS stage_count,
 (SELECT count(*) FROM recovery_lineages WHERE owner=? AND kind='opportunity' AND entity_id IN (SELECT value FROM json_each(?))) AS canonical_count
 FROM (SELECT 1) LEFT JOIN recovery_import_baselines AS i ON i.owner=? AND i.source_table='audited_json' AND i.source_kind='import_receipt' AND i.source_id=?
 LEFT JOIN recovery_import_baselines AS p ON p.owner=? AND p.source_table='audited_json' AND p.source_kind='pending_action' AND p.source_id=?`;
type Header = Record<string, unknown>;
function baselineFields(
  row: Record<string, unknown>,
  owner: string,
  table: string,
  kind: string,
  id: string,
  revision: string | null,
) {
  demand(
    row.owner === owner &&
      row.source_table === table &&
      row.source_kind === kind &&
      row.source_id === id &&
      row.source_revision === revision &&
      Object.entries(fixed).every(([k, v]) => row[k] === v),
    "AUDIT_IMPORT_UNVERIFIED",
  );
}
export type PendingSql = { sql: string; params: (string | number | null)[] };
export function pendingHeaderStatement(
  plan: AuditedImportPlan,
  stageId = "local_no_stage",
): PendingSql {
  return {
    sql: headerSQL,
    params: [
      plan.workspace.ownerId,
      plan.seriesId,
      plan.workspace.ownerId,
      plan.seriesId,
      plan.workspace.ownerId,
      plan.seriesId,
      plan.workspace.ownerId,
      plan.seriesId,
      plan.workspace.ownerId,
      pendingChunks(plan).ids,
      plan.workspace.ownerId,
      plan.seriesId,
      plan.workspace.ownerId,
      stageId,
    ],
  };
}
export function pendingSourcesStatement(plan: AuditedImportPlan): PendingSql {
  return {
    sql: `SELECT ${columns} FROM recovery_import_baselines WHERE owner=? AND source_table='audited_json' AND source_kind='raw_input' AND json_extract(source_snapshot,'$.seriesId')=? LIMIT 6`,
    params: [plan.workspace.ownerId, plan.seriesId],
  };
}
export function pendingRecordsStatement(
  plan: AuditedImportPlan,
  ids: string[],
): PendingSql {
  return {
    sql: `SELECT r.owner,r.kind,r.id,r.body,r.revision,r.updated_at,b.owner AS b_owner,b.source_table,b.source_kind,b.source_id,b.source_revision,b.source_snapshot,b.provenance,b.artifact_availability,b.archive_state,b.schema_version FROM records AS r LEFT JOIN recovery_import_baselines AS b ON b.owner=r.owner AND b.source_table='records' AND b.source_kind='opportunity' AND b.source_id=r.id WHERE r.owner=? AND r.kind='opportunity' AND r.id IN (SELECT value FROM json_each(?)) LIMIT 65`,
    params: [plan.workspace.ownerId, encode(ids)],
  };
}
export function pendingClockStatement(): PendingSql {
  return { sql: `SELECT ${PENDING_CLOCK_SQL} AS observed`, params: [] };
}
export function pendingWriteStatements(
  expected: AuditedImportPlan,
  admitted: Readonly<{ nowMs: number; expiresAtMs: number }>,
  operator = false,
  stage?: ObservationStage,
): PendingSql[] {
  const owner = expected.workspace.ownerId,
    prepared = pendingChunks(expected);
  const statement = (
    sql: string,
    params: (string | number | null)[],
  ): PendingSql => ({ sql, params });
  function baseline(kind: string, id: string, text: string) {
    rowBound([
      owner,
      "audited_json",
      kind,
      id,
      null,
      text,
      ...Object.values(fixed),
    ]);
    return statement(
      `INSERT INTO recovery_import_baselines(${columns}) VALUES(?,'audited_json',?,?,NULL,?,'imported_legacy_baseline','not_applicable','pending',1)`,
      [owner, kind, id, text],
    );
  }
  const statements = [
    statement(
      `WITH clock AS MATERIALIZED (SELECT ${PENDING_CLOCK_SQL} AS observed) SELECT CASE WHEN ${PENDING_CLOCK_GUARD} THEN json('AUDIT_D1_CLOCK') WHEN EXISTS(SELECT 1 FROM recovery_workspaces WHERE owner=? AND workspace_id<>?) OR EXISTS(SELECT 1 FROM recovery_import_baselines WHERE owner=? AND source_table='audited_json' AND source_kind='import_receipt' AND json_extract(source_snapshot,'$.workspace.workspaceId') IS NOT ?) THEN json('AUDIT_WORKSPACE_MISMATCH') WHEN EXISTS(SELECT 1 FROM recovery_lineages WHERE owner=? AND kind='opportunity' AND entity_id IN (SELECT value FROM json_each(?))) THEN json('AUDIT_CANONICAL_CONFLICT') ELSE 1 END AS permitted FROM clock`,
      [
        admitted.nowMs,
        admitted.expiresAtMs,
        owner,
        expected.workspace.workspaceId,
        owner,
        expected.workspace.workspaceId,
        owner,
        prepared.ids,
      ],
    ),
    baseline("import_receipt", expected.seriesId, encode(expected.receipt)),
  ];
  for (const chunk of prepared.chunks) {
    statements.push(
      statement(
        `INSERT INTO records(owner,kind,id,body,revision,updated_at) SELECT ?,'opportunity',json_extract(value,'$[0]'),json_extract(value,'$[1]'),1,? FROM json_each(?)`,
        [owner, expected.receipt.importObservedAt, chunk.text],
      ),
      statement(
        `INSERT INTO recovery_import_baselines(${columns}) SELECT ?,'records','opportunity',json_extract(value,'$[0]'),'1','{"body":'||json_extract(value,'$[1]')||',"revision":"1","updatedAt":'||CAST(CAST(? AS INTEGER) AS TEXT)||'}','imported_legacy_baseline','not_applicable','pending',1 FROM json_each(?)`,
        [owner, expected.receipt.importObservedAt, chunk.text],
      ),
    );
  }
  for (const source of expected.sources)
    statements.push(baseline("raw_input", source.rawSha256, encode(source)));
  if (stage) {
    const prefix = stage.prefix(expected, admitted.nowMs);
    demand(bytes(prefix) + 17 <= 131072, "AUDIT_D1_TEXT_BOUND");
    rowBound([
      owner,
      "audited_json",
      "pending_action",
      stage.id,
      null,
      prefix + "9007199254740991}",
      ...Object.values(fixed),
    ]);
    statements.push(
      statement(
        `WITH clock AS MATERIALIZED (SELECT ${PENDING_CLOCK_SQL} AS observed) INSERT INTO recovery_import_baselines(${columns}) SELECT ?,'audited_json','pending_action',?,NULL,?||(CASE WHEN ${PENDING_CLOCK_GUARD} THEN json('AUDIT_D1_CLOCK') ELSE CAST(observed AS TEXT) END)||'}','imported_legacy_baseline','not_applicable','pending',1 FROM clock`,
        [owner, stage.id, prefix, admitted.nowMs, admitted.expiresAtMs],
      ),
    );
  }
  if (operator)
    statements.push(
      statement(
        `WITH clock AS MATERIALIZED (SELECT ${PENDING_CLOCK_SQL} AS observed) SELECT CASE WHEN ${PENDING_CLOCK_GUARD} THEN json('AUDIT_D1_CLOCK') ELSE 1 END AS permitted FROM clock`,
        [admitted.nowMs, admitted.expiresAtMs],
      ),
    );
  demand(
    statements.length ===
      2 * prepared.chunks.length +
        prepared.sourceCount +
        (stage || operator ? 3 : 2),
    "AUDIT_D1_QUERY_BOUND",
  );
  return statements;
}

/** Shared pending storage kernel. Only its exact LOCAL wrapper or validated production ports construct effects. */
export async function observeAuditedPending(
  ports: PendingObservationPorts,
  requested: AuditedImportPlan,
  suppliedProfile: CheckedAuditedSourceProfile,
) {
  return observePending(ports, requested, suppliedProfile);
}
async function observePending(
  ports: Omit<PendingObservationPorts, "readOriginalCopy"> &
    Partial<Pick<PendingObservationPorts, "readOriginalCopy">>,
  requested: AuditedImportPlan,
  suppliedProfile: CheckedAuditedSourceProfile,
  completeReads?: OperatorCompleteReads,
) {
  const profile = parseAuditedSourceProfile(suppliedProfile),
    schemas = createAuditedSchemas(profile),
    { db, stage, operator } = ports,
    owner = requested.workspace.ownerId;
  const sourceInputs = requested.sources.map((s) => ({
    name: s.name,
    bytes: encoder.encode(s.rawUtf8),
    receipt: s.sourceReceipt,
  }));
  const rebuild = (observedAt: number) =>
    planAuditedImport(
      {
        sources: sourceInputs,
        workspace: requested.workspace,
        seriesId: requested.seriesId,
        observedAt,
      },
      profile,
    );
  const expected = rebuild(requested.receipt.importObservedAt);
  demand(encode(expected) === encode(requested), "AUDIT_PLAN_MISMATCH");
  const prepared = pendingChunks(expected);
  // A deterministic over-budget shape is rejected before this kernel's first D1/R2 effect.
  stage?.admit(prepared.sourceCount, prepared.chunks.length);
  if (operator)
    demand(
      !stage &&
        prepared.sourceCount <= 5 &&
        expected.records.length <= 154 &&
        prepared.chunks.length <= 4 &&
        prepared.budget <= 24,
      "AUDIT_OPERATOR_BOUND",
    );
  async function authority() {
    await operator?.current();
    const workspace = await ports.currentWorkspace();
    await operator?.current();
    demand(
      workspace.ownerId === owner &&
        workspace.workspaceId === requested.workspace.workspaceId,
      "AUDIT_WORKSPACE_MISMATCH",
    );
  }
  let lastOriginalSequence = 0;
  async function originals() {
    for (const source of expected.sources) {
      await authority();
      if (completeReads) {
        const identity = completeReads.sources.find(
          (s) => s.name === source.name,
        );
        demand(identity, "AUDIT_ORIGINAL_READBACK");
        const evidence = await completeReads.read(source.name);
        demand(
          evidence &&
            typeof evidence === "object" &&
            Object.keys(evidence).sort().join(",") ===
              "accountId,actionDigest,bucket,complete,format,key,literalBytesEqual,requestDigest,sequence,sha256,sizeBytes,sourceName,status" &&
            bytes(encode(evidence)) <= 2048 &&
            evidence.format === "job-stack.remote-original-read.v1" &&
            evidence.accountId === completeReads.accountId &&
            evidence.bucket === completeReads.bucket &&
            evidence.actionDigest === completeReads.actionDigest &&
            evidence.key === identity.key &&
            evidence.sourceName === source.name &&
            evidence.status === 200 &&
            evidence.complete === true &&
            evidence.literalBytesEqual === true &&
            evidence.sizeBytes === source.sizeBytes &&
            evidence.sha256 === source.rawSha256 &&
            Number.isSafeInteger(evidence.sequence) &&
            evidence.sequence > lastOriginalSequence &&
            evidence.sequence <= 128 &&
            evidence.requestDigest ===
              hash(
                encoder.encode(
                  encode({
                    actionDigest: completeReads.actionDigest,
                    kind: "r2.get",
                    payload: {
                      bucket: completeReads.bucket,
                      key: identity.key,
                    },
                    protocol: "job-stack.operator-broker.v1",
                    sequence: evidence.sequence,
                  }),
                ),
              ),
          "AUDIT_ORIGINAL_READBACK",
        );
        lastOriginalSequence = evidence.sequence;
      } else {
        demand(
          typeof ports.readOriginalCopy === "function",
          "AUDIT_ORIGINAL_READBACK",
        );
        const copy = await ports.readOriginalCopy(source.name);
        demand(
          copy instanceof Uint8Array &&
            copy.length === source.sizeBytes &&
            hash(copy) === source.rawSha256,
          "AUDIT_ORIGINAL_READBACK",
        );
      }
      await authority();
    }
  }
  function statement(sql: string, values: (string | number | null)[]) {
    demand(
      bytes(sql) <= 100000 &&
        values.length <= 100 &&
        values.every((v) => typeof v !== "string" || bytes(v) <= 1500000),
      "AUDIT_D1_STATEMENT_BOUND",
    );
    return db.prepare(sql).bind(...values);
  }
  async function retained(): Promise<Header> {
    await authority();
    const query = pendingHeaderStatement(expected, stage?.id);
    const row = await statement(query.sql, query.params).first<Header>();
    demand(row, "AUDIT_IMPORT_UNVERIFIED");
    return row;
  }
  async function verify(row: Header) {
    baselineFields(
      row,
      owner,
      "audited_json",
      "import_receipt",
      expected.seriesId,
      null,
    );
    const text = z.string().parse(row.source_snapshot),
      value: unknown = JSON.parse(text);
    demand(text === encode(value), "AUDIT_IMPORT_UNVERIFIED");
    const identity = z
      .object({
        bundleDigest: z.string(),
        importObservedAt: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER),
        workspace: z.object({ ownerId: z.string(), workspaceId: z.string() }),
      })
      .parse(value);
    demand(
      identity.bundleDigest === expected.receipt.bundleDigest &&
        identity.workspace.ownerId === owner &&
        identity.workspace.workspaceId === expected.workspace.workspaceId,
      "AUDIT_IMPORT_CONFLICT",
    );
    const pinned = rebuild(identity.importObservedAt);
    demand(text === encode(pinned.receipt), "AUDIT_IMPORT_UNVERIFIED");
    demand(
      row.record_count === pinned.records.length &&
        row.baseline_count === pinned.records.length &&
        row.source_count === pinned.sources.length &&
        row.canonical_count === 0,
      "AUDIT_IMPORT_UNVERIFIED",
    );
    if (stage) {
      baselineFields(
        {
          owner: row.p_owner,
          source_table: row.p_table,
          source_kind: row.p_kind,
          source_id: row.p_id,
          source_revision: row.p_revision,
          ...fixed,
          provenance: row.p_provenance,
          artifact_availability: row.p_availability,
          archive_state: row.p_state,
          schema_version: row.p_schema,
        },
        owner,
        "audited_json",
        "pending_action",
        stage.id,
        null,
      );
      demand(
        row.stage_count === 1 && typeof row.p_snapshot === "string",
        "AUDIT_IMPORT_UNVERIFIED",
      );
    } else demand(row.stage_count === 0, "AUDIT_IMPORT_UNVERIFIED");
    await authority();
    const sourceQuery = pendingSourcesStatement(pinned);
    const sourceRows = (
      await statement(sourceQuery.sql, sourceQuery.params).all<
        Record<string, unknown>
      >()
    ).results;
    demand(
      sourceRows.length === pinned.sources.length,
      "AUDIT_IMPORT_UNVERIFIED",
    );
    const seen = new Set<string>();
    for (const source of pinned.sources) {
      const row = sourceRows.find((r) => r.source_id === source.rawSha256);
      demand(row && !seen.has(source.rawSha256), "AUDIT_IMPORT_UNVERIFIED");
      seen.add(source.rawSha256);
      baselineFields(
        row,
        owner,
        "audited_json",
        "raw_input",
        source.rawSha256,
        null,
      );
      demand(row.source_snapshot === encode(source), "AUDIT_IMPORT_UNVERIFIED");
      const parsed = schemas.source.parse(
          JSON.parse(z.string().parse(row.source_snapshot)),
        ),
        raw = encoder.encode(parsed.rawUtf8);
      demand(
        encode(parsed) === encode(source) &&
          raw.length === source.sizeBytes &&
          hash(raw) === source.rawSha256,
        "AUDIT_IMPORT_UNVERIFIED",
      );
    }
    const pinnedChunks = pendingChunks(pinned);
    demand(
      pinnedChunks.chunks.length === prepared.chunks.length,
      "AUDIT_D1_QUERY_BOUND",
    );
    for (const chunk of pinnedChunks.chunks) {
      await authority();
      const recordsQuery = pendingRecordsStatement(pinned, chunk.ids);
      const rows = (
        await statement(recordsQuery.sql, recordsQuery.params).all<
          Record<string, unknown>
        >()
      ).results;
      demand(
        rows.length === chunk.ids.length &&
          new Set(rows.map((r) => r.id)).size === rows.length,
        "AUDIT_IMPORT_UNVERIFIED",
      );
      for (const id of chunk.ids) {
        const record = pinned.records.find((r) => r.id === id),
          row = rows.find((r) => r.id === id);
        demand(record && row, "AUDIT_IMPORT_UNVERIFIED");
        demand(
          row.owner === owner &&
            row.kind === "opportunity" &&
            row.body === encode(record.body) &&
            row.revision === 1 &&
            row.updated_at === record.updatedAt &&
            encode(
              schemas.role.parse(JSON.parse(z.string().parse(row.body))),
            ) === encode(record.body),
          "AUDIT_IMPORT_UNVERIFIED",
        );
        baselineFields(
          { ...row, owner: row.b_owner },
          owner,
          "records",
          "opportunity",
          id,
          "1",
        );
        demand(
          row.source_snapshot ===
            encode({
              body: record.body,
              revision: "1",
              updatedAt: record.updatedAt,
            }),
          "AUDIT_IMPORT_UNVERIFIED",
        );
      }
    }
    await authority();
    const clockQuery = pendingClockStatement();
    const clockRow = await statement(clockQuery.sql, clockQuery.params).first<{
      observed: number;
    }>();
    demand(
      clockRow &&
        Number.isSafeInteger(clockRow.observed) &&
        clockRow.observed >= 0,
      "AUDIT_D1_CLOCK",
    );
    const stageReceipt = stage
      ? await stage.verify(
          z.string().parse(row.p_snapshot),
          pinned,
          clockRow.observed,
        )
      : null;
    await originals();
    await authority();
    return { receipt: pinned.receipt, stageReceipt };
  }
  await authority();
  await originals();
  const prior = await retained();
  if (prior.source_snapshot !== null) return verify(prior);
  demand(
    prior.record_count === 0 &&
      prior.baseline_count === 0 &&
      prior.source_count === 0 &&
      prior.stage_count === 0 &&
      prior.p_snapshot === null,
    "AUDIT_IMPORT_CONFLICT",
  );
  if (ports.resultOnly) {
    await authority();
    return null;
  }
  await authority();
  const admitted = stage
    ? await stage.beforeBatch()
    : (operator?.window ?? { nowMs: 0, expiresAtMs: Number.MAX_SAFE_INTEGER });
  demand(
    Number.isSafeInteger(admitted.nowMs) &&
      admitted.nowMs >= 0 &&
      Number.isSafeInteger(admitted.expiresAtMs) &&
      admitted.expiresAtMs > admitted.nowMs,
    "AUDIT_D1_CLOCK",
  );
  const statements = pendingWriteStatements(
    expected,
    admitted,
    !!operator,
    stage,
  ).map(({ sql, params }) => statement(sql, params));
  // Only batch uncertainty enters the one winner branch. Verification cannot recursively retry.
  await authority();
  try {
    await db.batch(statements);
    await operator?.current();
  } catch (error) {
    await operator?.current();
    const winner = await retained();
    if (winner.source_snapshot !== null) return verify(winner);
    throw error;
  }
  const saved = await retained();
  demand(saved.source_snapshot !== null, "AUDIT_IMPORT_UNVERIFIED");
  return verify(saved);
}
