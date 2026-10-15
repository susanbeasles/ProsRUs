import { z } from "zod";
import { demand } from "../domain/model";
import {
  validateCoreInput,
  validateCoreOutput,
  type InputById,
  type OutputById,
} from "../../integration/shared-contract.mjs";
import {
  MAX_AUDITED_PLAN_BYTES,
  auditedIdentity,
  auditedPlanDigest,
  type CheckedAuditedSourceProfile,
} from "./audited-source-profile";
import {
  reconstructAuditedRead,
  verifyAuditedRecord,
  type AuditedReadPlan,
} from "./audited-read-plan";
const encoder = new TextEncoder();
const PAGE_SIZE = 20;
const PAGE_CAPACITY = 154;
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const cursorSchema = z
  .object({
    v: z.literal(1),
    owner: idSchema,
    workspace: idSchema,
    view: z.enum(["relationships", "all"]),
    dataset: z.string().regex(/^[a-f0-9]{64}$/),
    after: idSchema,
  })
  .strict();
const selectedRow = z.object({
  row_type: z.literal("record"),
  id: idSchema,
  body: z.string(),
  body_size: z.number().int().nonnegative().max(54000),
  revision: z.string(),
  updated_at: z.number().int().nonnegative(),
});
/** No preliminary admission can authorize this query. All dataset gates hold in this statement's snapshot. */
const SELECT_PAGE = `/* pipeline-page-selection */
WITH params AS (SELECT ? owner,? workspace,? series,? expected_ids,? selected_ids,? source_ids,? receipt,? dataset,? role_format,? byte_limit),
expected AS (SELECT value id FROM params,json_each(expected_ids)),
selected AS (SELECT value id FROM params,json_each(selected_ids)),
expected_sources AS (SELECT value id FROM params,json_each(source_ids)),
roles AS (SELECT r.* FROM records r,params p WHERE r.owner=p.owner AND r.kind='opportunity'),
raw_sources AS (SELECT b.* FROM recovery_import_baselines b,params p WHERE b.owner=p.owner AND b.source_table='audited_json' AND b.source_kind='raw_input' AND json_extract(b.source_snapshot,'$.seriesId')=p.series),
role_baselines AS (SELECT b.* FROM recovery_import_baselines b,params p WHERE b.owner=p.owner AND b.source_table='records' AND b.source_kind='opportunity'),
metrics AS (SELECT (SELECT COUNT(*) FROM roles) role_count,(SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) FROM roles) role_bytes,(SELECT COUNT(*) FROM raw_sources) source_count,(SELECT COALESCE(SUM(length(CAST(source_snapshot AS BLOB))),0) FROM raw_sources) source_bytes),
admission AS (SELECT p.dataset dataset_id,m.*,CASE WHEN
 m.role_count=(SELECT COUNT(*) FROM expected) AND m.role_count<=154 AND m.role_bytes<=p.byte_limit
 AND NOT EXISTS(SELECT id FROM roles EXCEPT SELECT id FROM expected)
 AND NOT EXISTS(SELECT id FROM expected EXCEPT SELECT id FROM roles)
 AND NOT EXISTS(SELECT 1 FROM roles WHERE NOT json_valid(body) OR json_extract(body,'$.format')<>p.role_format OR json_extract(body,'$.format') IS NULL)
 AND (SELECT COUNT(*) FROM role_baselines)=m.role_count
 AND NOT EXISTS(SELECT source_id FROM role_baselines EXCEPT SELECT id FROM expected)
 AND NOT EXISTS(SELECT 1 FROM role_baselines WHERE archive_state<>'pending' OR schema_version<>1 OR length(CAST(source_snapshot AS BLOB))>p.byte_limit)
 AND (SELECT COALESCE(SUM(length(CAST(source_snapshot AS BLOB))),0) FROM role_baselines)<=p.byte_limit
 AND NOT EXISTS(SELECT 1 FROM recovery_projections WHERE owner=p.owner AND workspace_id=p.workspace AND kind='opportunity')
 AND NOT EXISTS(SELECT 1 FROM recovery_versions WHERE owner=p.owner AND workspace_id=p.workspace AND kind='opportunity')
 AND m.source_count=(SELECT COUNT(*) FROM expected_sources) AND m.source_count BETWEEN 4 AND 5 AND m.source_bytes BETWEEN 1 AND p.byte_limit
 AND NOT EXISTS(SELECT source_id FROM raw_sources EXCEPT SELECT id FROM expected_sources)
 AND NOT EXISTS(SELECT id FROM expected_sources EXCEPT SELECT source_id FROM raw_sources)
 AND NOT EXISTS(SELECT 1 FROM raw_sources WHERE archive_state<>'pending' OR schema_version<>1)
 AND (SELECT COUNT(*) FROM recovery_import_baselines WHERE owner=p.owner AND source_table='audited_json' AND source_kind='import_receipt')=1
 AND EXISTS(SELECT 1 FROM recovery_import_baselines b WHERE b.owner=p.owner AND b.source_table='audited_json' AND b.source_kind='import_receipt' AND b.source_id=p.series AND b.archive_state='pending' AND b.schema_version=1 AND b.source_snapshot=p.receipt AND json_extract(b.source_snapshot,'$.workspace.ownerId')=p.owner AND json_extract(b.source_snapshot,'$.workspace.workspaceId')=p.workspace AND json_extract(b.source_snapshot,'$.seriesId')=p.series)
 AND NOT EXISTS(SELECT 1 FROM recovery_workspaces WHERE owner=p.owner AND workspace_id<>p.workspace)
 AND (SELECT COUNT(*) FROM selected)<=20
 AND NOT EXISTS(SELECT id FROM selected EXCEPT SELECT id FROM expected)
 AND NOT EXISTS(SELECT 1 FROM roles r JOIN selected s ON s.id=r.id WHERE length(CAST(r.body AS BLOB))>54000)
 THEN 1 ELSE 0 END admitted FROM params p,metrics m)
SELECT 'admission' row_type,admitted,dataset_id,role_count,role_bytes,source_count,source_bytes,NULL id,NULL body,NULL body_size,NULL revision,NULL updated_at FROM admission
UNION ALL
SELECT 'record',a.admitted,a.dataset_id,a.role_count,a.role_bytes,a.source_count,a.source_bytes,r.id,CASE WHEN length(CAST(r.body AS BLOB))<=54000 THEN r.body ELSE '' END,length(CAST(r.body AS BLOB)),CAST(r.revision AS TEXT),r.updated_at FROM roles r JOIN selected s ON s.id=r.id CROSS JOIN admission a WHERE a.admitted=1
ORDER BY row_type,id LIMIT 21`;
function display(body: AuditedReadPlan["plan"]["records"][number]["body"]) {
  const v = body.display;
  if (v.company === "Unknown" || v.role === "Unknown")
    return { status: "unavailable" as const, reason: "unknown" as const };
  const fields = {
    company: v.company,
    role: v.role,
    observedStatus: v.status,
    stage: v.stage,
    nextAction: v.summary,
    verifiedAt: v.verifiedAt,
    sourceLabel: body.source.name,
    sourceId: body.source.sourceId,
  };
  const lengths = {
    company: 500,
    role: 500,
    observedStatus: 100,
    stage: 500,
    nextAction: 1000,
    verifiedAt: 100,
    sourceLabel: 100,
    sourceId: 100,
  };
  if (
    Object.values(fields).some(
      (value) =>
        value !== null && (typeof value !== "string" || !value.length),
    )
  )
    return { status: "unavailable" as const, reason: "unknown" as const };
  if (
    Object.entries(fields).some(
      ([key, value]) =>
        typeof value === "string" &&
        value.length > lengths[key as keyof typeof lengths],
    ) ||
    encoder.encode(JSON.stringify(fields)).length > 2500
  )
    return { status: "unavailable" as const, reason: "too_large" as const };
  return { status: "available" as const, ...fields };
}
export async function readPipelinePage(
  db: D1Database,
  owner: string,
  workspace: string,
  profile: CheckedAuditedSourceProfile,
  input: InputById["job-stack.pipeline.page.read.v1"],
): Promise<OutputById["job-stack.pipeline.page.read.v1"]> {
  try {
    validateCoreInput("job-stack.pipeline.page.read.v1", input);
    demand(
      input.workspaceId === workspace &&
        profile.workspace.ownerId === owner &&
        profile.workspace.workspaceId === workspace,
      "operation-denied",
    );
    const base = {
      format: "pipeline-page-v1" as const,
      workspaceId: workspace,
      view: input.view,
    };
    const reconstructed = await reconstructAuditedRead(
      db,
      owner,
      workspace,
      profile,
    );
    const all = [...reconstructed.records.keys()].sort();
    if (all.length > PAGE_CAPACITY || reconstructed.sources.length > 5)
      return { ...base, status: "unavailable", reason: "page_capacity" };
    const dataset = auditedPlanDigest(reconstructed.plan);
    const relationships = all.filter((id) => {
      const record = reconstructed.records.get(id);
      demand(record, "operation-denied");
      return record.body.display.inPipeline;
    });
    const view = input.view === "all" ? all : relationships;
    let offset = 0;
    if (input.cursor !== null) {
      demand(encoder.encode(input.cursor).length <= 4096, "operation-denied");
      const c = cursorSchema.parse(
        JSON.parse(decodeURIComponent(input.cursor)),
      );
      demand(
        c.owner === owner &&
          c.workspace === workspace &&
          c.view === input.view &&
          c.dataset === dataset,
        "operation-denied",
      );
      const position = view.indexOf(c.after);
      demand(
        position >= 0 &&
          (position + 1) % PAGE_SIZE === 0 &&
          position + 1 < view.length,
        "operation-denied",
      );
      offset = position + 1;
    }
    const selected = view.slice(offset, offset + PAGE_SIZE);
    const sources = reconstructed.plan.sources.map((s) => s.rawSha256).sort();
    z.array(idSchema).max(PAGE_CAPACITY).parse(all);
    z.array(idSchema).max(PAGE_SIZE).parse(selected);
    z.array(z.string().regex(/^[a-f0-9]{64}$/))
      .min(4)
      .max(5)
      .parse(sources);
    demand(
      new Set(all).size === all.length &&
        new Set(sources).size === sources.length,
      "operation-denied",
    );
    const result = await db
      .prepare(SELECT_PAGE)
      .bind(
        owner,
        workspace,
        profile.seriesId,
        JSON.stringify(all),
        JSON.stringify(selected),
        JSON.stringify(sources),
        reconstructed.receiptBytes,
        dataset,
        auditedIdentity(profile).role,
        MAX_AUDITED_PLAN_BYTES,
      )
      .all();
    const rows = result.results;
    demand(rows.length === selected.length + 1, "operation-denied");
    const admission = z
      .object({
        row_type: z.literal("admission"),
        admitted: z.literal(1),
        dataset_id: z.literal(dataset),
        role_count: z.literal(all.length),
        role_bytes: z.number().int().nonnegative().max(MAX_AUDITED_PLAN_BYTES),
        source_count: z.literal(sources.length),
        source_bytes: z.literal(
          reconstructed.plan.sources.reduce(
            (n, s) => n + encoder.encode(JSON.stringify(s)).length,
            0,
          ),
        ),
      })
      .safeParse(rows[0]);
    demand(admission.success, "operation-denied");
    const checked = rows.slice(1).map((row) => selectedRow.parse(row));
    demand(
      JSON.stringify(checked.map((row) => row.id)) === JSON.stringify(selected),
      "operation-denied",
    );
    const items = checked.map((row) => {
      const body = verifyAuditedRecord(
        row,
        JSON.parse(row.body),
        reconstructed,
      );
      return {
        kind: "opportunity" as const,
        entityId: row.id,
        revision: row.revision,
        updatedAt: row.updated_at,
        origin: "legacy_import" as const,
        history: "legacy_unversioned" as const,
        protection: "import_pending" as const,
        approval: "No current pursuit or action approval" as const,
        inPipeline: body.display.inPipeline,
        display: display(body),
      };
    });
    const nextCursor =
      offset + selected.length < view.length
        ? encodeURIComponent(
            JSON.stringify({
              v: 1,
              owner,
              workspace,
              view: input.view,
              dataset,
              after: selected.at(-1),
            }),
          )
        : null;
    demand(
      nextCursor === null ||
        (selected.length > 0 && nextCursor !== input.cursor),
      "operation-denied",
    );
    return validateCoreOutput("job-stack.pipeline.page.read.v1", {
      ...base,
      status: "available",
      datasetId: dataset,
      importObservedAt: reconstructed.plan.receipt.importObservedAt,
      totalObservations: all.length,
      historicalRelationships: relationships.length,
      range: {
        start: items.length ? offset + 1 : 0,
        end: offset + items.length,
      },
      items,
      nextCursor,
    });
  } catch {
    demand(false, "operation-denied");
  }
}
