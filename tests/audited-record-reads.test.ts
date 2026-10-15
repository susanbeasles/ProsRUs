import { expect, it } from "vitest";
import { planAuditedImport } from "../src/application/audited-legacy-import";
import {
  parseAuditedSourceProfile,
  type CheckedAuditedSourceProfile,
} from "../src/application/audited-source-profile";
import { createRecordReads } from "../src/application/record-reads";
import {
  fixtureInputs,
  fixtureProfile,
  fixtureWorkspace,
} from "./fixtures/audited-profile-inputs";

const profile = parseAuditedSourceProfile(fixtureProfile);
const plan = planAuditedImport(
  {
    sources: fixtureInputs(),
    workspace: fixtureWorkspace,
    seriesId: fixtureProfile.seriesId,
    observedAt: 100,
  },
  profile,
);
const record = (() => {
  const first = plan.records[0];
  if (!first) throw Error("missing-fixture-record");
  return first;
})();
const sourceRows = plan.sources.map((source) => ({
  source_snapshot: JSON.stringify(source),
}));
const serializedBytes = sourceRows.reduce(
  (total, row) => total + new TextEncoder().encode(row.source_snapshot).length,
  0,
);
function database(
  metrics = { source_count: 4, serialized_bytes: serializedBytes },
  retained = sourceRows,
  overrides: {
    body?: string;
    receipt?: string;
    body_size?: number;
    body_format?: string;
    hasWorkspace?: boolean;
  } = {},
) {
  const trace: { method: string; sql: string }[] = [];
  const db = {
    prepare(sql: string) {
      const statement = {
        bind() {
          return statement;
        },
        async first() {
          trace.push({ method: "first", sql });
          if (sql.includes("SELECT workspace_id"))
            return overrides.hasWorkspace === false
              ? null
              : { workspace_id: fixtureWorkspace.workspaceId };
          if (sql.includes("source_count")) return metrics;
          if (sql.includes("source_kind='import_receipt'"))
            return {
              source_snapshot:
                overrides.receipt ?? JSON.stringify(plan.receipt),
            };
          throw Error("unexpected-fixture-first");
        },
        async all() {
          trace.push({ method: "all", sql });
          if (sql.includes("source_kind='raw_input'"))
            return { results: retained };
          if (sql.includes("SELECT r.id"))
            return {
              results: [
                {
                  id: record.id,
                  body: overrides.body ?? JSON.stringify(record.body),
                  revision: "1",
                  updated_at: 100,
                  lineage_id: null,
                  version_id: null,
                  legacy_present: 1,
                  audited_baseline: 1,
                  body_size: overrides.body_size,
                  body_format: overrides.body_format,
                },
              ],
            };
          throw Error("unexpected-fixture-all");
        },
      };
      return statement;
    },
  };
  // This stub implements only the D1 reads exercised by the real reader.
  return { db: db as unknown as D1Database, trace };
}
function readWith(
  db: D1Database,
  selectedProfile?: CheckedAuditedSourceProfile,
) {
  return createRecordReads(
    db,
    fixtureWorkspace.ownerId,
    fixtureWorkspace.workspaceId,
    selectedProfile,
  ).records({
    workspaceId: fixtureWorkspace.workspaceId,
    kind: "opportunity",
    entityId: record.id,
  });
}
const read = (db: D1Database) => readWith(db, profile);
it.each([
  { source_count: 6, serialized_bytes: serializedBytes },
  { source_count: 4, serialized_bytes: 8 * 1024 * 1024 + 1 },
])(
  "denies excessive retained intake before collection: %j",
  async (metrics) => {
    const { db, trace } = database(metrics);
    await expect(read(db)).rejects.toThrow("operation-denied");
    expect(
      trace.filter(
        (call) =>
          call.method === "all" && call.sql.includes("source_kind='raw_input'"),
      ),
    ).toHaveLength(0);
  },
);
it("bounds the retained query and preserves exact reconstruction in five statements with an existing workspace row", async () => {
  const { db, trace } = database();
  const result = await read(db);
  expect(
    result.record && "body" in result.record ? result.record.body : undefined,
  ).toEqual(record.body);
  const retained = trace.find(
    (call) =>
      call.method === "all" && call.sql.includes("source_kind='raw_input'"),
  );
  expect(retained?.sql).toMatch(/LIMIT 6/);
  expect(retained?.sql).toContain("serialized_bytes");
  expect(trace.find((call) => call.sql.includes("SELECT r.id"))?.sql).toContain(
    "CASE WHEN length(CAST(r.body AS BLOB))<=54000",
  );
  expect(trace).toHaveLength(5);
});
it("refuses absent/substituted profiles and oversized audited bodies", async () => {
  await expect(readWith(database().db)).rejects.toThrow("operation-denied");
  const substituted = parseAuditedSourceProfile({
    ...profile,
    recordIds: { ...profile.recordIds, recordPrefix: "other_fixture" },
  });
  await expect(readWith(database().db, substituted)).rejects.toThrow(
    "operation-denied",
  );
  await expect(
    read(
      database(undefined, undefined, {
        body: "",
        body_size: 54001,
        body_format: "audited-profile-role-v2",
      }).db,
    ),
  ).rejects.toThrow("operation-denied");
});
it("refuses reserialized body, source and receipt bytes", async () => {
  const cases = [
    database(undefined, undefined, { body: " " + JSON.stringify(record.body) }),
    database(
      undefined,
      sourceRows.map((row, index) =>
        index ? row : { source_snapshot: " " + row.source_snapshot },
      ),
    ),
    database(undefined, undefined, {
      receipt: " " + JSON.stringify(plan.receipt),
    }),
  ];
  for (const { db } of cases)
    await expect(read(db)).rejects.toThrow("operation-denied");
});
it("reconstructs retained sources in declared original order", async () => {
  const result = await read(database(undefined, [...sourceRows].reverse()).db);
  expect(
    result.record && "body" in result.record ? result.record.body : undefined,
  ).toEqual(record.body);
});
it("denies raced count and oversized serialized readback before reconstruction", async () => {
  const duplicate = sourceRows[0];
  if (!duplicate) throw Error("missing-source-fixture");
  const excessive = [duplicate, duplicate, ...sourceRows];
  await expect(read(database(undefined, excessive).db)).rejects.toThrow(
    "operation-denied",
  );
  const oversized = sourceRows.map((row, index) =>
    index
      ? row
      : { source_snapshot: row.source_snapshot + " ".repeat(8 * 1024 * 1024) },
  );
  const { db, trace } = database(undefined, oversized);
  await expect(read(db)).rejects.toThrow("operation-denied");
  expect(
    trace.some((call) => call.sql.includes("source_kind='import_receipt'")),
  ).toBe(false);
});

it("profile-v2 list rows also use one bounded exact reconstruction", async () => {
  const { db, trace } = database();
  const result = await createRecordReads(
    db,
    fixtureWorkspace.ownerId,
    fixtureWorkspace.workspaceId,
    profile,
  ).records({
    workspaceId: fixtureWorkspace.workspaceId,
    kind: "opportunity",
    cursor: null,
  });
  expect("items" in result && result.items?.[0]?.entityId).toBe(record.id);
  expect(trace).toHaveLength(5);
  for (const body of [
    JSON.stringify({ fixture: true }),
    "{invalid-fixture-json",
  ]) {
    await expect(
      createRecordReads(
        database(undefined, undefined, { body }).db,
        fixtureWorkspace.ownerId,
        fixtureWorkspace.workspaceId,
        profile,
      ).records({
        workspaceId: fixtureWorkspace.workspaceId,
        kind: "opportunity",
        cursor: null,
      }),
    ).rejects.toThrow("operation-denied");
  }
  for (const selected of [
    undefined,
    parseAuditedSourceProfile({
      ...profile,
      recordIds: { ...profile.recordIds, recordPrefix: "other_fixture" },
    }),
  ]) {
    await expect(
      createRecordReads(
        database().db,
        fixtureWorkspace.ownerId,
        fixtureWorkspace.workspaceId,
        selected,
      ).records({
        workspaceId: fixtureWorkspace.workspaceId,
        kind: "opportunity",
        cursor: null,
      }),
    ).rejects.toThrow("operation-denied");
  }
});

it.each([true, false])(
  "retained receipt is byte-bounded before parsing, workspace row=%s",
  async (hasWorkspace) => {
    const { db, trace } = database(undefined, undefined, {
      hasWorkspace,
      receipt: JSON.stringify(plan.receipt) + " ".repeat(8 * 1024 * 1024),
    });
    await expect(read(db)).rejects.toThrow("operation-denied");
    expect(trace).toHaveLength(hasWorkspace ? 5 : 2);
    expect(
      trace.find((call) => call.sql.includes("source_kind='import_receipt'"))
        ?.sql,
    ).toContain("CASE WHEN length(CAST(source_snapshot AS BLOB))<=8388608");
  },
);
