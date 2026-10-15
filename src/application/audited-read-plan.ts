import { z } from "zod";
import { demand } from "../domain/model";
import { canonicalJson } from "../../integration/shared-contract.mjs";
import {
  MAX_AUDITED_PLAN_BYTES,
  type CheckedAuditedSourceProfile,
} from "./audited-source-profile";
import {
  createAuditedSchemas,
  planAuditedImport,
} from "./audited-legacy-import";
const encoder = new TextEncoder();
/** Request-local reconstruction. Immutable source bytes and pinned receipt are verified once. */
export async function reconstructAuditedRead(
  db: D1Database,
  owner: string,
  workspace: string,
  profile: CheckedAuditedSourceProfile,
) {
  const schemas = createAuditedSchemas(profile);
  const seriesId = profile.seriesId;
  const selectedSources =
    "SELECT source_id,source_snapshot FROM recovery_import_baselines WHERE owner=? AND source_table='audited_json' AND source_kind='raw_input' AND json_extract(source_snapshot,'$.seriesId')=?";
  const metrics = await db
    .prepare(
      `SELECT COUNT(*) AS source_count,COALESCE(SUM(length(CAST(source_snapshot AS BLOB))),0) AS serialized_bytes FROM (${selectedSources})`,
    )
    .bind(owner, seriesId)
    .first();
  demand(
    z
      .object({
        source_count: z.number().int().min(4).max(5),
        serialized_bytes: z
          .number()
          .int()
          .positive()
          .max(MAX_AUDITED_PLAN_BYTES),
      })
      .strict()
      .safeParse(metrics).success,
    "operation-denied",
  );
  const sourceRows = (
    await db
      .prepare(
        `WITH selected AS (${selectedSources}), admission AS (SELECT COUNT(*) AS source_count,COALESCE(SUM(length(CAST(source_snapshot AS BLOB))),0) AS serialized_bytes FROM selected) SELECT source_snapshot FROM selected,admission WHERE source_count BETWEEN 4 AND 5 AND serialized_bytes<=? ORDER BY source_id LIMIT 6`,
      )
      .bind(owner, seriesId, MAX_AUDITED_PLAN_BYTES)
      .all()
  ).results;
  demand(
    sourceRows.length === 4 || sourceRows.length === 5,
    "operation-denied",
  );
  demand(
    sourceRows.reduce(
      (total, row) =>
        total +
        encoder.encode(
          z.object({ source_snapshot: z.string() }).parse(row).source_snapshot,
        ).length,
      0,
    ) <= MAX_AUDITED_PLAN_BYTES,
    "operation-denied",
  );
  const sources = sourceRows.map((r) =>
    schemas.source.parse(
      JSON.parse(
        z.object({ source_snapshot: z.string() }).parse(r).source_snapshot,
      ),
    ),
  );
  const order = profile.sourceOrder.map((role) => profile.sources[role]?.label);
  sources.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  const pinned = await db
    .prepare(
      `SELECT CASE WHEN length(CAST(source_snapshot AS BLOB))<=${MAX_AUDITED_PLAN_BYTES} THEN source_snapshot ELSE NULL END AS source_snapshot FROM recovery_import_baselines WHERE owner=? AND source_table='audited_json' AND source_kind='import_receipt' AND source_id=? AND archive_state='pending'`,
    )
    .bind(owner, seriesId)
    .first<{ source_snapshot: string }>();
  demand(
    pinned &&
      typeof pinned.source_snapshot === "string" &&
      encoder.encode(pinned.source_snapshot).length <= MAX_AUDITED_PLAN_BYTES,
    "operation-denied",
  );
  const checkedReceipt = z
    .object({ importObservedAt: z.number().int().nonnegative() })
    .parse(JSON.parse(pinned.source_snapshot));
  const reconstructed = planAuditedImport(
    {
      sources: sources.map((v) => ({
        name: v.name,
        bytes: encoder.encode(v.rawUtf8),
        receipt: v.sourceReceipt,
      })),
      workspace: { ownerId: owner, workspaceId: workspace },
      seriesId,
      observedAt: checkedReceipt.importObservedAt,
    },
    profile,
  );
  for (const source of reconstructed.sources)
    demand(
      sourceRows.some(
        (row) =>
          z.object({ source_snapshot: z.string() }).parse(row)
            .source_snapshot === JSON.stringify(source),
      ),
      "operation-denied",
    );
  demand(
    pinned.source_snapshot === JSON.stringify(reconstructed.receipt),
    "operation-denied",
  );
  return {
    sources,
    receiptBytes: pinned.source_snapshot,
    plan: reconstructed,
    records: new Map(
      reconstructed.records.map((record) => [record.id, record]),
    ),
  };
}
export type AuditedReadPlan = Awaited<
  ReturnType<typeof reconstructAuditedRead>
>;
/** Shared exact selected-body/revision/time equality; never trust the mutable display. */
export function verifyAuditedRecord(
  row: {
    id: string;
    body: string;
    revision: string;
    updated_at: number;
    body_size?: number;
  },
  parsed: unknown,
  reconstructed: AuditedReadPlan,
) {
  const expected = reconstructed.records.get(row.id);
  demand(
    expected &&
      (row.body_size ?? encoder.encode(row.body).length) <= 54000 &&
      row.body === JSON.stringify(expected.body) &&
      canonicalJson(expected.body) === canonicalJson(parsed) &&
      expected.revision.toString() === row.revision &&
      expected.updatedAt === row.updated_at,
    "operation-denied",
  );
  return expected.body;
}
