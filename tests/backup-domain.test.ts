import { describe, expect, it } from "vitest";
import {
  backupKeys,
  checkpointId,
  checkpointPeriod,
  deriveRecoveryStatus,
  paddedSequence,
  parseChangeKey,
  planObjectRetention,
  PROTECTION_THRESHOLDS,
  RETENTION,
  type RecoveryFacts,
} from "../src/domain/backup";

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const digest = "a".repeat(64);
function facts(overrides: Partial<RecoveryFacts> = {}): RecoveryFacts {
  return {
    workspaceId: "workspace_fixture",
    head: { sequence: "7", committedAt: NOW - 60_000 },
    latestVerified: { sequence: "7", transactionDigest: digest, verifiedAt: NOW - 30_000 },
    latestCheckpoint: { checkpointId: "daily-2026-10-15", kind: "daily", position: { sequence: "7" }, verifiedAt: NOW - 3_600_000 },
    oldestPendingAt: null,
    deadLetters: 0,
    ...overrides,
  };
}

describe("recovery status rule", () => {
  it("is protected only with every commit verified and a fresh verified checkpoint", () => {
    expect(deriveRecoveryStatus(facts(), NOW).state).toBe("protected");
  });
  it("never labels pending work protected, however fresh the checkpoint", () => {
    const pending = deriveRecoveryStatus(
      facts({ latestVerified: { sequence: "6", transactionDigest: digest, verifiedAt: NOW }, oldestPendingAt: NOW - 120_000 }),
      NOW,
    );
    expect(pending).toMatchObject({ state: "protection_pending", lag: { pendingTransactions: 1, seconds: 120 } });
    const delayed = deriveRecoveryStatus(
      facts({ latestVerified: null, oldestPendingAt: NOW - (PROTECTION_THRESHOLDS.pendingGraceSeconds + 1) * 1000 }),
      NOW,
    );
    expect(delayed).toMatchObject({ state: "delayed", lag: { pendingTransactions: 7 } });
    expect(deriveRecoveryStatus(facts({ latestVerified: null, oldestPendingAt: null }), NOW).state).toBe("delayed");
  });
  it("is degraded without a verified checkpoint inside 26 hours, and failed with any dead letter", () => {
    expect(deriveRecoveryStatus(facts({ latestCheckpoint: null }), NOW).state).toBe("degraded");
    const stale = facts().latestCheckpoint;
    expect(stale).not.toBeNull();
    if (stale === null) return;
    expect(
      deriveRecoveryStatus(facts({ latestCheckpoint: { ...stale, verifiedAt: NOW - PROTECTION_THRESHOLDS.checkpointFreshMs - 1 } }), NOW).state,
    ).toBe("degraded");
    expect(deriveRecoveryStatus(facts({ latestCheckpoint: { ...stale, verifiedAt: NOW + 1 } }), NOW).state).toBe("degraded");
    expect(deriveRecoveryStatus(facts({ deadLetters: 1 }), NOW).state).toBe("failed");
  });
  it("treats an empty workspace as sequence zero and rejects verified-ahead-of-head evidence", () => {
    expect(deriveRecoveryStatus(facts({ head: null, latestVerified: null }), NOW).state).toBe("protected");
    expect(() =>
      deriveRecoveryStatus(facts({ head: { sequence: "3", committedAt: null } }), NOW),
    ).toThrow("RECOVERY_VERIFIED_AHEAD_OF_HEAD");
  });
});

describe("backup key layout", () => {
  it("orders sequences lexically and round-trips change keys", () => {
    expect(paddedSequence("42")).toBe("00000000000000000042");
    const key = backupKeys.change("workspace_fixture", "42", digest);
    expect(key).toBe(`changes/workspace_fixture/00000000000000000042-${digest}.json`);
    expect(parseChangeKey(key)).toEqual({ workspaceId: "workspace_fixture", sequence: "42", transactionDigest: digest });
    expect(parseChangeKey("changes/workspace_fixture/42.json")).toBeNull();
    expect(backupKeys.object(digest)).toBe(`objects/sha256/aa/${digest}`);
    expect(() => paddedSequence("1".repeat(21))).toThrow();
    expect(() => backupKeys.receipt("../escape", "1")).toThrow();
  });
  it("derives UTC periods and stable checkpoint ids", () => {
    expect(checkpointPeriod("daily", NOW)).toBe("2026-10-15");
    expect(checkpointPeriod("monthly", NOW)).toBe("2026-10");
    expect(checkpointId("monthly", "2026-10")).toBe("monthly-2026-10");
    expect(() => checkpointId("daily", "2026-10")).toThrow();
  });
});

describe("object retention planner", () => {
  const key = (sha: string) => backupKeys.object(sha);
  const old = NOW - RETENTION.objectLockMs - 2 * 86_400_000;
  it("deletes only unreferenced objects past their lock and keeps malformed keys", () => {
    const referenced = "b".repeat(64);
    const orphan = "c".repeat(64);
    const young = "d".repeat(64);
    const plan = planObjectRetention({
      objects: [
        { key: key(referenced), sha256: referenced, uploadedAt: old },
        { key: key(orphan), sha256: orphan, uploadedAt: old },
        { key: key(young), sha256: young, uploadedAt: NOW - 86_400_000 },
        { key: "objects/sha256/zz/not-a-digest", sha256: "not-a-digest", uploadedAt: old },
      ],
      referenced: new Set([referenced]),
      now: NOW,
    });
    expect(plan).toEqual({ delete: [key(orphan)], keptReferenced: 2, keptLocked: 1 });
  });
});
