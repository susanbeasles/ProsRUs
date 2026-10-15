import { it, expect } from "vitest";
import { effectDigestInput } from "../src/domain/effects";
import { extractProfileFacts, profileConflicts } from "../src/domain/profile";
it("same outgoing message survives editor revision changes", () => {
  expect(
    effectDigestInput("send", { threadId: "t", body: "hello", revision: 1 }),
  ).toEqual(
    effectDigestInput("send", { threadId: "t", body: "hello", revision: 2 }),
  );
});
it("finds inconsistent phone, configured employment dates, and education across evidence", () => {
  const a = extractProfileFacts(
    "Phone: 812-555-0100\nFixture Employer 2018-2020\nEducation: BS Computer Science",
    "a",
    [{ employerLabel: "Fixture Employer", category: "fixture_employer_dates" }],
  );
  const b = extractProfileFacts(
    "Phone: 812-555-0101\nFixture Employer 2019-2021\nEducation: Computer Science coursework",
    "b",
    [{ employerLabel: "Fixture Employer", category: "fixture_employer_dates" }],
  );
  expect(
    profileConflicts([...a, ...b])
      .map((x) => x.field)
      .sort(),
  ).toEqual(["education", "fixture_employer_dates", "phone"]);
});

import { domainRecordSnapshotSchema } from "../src/domain/recovery-record";
import { canonicalizeEnvelope } from "../src/domain/recovery-canonical";
const fixtureConflict = {
  formatVersion: 1,
  type: "domain_record",
  recordKind: "question",
  entityId: "fixture-question",
  revision: 1,
  updatedAt: 100,
  body: {
    type: "profile_conflict",
    field: "fixture_employer_dates",
    values: [
      {
        field: "fixture_employer_dates",
        value: "  Exact fixture dates  ",
        sourceId: "fixture-source",
      },
    ],
    status: "unresolved",
    nextAction: "Review authoritative value",
  },
};
it("accepts exact strict v1 generic date category bytes without changing the body", () => {
  const result = domainRecordSnapshotSchema.parse(fixtureConflict);
  expect(result).toEqual(fixtureConflict);
  expect(canonicalizeEnvelope(result)).toEqual(
    canonicalizeEnvelope(fixtureConflict),
  );
});
it("rejects malformed date categories and unknown v1 fields", () => {
  for (const field of [
    "_dates",
    "Fixture_dates",
    "fixture__dates",
    "fixture/dates",
    "fixture_dates\n",
    "fixture_",
    "x".repeat(60) + "_dates",
  ]) {
    expect(() =>
      domainRecordSnapshotSchema.parse({
        ...fixtureConflict,
        body: { ...fixtureConflict.body, field },
      }),
    ).toThrow();
  }
  expect(() =>
    domainRecordSnapshotSchema.parse({
      ...fixtureConflict,
      body: { ...fixtureConflict.body, extra: true },
    }),
  ).toThrow();
});
it("does not infer an employment date without finite extraction configuration", () => {
  expect(
    extractProfileFacts("Fixture Employer 2010-2012", "fixture-source"),
  ).toEqual([]);
});
