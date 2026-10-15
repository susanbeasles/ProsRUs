import { expect, it } from "vitest";
import { createRecordReads } from "../src/application/record-reads";
import {
  parseAuditedSourceProfile,
  type CheckedAuditedSourceProfile,
} from "../src/application/audited-source-profile";
import { planAuditedImport } from "../src/application/audited-legacy-import";
import { hashEnvelope } from "../src/domain/recovery-canonical";
import {
  versionManifestSchema,
  type VersionManifest,
} from "../src/domain/recovery";
import { opportunityBody, snapshot } from "./fixtures/domain-preparation";
import {
  fixtureLegacyInput,
  fixtureLegacyProfile,
} from "./fixtures/audited-legacy-profile";
import { fixtureProfile } from "./fixtures/audited-profile-inputs";

const profiles = [
  fixtureLegacyProfile,
  parseAuditedSourceProfile(fixtureProfile),
] as const;
type Row = {
  id: string;
  body: string;
  revision: string;
  updated_at: number;
  lineage_id: string | null;
  version_id: string | null;
  legacy_present: number;
  audited_baseline?: unknown;
};
function fixture(profile: CheckedAuditedSourceProfile) {
  const plan = planAuditedImport(fixtureLegacyInput, profile);
  const first = plan.records[0];
  if (!first) throw Error("fixture-role");
  const row: Row = {
    id: first.id,
    body: JSON.stringify(first.body),
    revision: "1",
    updated_at: first.updatedAt,
    lineage_id: null,
    version_id: null,
    legacy_present: 1,
    audited_baseline: 1,
  };
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
  const canonical: Row = {
    ...row,
    body: JSON.stringify(body),
    revision: "2",
    updated_at: 1000,
    lineage_id: manifest.lineageId,
    version_id: manifest.versionId,
  };
  function database(
    hasWorkspace: boolean,
    selected: Row,
    proof?: { manifest: VersionManifest; digest: string },
  ) {
    const trace: string[] = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() {
            return statement;
          },
          async first() {
            trace.push(sql);
            if (sql.includes("SELECT workspace_id"))
              return hasWorkspace
                ? { workspace_id: plan.workspace.workspaceId }
                : null;
            if (sql.includes("source_kind='import_receipt'"))
              return { source_snapshot: JSON.stringify(plan.receipt) };
            if (sql.includes("SELECT manifest AS body"))
              return proof ? { body: JSON.stringify(proof.manifest) } : null;
            if (sql.includes("SELECT manifest_digest"))
              return { manifest_digest: proof?.digest };
            throw Error("unexpected-fixture-first");
          },
          async all() {
            trace.push(sql);
            if (sql.includes("SELECT r.id")) return { results: [selected] };
            throw Error("unexpected-fixture-all");
          },
        };
        return statement;
      },
    };
    // Closed D1 read port; actual reader/store parser verifies the manifest and row.
    return { db: db as unknown as D1Database, trace };
  }
  function read(
    db: D1Database,
    detail: boolean,
    selectedProfile?: CheckedAuditedSourceProfile,
  ) {
    return createRecordReads(
      db,
      plan.workspace.ownerId,
      plan.workspace.workspaceId,
      selectedProfile,
    ).records({
      workspaceId: plan.workspace.workspaceId,
      kind: "opportunity",
      ...(detail ? { entityId: row.id } : { cursor: null }),
    });
  }
  return { plan, row, canonical, manifest, database, read };
}
for (const profile of profiles)
  for (const hasWorkspace of [true, false])
    for (const detail of [true, false]) {
      const label = `${profile.identityMode}, workspace=${hasWorkspace}, detail=${detail}`;
      it(`canonical imported history binds exact manifest owner/version keys: ${label}`, async () => {
        const f = fixture(profile);
        for (const field of ["owner", "version"] as const) {
          const changed = versionManifestSchema.parse(
            field === "owner"
              ? {
                  ...f.manifest,
                  workspace: {
                    ...f.manifest.workspace,
                    ownerId: "other_fixture_owner",
                  },
                }
              : { ...f.manifest, versionId: "other_fixture_version" },
          );
          await expect(
            f.read(
              f.database(hasWorkspace, f.canonical, {
                manifest: changed,
                digest: await hashEnvelope("manifest", changed),
              }).db,
              detail,
              profile,
            ),
          ).rejects.toThrow("operation-denied");
        }
      });
      it(`immutable import marker denies stripped bodies with absent/changed profile: ${label}`, async () => {
        const f = fixture(profile);
        const changed = parseAuditedSourceProfile({
          ...profile,
          recordIds: {
            ...profile.recordIds,
            recordPrefix: "substituted_fixture",
          },
        });
        for (const selected of [undefined, changed])
          await expect(
            f.read(
              f.database(hasWorkspace, {
                ...f.row,
                body: JSON.stringify({ fixture: true }),
              }).db,
              detail,
              selected,
            ),
          ).rejects.toThrow("operation-denied");
      });
      it(`fully verified canonical history survives checked profile allocation changes: ${label}`, async () => {
        const f = fixture(profile);
        const changed = parseAuditedSourceProfile({
          ...profile,
          recordIds: {
            ...profile.recordIds,
            recordPrefix: "substituted_fixture",
          },
        });
        for (const selected of [profile, undefined, changed]) {
          const port = f.database(hasWorkspace, f.canonical, {
            manifest: f.manifest,
            digest: await hashEnvelope("manifest", f.manifest),
          });
          const result = await f.read(port.db, detail, selected);
          expect(
            detail ? result.record?.history : result.items?.[0]?.history,
          ).toBe("versioned");
          expect(port.trace).toHaveLength(hasWorkspace ? 4 : 5);
        }
      });
    }
it.each([true, false])(
  "ordinary generic records remain readable with workspace=%s",
  async (hasWorkspace) => {
    const f = fixture(profiles[0]);
    const ordinary = {
      ...f.row,
      id: "ordinary_fixture",
      body: JSON.stringify({ fixture: true }),
      audited_baseline: 0,
    };
    const result = await f.read(f.database(hasWorkspace, ordinary).db, false);
    expect(result.items?.[0]?.origin).toBe("domain_record");
    expect(result.items?.[0]?.history).toBe("legacy_unversioned");
  },
);
it("missing/malformed/oversized immutable marker metadata cannot silently become generic", async () => {
  const f = fixture(profiles[0]);
  for (const audited_baseline of [undefined, null, "1", -1, 2]) {
    await expect(
      f.read(
        f.database(true, {
          ...f.row,
          id: "ordinary_fixture",
          body: JSON.stringify({ fixture: true }),
          audited_baseline,
        }).db,
        false,
      ),
    ).rejects.toThrow();
  }
});
it.each([true, false])(
  "projection-only generic archive keeps explicit false provenance, workspace=%s",
  async (hasWorkspace) => {
    const f = fixture(profiles[0]);
    const body = { fixture: true };
    const manifest = versionManifestSchema.parse({
      ...f.manifest,
      recordSnapshot: body,
    });
    const row = {
      ...f.canonical,
      body: JSON.stringify(body),
      legacy_present: 0,
      audited_baseline: 0,
    };
    const result = await f.read(
      f.database(hasWorkspace, row, {
        manifest,
        digest: await hashEnvelope("manifest", manifest),
      }).db,
      false,
    );
    expect(result.items?.[0]?.origin).toBe("generic_archive");
    expect(result.items?.[0]?.history).toBe("versioned");
  },
);
it("classification uses fixed indexed immutable keys and bounds the snapshot before JSON extraction", async () => {
  const f = fixture(profiles[0]);
  const port = f.database(true, {
    ...f.row,
    id: "ordinary_fixture",
    body: "{}",
    audited_baseline: 0,
  });
  await f.read(port.db, false);
  const sql = port.trace.find((value) => value.includes("SELECT r.id"));
  expect(sql).toContain(
    "b.owner=r.owner AND b.source_table='records' AND b.source_kind=r.kind AND b.source_id=r.id",
  );
  expect(sql).toContain(
    "CASE WHEN length(CAST(b.source_snapshot AS BLOB))>8388608 THEN 2 WHEN json_extract",
  );
  expect(sql).toContain("('audited-legacy-role-v1','audited-profile-role-v2')");
  expect(sql).toContain("0 AS legacy_present,0 AS audited_baseline");
});
