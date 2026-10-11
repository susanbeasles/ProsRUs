import {
  reconstructAuditedRead,
  verifyAuditedRecord,
} from "./audited-read-plan";
import { readPipelinePage } from "./pipeline-page";
import {
  parseAuditedSourceProfile,
  MAX_AUDITED_PLAN_BYTES,
  type CheckedAuditedSourceProfile,
} from "./audited-source-profile";
import { createAuditedSchemas } from "./audited-legacy-import";
import { protectionViewSchema } from "../domain/recovery";
import { hashEnvelope, parseEnvelopeJson } from "../domain/recovery-canonical";
import { z } from "zod";
import {
  canonicalJson,
  type InputById,
  type JsonValue,
} from "../../integration/shared-contract.mjs";
import { demand } from "../domain/model";
import { createRecoveryStore } from "../storage/recovery-store";
import { domainRecordSnapshotSchema } from "../domain/recovery-record";

const encoder = new TextEncoder();
const rowSchema = z.object({
  id: z.string(),
  body: z.string(),
  revision: z.string(),
  updated_at: z.number(),
  lineage_id: z.string().nullable(),
  version_id: z.string().nullable(),
  legacy_present: z.number(),
  audited_baseline: z.union([z.literal(0), z.literal(1)]),
  body_size: z.number().int().nonnegative().optional(),
  body_format: z.string().nullable().optional(),
});
const cursorSchema = z
  .object({
    v: z.literal(1),
    owner: z.string(),
    workspace: z.string(),
    scope: z.string(),
    after: z.string(),
  })
  .strict();
const kindMap: Readonly<Record<string, string>> = {
  thread: "conversation",
  prep: "prep_brief",
  attempt: "external_receipt",
};
const boundedBody = (alias: "r" | "p") =>
  `CASE WHEN length(CAST(${alias}.body AS BLOB))<=54000 THEN ${alias}.body ELSE '' END AS body,length(CAST(${alias}.body AS BLOB)) AS body_size,CASE WHEN json_valid(${alias}.body) THEN substr(json_extract(${alias}.body,'$.format'),1,100) ELSE NULL END AS body_format`;
export function createRecordReads(
  db: D1Database,
  owner: string,
  workspace: string,
  suppliedProfile?: CheckedAuditedSourceProfile,
) {
  const profile =
    suppliedProfile === undefined
      ? undefined
      : parseAuditedSourceProfile(suppliedProfile);
  const schemas = profile ? createAuditedSchemas(profile) : undefined;
  if (profile)
    demand(
      profile.workspace.ownerId === owner &&
        profile.workspace.workspaceId === workspace,
      "operation-denied",
    );
  const store = createRecoveryStore(db, owner);
  function after(cursor: string | null, scope: string) {
    if (cursor === null) return "";
    const value = cursorSchema.parse(JSON.parse(decodeURIComponent(cursor)));
    demand(
      value.owner === owner &&
        value.workspace === workspace &&
        value.scope === scope,
      "operation-denied",
    );
    return value.after;
  }
  function cursor(scope: string, last: string) {
    return encodeURIComponent(
      JSON.stringify({ v: 1, owner, workspace, scope, after: last }),
    );
  }
  async function workspaceBound() {
    const saved = await db
      .prepare("SELECT workspace_id FROM recovery_workspaces WHERE owner=?")
      .bind(owner)
      .first<{ workspace_id: string }>();
    if (saved) {
      demand(saved.workspace_id === workspace, "operation-denied");
      return;
    }
    const receipt = await db
      .prepare(
        `SELECT CASE WHEN length(CAST(source_snapshot AS BLOB))<=${MAX_AUDITED_PLAN_BYTES} THEN source_snapshot ELSE NULL END AS source_snapshot FROM recovery_import_baselines WHERE owner=? AND source_table='audited_json' AND source_kind='import_receipt'`,
      )
      .bind(owner)
      .first<{ source_snapshot: string }>();
    if (receipt) {
      demand(
        typeof receipt.source_snapshot === "string" &&
          encoder.encode(receipt.source_snapshot).length <=
            MAX_AUDITED_PLAN_BYTES,
        "operation-denied",
      );
      const selected = z
        .object({
          workspace: z.object({ ownerId: z.string(), workspaceId: z.string() }),
        })
        .parse(JSON.parse(receipt.source_snapshot));
      demand(
        selected.workspace.ownerId === owner &&
          selected.workspace.workspaceId === workspace,
        "operation-denied",
      );
      return;
    }
    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM records WHERE owner=?")
      .bind(owner)
      .first<{ n: number }>();
    demand(count?.n === 0, "operation-denied");
  }
  async function records(input: InputById["job-stack.records.read.v1"]) {
    await workspaceBound();
    const canonicalKind = kindMap[input.kind] ?? input.kind;
    const detail = "entityId" in input;
    const scope = "records:" + input.kind;
    const start = detail ? "" : after(input.cursor, scope);
    const rows = (
      await db
        .prepare(
          `SELECT r.id,${boundedBody("r")},CAST(r.revision AS TEXT) AS revision,r.updated_at,p.lineage_id,p.version_id,1 AS legacy_present,COALESCE((SELECT CASE WHEN length(CAST(b.source_snapshot AS BLOB))>${MAX_AUDITED_PLAN_BYTES} THEN 2 WHEN json_extract(b.source_snapshot,'$.body.format') IN ('audited-legacy-role-v1','audited-profile-role-v2') THEN 1 ELSE 0 END FROM recovery_import_baselines b WHERE b.owner=r.owner AND b.source_table='records' AND b.source_kind=r.kind AND b.source_id=r.id),0) AS audited_baseline FROM records r LEFT JOIN recovery_projections p ON p.owner=r.owner AND p.workspace_id=? AND p.kind=? AND p.entity_id=r.id WHERE r.owner=? AND r.kind=? AND r.id${detail ? "=" : ">"}?
      UNION ALL SELECT p.entity_id AS id,${boundedBody("p")},'1' AS revision,CAST(json_extract(v.manifest,'$.createdAt') AS INTEGER) AS updated_at,p.lineage_id,p.version_id,0 AS legacy_present,0 AS audited_baseline FROM recovery_projections p JOIN recovery_versions v ON v.owner=p.owner AND v.workspace_id=p.workspace_id AND v.version_id=p.version_id WHERE p.owner=? AND p.workspace_id=? AND p.kind=? AND p.entity_id${detail ? "=" : ">"}? AND NOT EXISTS(SELECT 1 FROM records r WHERE r.owner=p.owner AND r.kind=? AND r.id=p.entity_id) ORDER BY id LIMIT ?`,
        )
        .bind(
          workspace,
          canonicalKind,
          owner,
          input.kind,
          detail ? input.entityId : start,
          owner,
          workspace,
          canonicalKind,
          detail ? input.entityId : start,
          input.kind,
          detail ? 1 : 101,
        )
        .all()
    ).results.map((r) => {
      const checked = rowSchema.safeParse(r);
      demand(checked.success, "operation-denied");
      return checked.data;
    });
    // One promise per records invocation, shared by all selected rows and detail.
    // No retained cross-request cache or per-row source reconstruction.
    let retained: ReturnType<typeof reconstructAuditedRead> | undefined;
    function retainedPlan() {
      demand(profile, "operation-denied");
      return (retained ??= reconstructAuditedRead(
        db,
        owner,
        workspace,
        profile,
      ).catch(() => {
        demand(false, "operation-denied");
      }));
    }
    async function project(row: z.infer<typeof rowSchema>) {
      let body: JsonValue = null,
        bodyStatus: "available" | "invalid_json" | "too_large" = "available";
      try {
        if ((row.body_size ?? encoder.encode(row.body).length) > 54000)
          bodyStatus = "too_large";
        else body = JSON.parse(row.body);
      } catch {
        bodyStatus = "invalid_json";
      }
      const format = z.object({ format: z.string() }).safeParse(body);
      const imported = schemas?.role.safeParse(body);
      if (row.body_format?.startsWith("audited-"))
        demand(bodyStatus === "available", "operation-denied");
      if (format.success && format.data.format.startsWith("audited-")) {
        demand(profile && imported?.success, "operation-denied");
        demand(
          imported.data.source.seriesId === profile.seriesId &&
            row.body === JSON.stringify(imported.data),
          "operation-denied",
        );
        if (profile.identityMode === "legacy-v1")
          demand(
            imported.data.source.bundleDigest ===
              profile.legacyBinding.bundleDigest &&
              imported.data.import.observedAt ===
                profile.legacyBinding.importObservedAt,
            "operation-denied",
          );
      }
      const reconstructed = imported?.success
        ? await retainedPlan()
        : undefined;
      if (imported?.success) {
        demand(reconstructed, "operation-denied");
        verifyAuditedRecord(row, imported.data, reconstructed);
      }
      let base = {
        kind: input.kind,
        entityId: row.id,
        revision: row.revision as string | null,
        updatedAt: row.updated_at,
      };
      let history:
        | {
            origin: "domain_record" | "legacy_import";
            history: "legacy_unversioned";
          }
        | {
            origin: "domain_record" | "generic_archive";
            history: "versioned";
            lineageId: string;
            versionId: string;
            manifestDigest: string;
          } = {
        origin: imported?.success ? "legacy_import" : "domain_record",
        history: "legacy_unversioned",
      };
      if (row.version_id && row.lineage_id) {
        const version = await store.getVersion(row.version_id);
        demand(
          version &&
            version.workspace.ownerId === owner &&
            version.workspace.workspaceId === workspace &&
            version.versionId === row.version_id &&
            version.entityId === row.id &&
            version.lineageId === row.lineage_id &&
            version.kind === canonicalKind,
          "operation-denied",
        );
        const identity = await db
          .prepare(
            "SELECT manifest_digest FROM recovery_versions WHERE owner=? AND workspace_id=? AND version_id=?",
          )
          .bind(owner, workspace, row.version_id)
          .first<{ manifest_digest: string }>();
        demand(
          identity &&
            identity.manifest_digest ===
              (await hashEnvelope("manifest", version)),
          "operation-denied",
        );
        const domain = domainRecordSnapshotSchema.safeParse(
          version.recordSnapshot,
        );
        if (row.legacy_present) {
          demand(domain.success, "operation-denied");
          if (
            domain.data.entityId === row.id &&
            domain.data.recordKind === input.kind &&
            domain.data.revision.toString() === row.revision &&
            domain.data.updatedAt === row.updated_at &&
            bodyStatus === "available" &&
            canonicalJson(domain.data.body) === canonicalJson(body)
          )
            history = {
              origin: "domain_record",
              history: "versioned",
              lineageId: row.lineage_id,
              versionId: row.version_id,
              manifestDigest: identity.manifest_digest,
            };
        } else {
          demand(
            !domain.success &&
              canonicalJson(version.recordSnapshot) ===
                canonicalJson(JSON.parse(row.body)),
            "operation-denied",
          );
          history = {
            origin: "generic_archive",
            history: "versioned",
            lineageId: row.lineage_id,
            versionId: row.version_id,
            manifestDigest: identity.manifest_digest,
          };
          base = { ...base, revision: null, updatedAt: version.createdAt };
        }
      }
      // Immutable imported provenance is independent of mutable body/configuration.
      // The current namespace is an additional defense, never its only source.
      // A fully checked matching canonical domain version keeps its existing path.
      if (
        (row.audited_baseline === 1 ||
          (profile &&
            row.legacy_present &&
            row.id.startsWith(profile.recordIds.recordPrefix + "_"))) &&
        !imported?.success
      )
        demand(
          history.origin === "domain_record" && history.history === "versioned",
          "operation-denied",
        );
      let provenance: unknown = null;
      if (detail && imported?.success) {
        demand(profile && reconstructed, "operation-denied");
        const sources = reconstructed.sources;
        const main = sources.find(
          (v) =>
            v.rawSha256 === imported.data.source.rawSha256 &&
            v.name === profile.sources.main.label,
        );
        demand(main, "operation-denied");
        const root = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(main.rawUtf8));
        const context = Object.fromEntries(
          Object.entries(root).filter(
            ([key]) =>
              ![
                "direct_opportunities",
                "digest_listings",
                "excluded_already_engaged",
                "post_cutoff_new_leads",
                "coordination_runs",
              ].includes(key),
          ),
        );
        const sourceReceipts = sources.map(
          ({ name, rawSha256, sizeBytes }) => ({ name, rawSha256, sizeBytes }),
        );
        const fits =
          encoder.encode(
            JSON.stringify({
              ...history,
              ...base,
              body,
              bodyStatus,
              provenance: {
                format: "audited-source-context-v1",
                status: "available",
                sourceReceipts,
                context,
              },
            }),
          ).length <= 64000;
        provenance = {
          format: "audited-source-context-v1",
          status: fits ? "available" : "too_large",
          sourceReceipts,
          context: fits ? context : null,
        };
      }
      return detail
        ? { ...history, ...base, body, bodyStatus, provenance }
        : { ...history, ...base };
    }
    if (detail) return { record: rows[0] ? await project(rows[0]) : null };
    const items = [];
    let last = start;
    for (const row of rows.slice(0, 100)) {
      const item = await project(row);
      if (
        encoder.encode(
          JSON.stringify({
            items: [...items, item],
            nextCursor: cursor(scope, row.id),
          }),
        ).length > 64000
      )
        break;
      items.push(item);
      last = row.id;
    }
    demand(!rows.length || items.length > 0, "operation-output-invalid");
    return {
      items,
      nextCursor: rows.length > items.length ? cursor(scope, last) : null,
    };
  }
  async function version(id: string) {
    await workspaceBound();
    const value = await store.getVersion(id);
    demand(
      value &&
        value.workspace.ownerId === owner &&
        value.workspace.workspaceId === workspace &&
        value.versionId === id,
      "operation-denied",
    );
    const stored = await db
      .prepare(
        "SELECT manifest_digest FROM recovery_versions WHERE owner=? AND workspace_id=? AND version_id=?",
      )
      .bind(owner, workspace, id)
      .first<{ manifest_digest: string }>();
    demand(
      stored &&
        stored.manifest_digest === (await hashEnvelope("manifest", value)),
      "operation-denied",
    );
    return value;
  }
  async function versions(input: InputById["job-stack.version.list.v1"]) {
    await workspaceBound();
    const scope = "versions:" + input.lineageId;
    const start = after(input.cursor, scope);
    const rows = (
      await db
        .prepare(
          "SELECT version_id,manifest FROM recovery_versions WHERE owner=? AND workspace_id=? AND lineage_id=? AND version_id>? ORDER BY version_id LIMIT 101",
        )
        .bind(owner, workspace, input.lineageId, start)
        .all()
    ).results;
    const items = [];
    let last = start;
    for (const row of rows.slice(0, 100)) {
      const parsed = z
        .object({ version_id: z.string(), manifest: z.string() })
        .parse(row);
      const v = await version(parsed.version_id);
      demand(v.lineageId === input.lineageId, "operation-denied");
      const item = {
        versionId: v.versionId,
        lineageId: v.lineageId,
        entityId: v.entityId,
        kind: v.kind,
        parentVersionIds: v.parentVersionIds,
        createdAt: v.createdAt,
        approval: v.approval.state,
      };
      if (
        encoder.encode(
          JSON.stringify({
            items: [...items, item],
            nextCursor: cursor(scope, parsed.version_id),
          }),
        ).length > 64000
      )
        break;
      items.push(item);
      last = parsed.version_id;
    }
    demand(!rows.length || items.length > 0, "operation-output-invalid");
    return {
      items,
      nextCursor: rows.length > items.length ? cursor(scope, last) : null,
    };
  }
  return {
    records,
    async pipelinePage(input: InputById["job-stack.pipeline.page.read.v1"]) {
      await workspaceBound();
      demand(input.workspaceId === workspace, "operation-denied");
      if (!profile) throw Error("operation-unavailable");
      return readPipelinePage(db, owner, workspace, profile, input);
    },
    version,
    versions,
    async request(key: string) {
      await workspaceBound();
      const identity = await db
        .prepare(
          "SELECT workspace_id FROM recovery_request_results WHERE owner=? AND request_key=?",
        )
        .bind(owner, key)
        .first<{ workspace_id: string }>();
      demand(
        identity === null || identity.workspace_id === workspace,
        "operation-denied",
      );
      const result = await store.findRequest(key);
      if (result) await version(result.versionId);
      return { result };
    },
    async protection(id: string) {
      const manifest = await version(id);
      const projection = await db
        .prepare(
          "SELECT view FROM recovery_protection WHERE owner=? AND workspace_id=? AND version_id=?",
        )
        .bind(owner, workspace, manifest.versionId)
        .first<{ view: string }>();
      demand(projection, "operation-denied");
      const view = protectionViewSchema.parse(
        parseEnvelopeJson(projection.view),
      );
      demand(view.versionId === manifest.versionId, "operation-denied");
      return view;
    },
  };
}
