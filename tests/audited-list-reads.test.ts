import { expect, it } from "vitest";
import { hashEnvelope } from "../src/domain/recovery-canonical";
import {
  versionManifestSchema,
  type VersionManifest,
} from "../src/domain/recovery";
import { opportunityBody, snapshot } from "./fixtures/domain-preparation";
import { createRecordReads } from "../src/application/record-reads";
import { parseAuditedSourceProfile } from "../src/application/audited-source-profile";
import { planAuditedImport } from "../src/application/audited-legacy-import";
import {
  fixtureLegacyInput,
  fixtureLegacyProfile,
} from "./fixtures/audited-legacy-profile";

const plan = planAuditedImport(fixtureLegacyInput, fixtureLegacyProfile);
const sourceRows = plan.sources.map((source) => ({
  source_snapshot: JSON.stringify(source),
}));
type FixtureRow = {
  id: string;
  body: string;
  revision: string;
  updated_at: number;
  lineage_id: string | null;
  version_id: string | null;
  legacy_present: number;
  audited_baseline: number;
};
const rows: FixtureRow[] = plan.records
  .map((row) => ({
    id: row.id,
    body: JSON.stringify(row.body),
    revision: "1",
    updated_at: row.updatedAt,
    lineage_id: null,
    version_id: null,
    legacy_present: 1,
    audited_baseline: 1,
  }))
  .sort((a, b) => (a.id < b.id ? -1 : 1));
function database(
  hasWorkspace = true,
  changedRows = rows,
  version?: { manifest: VersionManifest | null; digest?: string },
) {
  const trace: string[] = [];
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...input: unknown[]) {
          values = input;
          return statement;
        },
        async first() {
          trace.push(sql);
          if (sql.includes("SELECT manifest AS body"))
            return version?.manifest
              ? { body: JSON.stringify(version.manifest) }
              : null;
          if (sql.includes("SELECT manifest_digest"))
            return { manifest_digest: version?.digest };
          if (sql.includes("SELECT workspace_id"))
            return hasWorkspace
              ? { workspace_id: plan.workspace.workspaceId }
              : null;
          if (sql.includes("source_count"))
            return {
              source_count: sourceRows.length,
              serialized_bytes: sourceRows.reduce(
                (total, row) =>
                  total + new TextEncoder().encode(row.source_snapshot).length,
                0,
              ),
            };
          if (sql.includes("source_kind='import_receipt'"))
            return { source_snapshot: JSON.stringify(plan.receipt) };
          throw Error("unexpected-fixture-query");
        },
        async all() {
          trace.push(sql);
          if (sql.includes("source_kind='raw_input'"))
            return { results: sourceRows };
          if (sql.includes("SELECT r.id"))
            return {
              results: changedRows
                .filter((row) =>
                  sql.includes("r.id=?")
                    ? row.id === values[4]
                    : row.id > String(values[4]),
                )
                .slice(0, Number(values.at(-1))),
            };
          throw Error("unexpected-fixture-query");
        },
      };
      return statement;
    },
  };
  // Closed D1 read-port stub runs the actual reader and records executed statements.
  return { db: db as unknown as D1Database, trace };
}
function read(
  db: D1Database,
  profile = fixtureLegacyProfile,
  cursor: string | null = null,
) {
  return createRecordReads(
    db,
    plan.workspace.ownerId,
    plan.workspace.workspaceId,
    profile,
  ).records({
    workspaceId: plan.workspace.workspaceId,
    kind: "opportunity",
    cursor,
  });
}
it.each([true, false])(
  "legacy lists deny substituted full pins and finite allocation, workspace row=%s",
  async (hasWorkspace) => {
    if (fixtureLegacyProfile.identityMode !== "legacy-v1")
      throw Error("fixture-legacy-profile");
    const invalid = [
      parseAuditedSourceProfile({
        ...fixtureLegacyProfile,
        legacyBinding: {
          ...fixtureLegacyProfile.legacyBinding,
          planSha256: "0".repeat(64),
        },
      }),
      parseAuditedSourceProfile({
        ...fixtureLegacyProfile,
        recordIds: {
          ...fixtureLegacyProfile.recordIds,
          recordPrefix: "substituted_fixture",
        },
      }),
    ];
    for (const profile of invalid) {
      expect(() => planAuditedImport(fixtureLegacyInput, profile)).toThrow(
        "AUDIT_LEGACY_BINDING",
      );
      await expect(read(database(hasWorkspace).db, profile)).rejects.toThrow(
        "operation-denied",
      );
    }
  },
);
it.each([true, false])(
  "legacy lists deny changed body, ID, revision or time, workspace row=%s",
  async (hasWorkspace) => {
    const first = rows[0];
    if (!first) throw Error("fixture-role");
    const body = JSON.parse(
      first.body,
    ) as (typeof plan.records)[number]["body"];
    const changes = [
      {
        ...first,
        body: JSON.stringify({
          ...body,
          raw: { ...body.raw, unknown: { changed: true } },
        }),
      },
      { ...first, id: "fixture_records_FXD000" },
      { ...first, body: JSON.stringify({ fixture: true }) },
      { ...first, body: "{invalid-fixture-json" },
      { ...first, revision: "2" },
      { ...first, updated_at: 101 },
    ];
    for (const row of changes)
      await expect(read(database(hasWorkspace, [row]).db)).rejects.toThrow(
        "operation-denied",
      );
  },
);
it.each([true, false])(
  "one bounded reconstruction per 100-row page/detail, workspace row present=%s",
  async (hasWorkspace) => {
    const { db, trace } = database(hasWorkspace);
    const reader = createRecordReads(
      db,
      plan.workspace.ownerId,
      plan.workspace.workspaceId,
      fixtureLegacyProfile,
    );
    const one = await reader.records({
      workspaceId: plan.workspace.workspaceId,
      kind: "opportunity",
      cursor: null,
    });
    expect("items" in one ? one.items?.length : null).toBe(100);
    const count = hasWorkspace ? 5 : 6;
    expect(trace).toHaveLength(count);
    expect(
      trace.filter(
        (sql) => sql.includes("source_count") && !sql.includes("WITH selected"),
      ),
    ).toHaveLength(1);
    expect(trace.filter((sql) => sql.includes("WITH selected"))).toHaveLength(
      1,
    );
    expect(
      trace.filter((sql) => sql.includes("source_kind='import_receipt'")),
    ).toHaveLength(hasWorkspace ? 1 : 2);
    if (!("nextCursor" in one) || !one.nextCursor)
      throw Error("fixture-next-page");
    const two = await reader.records({
      workspaceId: plan.workspace.workspaceId,
      kind: "opportunity",
      cursor: one.nextCursor,
    });
    expect("items" in two ? two.items?.length : null).toBe(37);
    expect(trace).toHaveLength(count * 2);
    const selected = rows[0];
    if (!selected) throw Error("fixture-role");
    const detail = database(hasWorkspace);
    const result = await createRecordReads(
      detail.db,
      plan.workspace.ownerId,
      plan.workspace.workspaceId,
      fixtureLegacyProfile,
    ).records({
      workspaceId: plan.workspace.workspaceId,
      kind: "opportunity",
      entityId: selected.id,
    });
    expect("record" in result && result.record?.entityId).toBe(selected.id);
    expect(detail.trace).toHaveLength(count);
  },
);

it.each([true, false])(
  "verified canonical domain history remains readable; hints cannot bypass proof, workspace row=%s",
  async (hasWorkspace) => {
    const first = rows[0];
    if (!first) throw Error("fixture-role");
    const body = { ...opportunityBody, id: first.id };
    const manifest = versionManifestSchema.parse({
      schemaVersion: 1,
      canonicalizationVersion: "jcs-rfc8785-v1",
      hashAlgorithm: "sha256-domain-v1",
      workspace: plan.workspace,
      epochId: "fixture-epoch",
      sequence: "1",
      transactionId: "fixture-transaction",
      versionId: "fixture-version",
      lineageId: "fixture-lineage",
      entityId: first.id,
      kind: "opportunity",
      parentVersionIds: [],
      branchRequested: false,
      sourceVersionIds: [],
      recordSnapshot: snapshot("opportunity", first.id, 2, body, 1000),
      artifacts: [],
      approval: { state: "draft", evidenceVersionIds: [] },
      actorId: plan.workspace.ownerId,
      createdAt: 1000,
      generationRecipe: null,
      recoveryLocator: {
        workspaceId: plan.workspace.workspaceId,
        lineageId: "fixture-lineage",
        formatVersion: 1,
        namespace: "fixture-recovery",
        archives: [{ provider: "primary", namespace: "fixture-recovery" }],
        trustRootIds: ["fixture-root"],
      },
    });
    const digest = await hashEnvelope("manifest", manifest);
    const canonical = {
      ...first,
      body: JSON.stringify(body),
      revision: "2",
      updated_at: 1000,
      lineage_id: manifest.lineageId,
      version_id: manifest.versionId,
    };
    const proof = { manifest, digest };
    const valid = database(hasWorkspace, [canonical], proof);
    const result = await read(valid.db);
    expect(result.items?.[0]?.history).toBe("versioned");
    expect(result.items?.[0]?.origin).toBe("domain_record");
    expect(valid.trace).toHaveLength(hasWorkspace ? 4 : 5);
    const detail = await createRecordReads(
      database(hasWorkspace, [canonical], proof).db,
      plan.workspace.ownerId,
      plan.workspace.workspaceId,
      fixtureLegacyProfile,
    ).records({
      workspaceId: plan.workspace.workspaceId,
      kind: "opportunity",
      entityId: first.id,
    });
    expect(detail.record?.history).toBe("versioned");
    for (const [row, evidence] of [
      [canonical, { manifest: null, digest }],
      [canonical, { manifest, digest: "0".repeat(64) }],
      [{ ...canonical, body: JSON.stringify({ fixture: true }) }, proof],
      [{ ...canonical, revision: "3" }, proof],
      [{ ...canonical, updated_at: 1001 }, proof],
    ] as const)
      await expect(
        read(database(hasWorkspace, [row], evidence).db),
      ).rejects.toThrow("operation-denied");
    if (fixtureLegacyProfile.identityMode !== "legacy-v1")
      throw Error("fixture-legacy-profile");
    const invalid = parseAuditedSourceProfile({
      ...fixtureLegacyProfile,
      legacyBinding: {
        ...fixtureLegacyProfile.legacyBinding,
        planSha256: "0".repeat(64),
      },
    });
    await expect(
      read(
        database(
          true,
          [
            {
              ...first,
              lineage_id: manifest.lineageId,
              version_id: manifest.versionId,
            },
          ],
          proof,
        ).db,
        invalid,
      ),
    ).rejects.toThrow("operation-denied");
  },
);
