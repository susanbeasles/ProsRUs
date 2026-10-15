function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error("Missing synthetic fixture value");
  return value;
}
import { expect, it } from "vitest";
import { opportunitySchema } from "../src/domain/model";
import { domainRecordSnapshotSchema } from "../src/domain/recovery-record";
import { planAuditedImport } from "../src/application/audited-legacy-import";
import {
  inputs,
  fixtureProfile,
  fixtureWorkspace,
} from "./fixtures/audited-inputs";
it("plans all synthetic role identities and exact pending originals without operational fields", () => {
  const raw = inputs();
  const plan = planAuditedImport(
    {
      sources: raw,
      workspace: fixtureWorkspace,
      seriesId: fixtureProfile.seriesId,
      observedAt: 100,
    },
    fixtureProfile,
  );
  expect(plan.records).toHaveLength(137);
  expect(plan.sources).toHaveLength(4);
  expect(required(plan.records[0]).body.raw.unknown).toEqual({ retain: true });
  expect(required(plan.records[0]).body).not.toHaveProperty("state");
  expect(required(plan.records[0]).body).not.toHaveProperty("terms");
  expect(
    opportunitySchema.safeParse(required(plan.records[0]).body).success,
  ).toBe(false);
  expect(
    domainRecordSnapshotSchema.safeParse({
      formatVersion: 1,
      type: "domain_record",
      recordKind: "opportunity",
      entityId: required(plan.records[0]).id,
      revision: 1,
      updatedAt: 100,
      body: required(plan.records[0]).body,
    }).success,
  ).toBe(false);
  for (let i = 0; i < 4; i++)
    expect(new TextEncoder().encode(required(plan.sources[i]).rawUtf8)).toEqual(
      required(raw[i]).bytes,
    );
  expect(plan.receipt.status).toBe("legacy_imported_archive_pending");
});
it("refuses changed bytes and malformed input before planning", () => {
  const raw = inputs();
  required(raw[0]).bytes[0] = 0;
  expect(() =>
    planAuditedImport(
      {
        sources: raw,
        workspace: fixtureWorkspace,
        seriesId: fixtureProfile.seriesId,
        observedAt: 100,
      },
      fixtureProfile,
    ),
  ).toThrow();
});
export { inputs };
import { supplementedInputs } from "./fixtures/audited-inputs";
it("retains optional separately pinned receipt and original role while deriving only an inert pending display", () => {
  const sources = supplementedInputs();
  const plan = planAuditedImport(
    {
      sources,
      workspace: fixtureWorkspace,
      seriesId: fixtureProfile.seriesId,
      observedAt: 100,
    },
    fixtureProfile,
  );
  const row = required(
    plan.records.find((r) => r.body.source.sourceId === "FXD003"),
  );
  expect(plan.receipt.rawSourceCount).toBe(5);
  expect(row.body.raw.after_cutoff_outreach).toEqual({
    thread_id: "fixture-original-thread",
    sent_message_id: "fixture-outbound",
  });
  expect(row.body.display.status).toBe("pending");
  expect(row.body.display.verifiedAt).toBe("2020-02-03T03:01:00.000Z");
  expect(required(row.body.relatedEvidence.at(-1)).raw).toHaveProperty(
    "retrieved_at",
    "2020-02-03T04:00:00Z",
  );
  expect(required(row.body.relatedEvidence.at(-1)).raw).toHaveProperty(
    "messages.1.thread_id",
    "fixture-invitation-thread",
  );
  expect(required(plan.sources[4]).rawUtf8).toContain("<img");
});
it("rejects unpinned and changed message/thread joins in the optional receipt", () => {
  const sources = supplementedInputs();
  const fifth = required(sources[4]);
  delete (fifth.receipt as Record<string, unknown>).supplementBinding;
  expect(() =>
    planAuditedImport(
      {
        sources,
        workspace: fixtureWorkspace,
        seriesId: fixtureProfile.seriesId,
        observedAt: 100,
      },
      fixtureProfile,
    ),
  ).toThrow();
});
