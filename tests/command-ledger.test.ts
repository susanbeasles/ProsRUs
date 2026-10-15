import { describe, expect, it } from "vitest";
import {
  createCommandLedger,
  type CommandAuditEvent,
} from "../src/storage/command-ledger";
import { sqliteD1 } from "./fixtures/sqlite-d1";

const digest = "a".repeat(64);
function audit(eventId: string): CommandAuditEvent {
  return {
    eventId,
    invocationId: "inv_1",
    operationId: "job-stack.claim.add.v1",
    requestKey: "key-1",
    inputDigest: digest,
    entrypoint: "owner",
    principalId: "client:client_fixture",
    grantId: "grant_fixture",
    grantRevision: 1,
    stage: "before-ack",
    decision: "allow",
    reason: "released",
    createdAt: 10,
  };
}
function ledger() {
  const sqlite = sqliteD1();
  return { sqlite, ledger: createCommandLedger(sqlite.db, "owner", "workspace") };
}
const begin = {
  requestKey: "key-1",
  operationId: "job-stack.claim.add.v1",
  inputDigest: digest,
  now: 5,
};

describe("D1 request ledger", () => {
  it("begins once per owner/workspace/key and keeps the first meaning", async () => {
    const { ledger: l, sqlite } = ledger();
    expect(await l.find("key-1")).toBeNull();
    expect(await l.begin(begin)).toMatchObject({
      state: "pending",
      inputDigest: digest,
      rootRevision: 0,
      result: null,
    });
    expect(
      await l.begin({ ...begin, inputDigest: "b".repeat(64), now: 6 }),
    ).toMatchObject({ inputDigest: digest });
    const other = createCommandLedger(sqlite.db, "owner", "other-workspace");
    expect(await other.find("key-1")).toBeNull();
    expect(sqlite.count("command_requests")).toBe(1);
  });

  it("compare-and-sets the retained root and rejects stale writers", async () => {
    const { ledger: l } = ledger();
    await l.begin(begin);
    expect(await l.loadRoot("key-1", digest)).toBeNull();
    const revision = await l.retainRoot({
      requestKey: "key-1",
      inputDigest: digest,
      expectedRevision: 0,
      root: { step: 1 },
      now: 6,
    });
    expect(revision).toBe(1);
    expect(await l.loadRoot("key-1", digest)).toEqual({
      root: { step: 1 },
      revision: 1,
    });
    await expect(
      l.retainRoot({
        requestKey: "key-1",
        inputDigest: digest,
        expectedRevision: 0,
        root: { step: "stale" },
        now: 7,
      }),
    ).rejects.toThrow("COMMAND_ROOT_CONFLICT");
    await expect(
      l.retainRoot({
        requestKey: "key-1",
        inputDigest: "b".repeat(64),
        expectedRevision: 1,
        root: {},
        now: 7,
      }),
    ).rejects.toThrow("COMMAND_ROOT_CONFLICT");
    await expect(
      l.retainRoot({
        requestKey: "key-1",
        inputDigest: digest,
        expectedRevision: 1,
        root: { big: "x".repeat(1_900_001) },
        now: 7,
      }),
    ).rejects.toThrow("COMMAND_ROOT_TOO_LARGE");
  });

  it("commits once with its allow audit, drops the root and never rewinds", async () => {
    const { ledger: l, sqlite } = ledger();
    await l.begin(begin);
    await l.retainRoot({
      requestKey: "key-1",
      inputDigest: digest,
      expectedRevision: 0,
      root: { step: 1 },
      now: 6,
    });
    await l.commit({
      requestKey: "key-1",
      inputDigest: digest,
      result: { ok: true },
      now: 8,
      audit: audit("event-1"),
    });
    expect(await l.find("key-1")).toMatchObject({
      state: "committed",
      result: { ok: true },
    });
    expect(await l.loadRoot("key-1", digest)).toBeNull();
    expect(sqlite.count("command_audit")).toBe(1);
    await expect(
      l.commit({
        requestKey: "key-1",
        inputDigest: digest,
        result: { ok: false },
        now: 9,
        audit: audit("event-2"),
      }),
    ).rejects.toThrow("COMMAND_LEDGER_CONFLICT");
    expect(sqlite.count("command_audit")).toBe(1);
    for (const sql of [
      "UPDATE command_requests SET state='pending',result=NULL",
      "UPDATE command_requests SET result='{}'",
      "DELETE FROM command_requests",
      "INSERT OR REPLACE INTO command_requests(owner,workspace_id,request_key,operation_id,input_digest,state,root,root_revision,result,created_at,updated_at) VALUES('owner','workspace','key-1','x','" +
        digest +
        "','pending',NULL,0,NULL,1,1)",
      "UPDATE command_audit SET reason='changed'",
      "DELETE FROM command_audit",
    ])
      expect(() => sqlite.raw.exec(sql), sql).toThrow(/COMMAND_/);
    expect(await l.find("key-1")).toMatchObject({ result: { ok: true } });
  });

  it("stores only bounded identifiers and fixed reason codes in the audit", async () => {
    const { ledger: l, sqlite } = ledger();
    await l.audit({ ...audit("event-1"), decision: "deny", reason: "operation-denied" });
    await expect(
      l.audit({ ...audit("event-2"), reason: "contains spaces and text" }),
    ).rejects.toThrow();
    await expect(
      l.audit({ ...audit("event-3"), decision: "maybe" as never }),
    ).rejects.toThrow();
    await expect(l.audit(audit("event-1"))).rejects.toThrow();
    expect(sqlite.count("command_audit")).toBe(1);
  });
});
