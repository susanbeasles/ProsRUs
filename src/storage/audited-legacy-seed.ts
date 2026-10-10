import { createHash } from "node:crypto";
import { z } from "zod";
import { demand } from "../domain/model";
import {
  planAuditedImport,
  type AuditedImportPlan,
  createAuditedSchemas,
} from "../application/audited-legacy-import";
import {
  parseAuditedSourceProfile,
  type CheckedAuditedSourceProfile,
} from "../application/audited-source-profile";
type Workspace = AuditedImportPlan["workspace"];
export type LocalSeedPorts = {
  mode: "local-miniflare";
  db: D1Database;
  currentWorkspace: () => Promise<Workspace>;
  readOriginalCopy: (name: string) => Promise<Uint8Array>;
};
const hash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
const encode = (value: unknown) => JSON.stringify(value);
/** Private offline entry only. No route, provider or production target is accepted. */
export async function seedAuditedLegacy(
  ports: LocalSeedPorts,
  requested: AuditedImportPlan,
  suppliedProfile: CheckedAuditedSourceProfile,
) {
  demand(ports.mode === "local-miniflare", "AUDIT_LOCAL_TARGET_REQUIRED");
  const profile = parseAuditedSourceProfile(suppliedProfile);
  const { source: auditedSourceSchema, role: auditedRoleSchema } =
    createAuditedSchemas(profile);
  const { db } = ports;
  const owner = requested.workspace.ownerId;
  const originalSources = requested.sources.map((s) => ({
    name: s.name,
    bytes: new TextEncoder().encode(s.rawUtf8),
    receipt: s.sourceReceipt,
  }));
  function rebuild(observedAt: number) {
    return planAuditedImport(
      {
        sources: originalSources,
        workspace: requested.workspace,
        seriesId: requested.seriesId,
        observedAt,
      },
      profile,
    );
  }
  const expected = rebuild(requested.receipt.importObservedAt);
  demand(encode(expected) === encode(requested), "AUDIT_PLAN_MISMATCH");
  async function authority() {
    const current = await ports.currentWorkspace();
    demand(
      current.ownerId === requested.workspace.ownerId &&
        current.workspaceId === requested.workspace.workspaceId,
      "AUDIT_WORKSPACE_MISMATCH",
    );
  }
  async function originals() {
    for (const source of expected.sources) {
      const copy = await ports.readOriginalCopy(source.name);
      demand(
        copy instanceof Uint8Array &&
          copy.length === source.sizeBytes &&
          hash(copy) === source.rawSha256,
        "AUDIT_ORIGINAL_READBACK",
      );
    }
  }
  async function retained() {
    const row = await db
      .prepare(
        "SELECT source_snapshot FROM recovery_import_baselines WHERE owner=? AND source_table='audited_json' AND source_kind='import_receipt' AND source_id=?",
      )
      .bind(owner, requested.seriesId)
      .first<{ source_snapshot: string }>();
    if (row === null) return null;
    const value: unknown = JSON.parse(row.source_snapshot);
    demand(row.source_snapshot === encode(value), "AUDIT_IMPORT_UNVERIFIED");
    return value;
  }
  async function verify(value: unknown) {
    const identity = z
      .object({
        bundleDigest: z.string(),
        importObservedAt: z.number().int().nonnegative(),
        workspace: z.object({ ownerId: z.string(), workspaceId: z.string() }),
      })
      .parse(value);
    demand(
      identity.bundleDigest === expected.receipt.bundleDigest &&
        identity.workspace.ownerId === owner &&
        identity.workspace.workspaceId === requested.workspace.workspaceId,
      "AUDIT_IMPORT_CONFLICT",
    );
    const pinned = rebuild(identity.importObservedAt);
    demand(encode(value) === encode(pinned.receipt), "AUDIT_IMPORT_UNVERIFIED");
    for (const source of pinned.sources) {
      const row = await db
        .prepare(
          "SELECT source_snapshot,archive_state FROM recovery_import_baselines WHERE owner=? AND source_table='audited_json' AND source_kind='raw_input' AND source_id=?",
        )
        .bind(owner, source.rawSha256)
        .first<{ source_snapshot: string; archive_state: string }>();
      demand(row && row.archive_state === "pending", "AUDIT_IMPORT_UNVERIFIED");
      demand(row.source_snapshot === encode(source), "AUDIT_IMPORT_UNVERIFIED");
      const parsed = auditedSourceSchema.parse(JSON.parse(row.source_snapshot));
      const bytes = new TextEncoder().encode(parsed.rawUtf8);
      demand(
        encode(parsed) === encode(source) &&
          bytes.length === source.sizeBytes &&
          hash(bytes) === source.rawSha256,
        "AUDIT_IMPORT_UNVERIFIED",
      );
    }
    for (const record of pinned.records) {
      const row = await db
        .prepare(
          "SELECT body,revision,updated_at FROM records WHERE owner=? AND kind='opportunity' AND id=?",
        )
        .bind(owner, record.id)
        .first<{ body: string; revision: number; updated_at: number }>();
      demand(
        row &&
          row.body === encode(record.body) &&
          row.revision === 1 &&
          row.updated_at === pinned.receipt.importObservedAt &&
          encode(auditedRoleSchema.parse(JSON.parse(row.body))) ===
            encode(record.body),
        "AUDIT_IMPORT_UNVERIFIED",
      );
      const baseline = await db
        .prepare(
          "SELECT source_snapshot,archive_state FROM recovery_import_baselines WHERE owner=? AND source_table='records' AND source_kind='opportunity' AND source_id=?",
        )
        .bind(owner, record.id)
        .first<{ source_snapshot: string; archive_state: string }>();
      demand(
        baseline &&
          baseline.archive_state === "pending" &&
          baseline.source_snapshot ===
            encode({
              body: record.body,
              revision: "1",
              updatedAt: record.updatedAt,
            }),
        "AUDIT_IMPORT_UNVERIFIED",
      );
    }
    await originals();
    await authority();
    return pinned.receipt;
  }
  await authority();
  await originals();
  const prior = await retained();
  if (prior !== null) return verify(prior);
  function baseline(
    table: string,
    kind: string,
    id: string,
    revision: string | null,
    snapshot: unknown,
  ) {
    return db
      .prepare(
        "INSERT INTO recovery_import_baselines(owner,source_table,source_kind,source_id,source_revision,source_snapshot,provenance,artifact_availability,archive_state,schema_version) VALUES(?,?,?,?,?,?,'imported_legacy_baseline','not_applicable','pending',1)",
      )
      .bind(owner, table, kind, id, revision, encode(snapshot));
  }
  const statements = [
    db
      .prepare(
        "SELECT CASE WHEN EXISTS(SELECT 1 FROM recovery_workspaces WHERE owner=? AND workspace_id<>?) OR EXISTS(SELECT 1 FROM recovery_import_baselines WHERE owner=? AND source_table='audited_json' AND source_kind='import_receipt' AND json_extract(source_snapshot,'$.workspace.workspaceId')<>?) THEN json('AUDIT_WORKSPACE_MISMATCH') ELSE 1 END AS permitted",
      )
      .bind(
        owner,
        requested.workspace.workspaceId,
        owner,
        requested.workspace.workspaceId,
      ),
    baseline(
      "audited_json",
      "import_receipt",
      expected.seriesId,
      null,
      expected.receipt,
    ),
  ];
  for (const record of expected.records) {
    statements.push(
      db
        .prepare(
          "INSERT INTO records(owner,kind,id,body,revision,updated_at) VALUES(?,'opportunity',?,?,1,?)",
        )
        .bind(owner, record.id, encode(record.body), record.updatedAt),
      baseline("records", "opportunity", record.id, "1", {
        body: record.body,
        revision: "1",
        updatedAt: record.updatedAt,
      }),
    );
  }
  for (const source of expected.sources)
    statements.push(
      baseline("audited_json", "raw_input", source.rawSha256, null, source),
    );
  await authority();
  try {
    await db.batch(statements);
  } catch (error) {
    const winner = await retained();
    if (winner !== null) return verify(winner);
    throw error;
  }
  const saved = await retained();
  demand(saved !== null, "AUDIT_IMPORT_UNVERIFIED");
  return verify(saved);
}
