// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterContext } from "../dashboard/app/context";
import { createRouter } from "../dashboard/app/router";
import RecoveryStatusPanel, { presentRecovery, RecoveryStatusView } from "../dashboard/components/RecoveryStatus";
import { ApiError, readRecoveryStatus, request, type ReadClient } from "../dashboard/lib/api";
import { WorkspaceContext } from "../dashboard/lib/hooks";
import { keys } from "../dashboard/lib/queries";
import { humanDuration, parseRecoveryStatus, RECOVERY_STATUS_INVALID, type RecoveryStatus } from "../dashboard/lib/recoveryStatus";
import { Workspace } from "../dashboard/lib/workspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OBSERVED = Date.UTC(2026, 9, 15, 12, 0, 0);
function status(patch: Partial<RecoveryStatus> = {}): RecoveryStatus {
  return {
    format: "recovery-status-v1",
    workspaceId: "workspace_1",
    state: "protected",
    head: { sequence: "42", committedAt: OBSERVED - 60_000 },
    latestVerified: { sequence: "42", transactionDigest: "d".repeat(64), verifiedAt: OBSERVED - 30_000 },
    latestCheckpoint: { checkpointId: "cp_1", kind: "daily", position: { sequence: "40" }, verifiedAt: OBSERVED - 3_600_000 },
    lag: { pendingTransactions: 0, oldestPendingAt: null, seconds: 0 },
    deadLetters: 0,
    observedAt: OBSERVED,
    ...patch,
  };
}
const pending = status({
  state: "protection_pending",
  latestVerified: { sequence: "39", transactionDigest: "e".repeat(64), verifiedAt: OBSERVED - 900_000 },
  lag: { pendingTransactions: 3, oldestPendingAt: OBSERVED - 12 * 60_000, seconds: 720 },
});
const markup = (s: RecoveryStatus) => renderToStaticMarkup(<RecoveryStatusView status={s} />);

afterEach(() => vi.unstubAllGlobals());

describe("recovery status presentation", () => {
  it("labels each state, with Protected reserved for state protected", () => {
    const cases: [RecoveryStatus, string][] = [
      [status(), "Protected"],
      [pending, "Backup in progress"],
      [status({ state: "delayed", lag: { pendingTransactions: 9, oldestPendingAt: OBSERVED - 5_400_000, seconds: 5_400 } }), "Backup delayed"],
      [status({ state: "failed", deadLetters: 2, lag: { pendingTransactions: 2, oldestPendingAt: OBSERVED - 60_000, seconds: 60 } }), "Backup failed"],
      [status({ state: "degraded" }), "Backup degraded"],
      [status({ state: "unavailable", head: null, latestVerified: null, latestCheckpoint: null }), "Unavailable"],
    ];
    for (const [s, badge] of cases) {
      expect(presentRecovery(s).badge).toBe(badge);
      const html = markup(s);
      expect(html.includes("recovery-badge protected")).toBe(s.state === "protected");
      expect(/Protected/.test(html)).toBe(s.state === "protected");
    }
  });

  it("shows pending work as a backup in progress with lag, never as protected", () => {
    const html = markup(pending);
    expect(html).toContain("Backup in progress — 3 changes pending (oldest 12 min ago).");
    expect(html).toContain("Latest verified recoverable point: change #39, verified 2026-10-15 11:45 UTC");
    expect(html).toContain("Replication lag: 12 min (3 changes pending)");
    expect(html).toContain("Latest checkpoint: daily 2026-10-15 11:00 UTC");
    expect(html).not.toMatch(/protected/i);
    expect(html).toContain("D1 Time Travel is a separate platform layer and is never counted as independent backup.");
  });

  it("always shows the recoverable point and lag, and explains delay, failure and empty workspaces", () => {
    expect(markup(status())).toContain("Replication lag: none (no changes pending)");
    expect(markup(status({ state: "delayed", lag: { pendingTransactions: 9, oldestPendingAt: null, seconds: 5_400 } }))).toContain(
      "Replication is 1 h 30 min behind with 9 changes pending.",
    );
    expect(markup(status({ state: "failed", deadLetters: 1, lag: { pendingTransactions: 1, oldestPendingAt: null, seconds: null } }))).toContain(
      "1 change could not be replicated (dead-lettered)",
    );
    const empty = markup(status({ state: "unavailable", latestVerified: null, latestCheckpoint: null, head: null }));
    expect(empty).toContain("Latest verified recoverable point: none yet");
    expect(empty).toContain("No changes have been committed in this workspace yet");
    expect(humanDuration(42)).toBe("42 s");
    expect(humanDuration(3 * 86_400)).toBe("3 d");
  });
});

describe("recovery-status-v1 schema", () => {
  it("accepts the exact shape and rejects unknown fields, wrong encodings or another workspace", () => {
    expect(parseRecoveryStatus(status(), "workspace_1").state).toBe("protected");
    expect(() => parseRecoveryStatus({ ...status(), extra: 1 }, "workspace_1")).toThrow(RECOVERY_STATUS_INVALID);
    expect(() => parseRecoveryStatus({ ...status(), lag: { pendingTransactions: 0, oldestPendingAt: null } }, "workspace_1")).toThrow(RECOVERY_STATUS_INVALID);
    expect(() => parseRecoveryStatus({ ...status(), head: { sequence: 42, committedAt: 1 } }, "workspace_1")).toThrow(RECOVERY_STATUS_INVALID);
    expect(() => parseRecoveryStatus(status(), "workspace_2")).toThrow("different workspace");
  });

  it("never accepts protected without its defining evidence", () => {
    for (const patch of [
      { latestVerified: { sequence: "41", transactionDigest: "d".repeat(64), verifiedAt: OBSERVED } },
      { latestCheckpoint: null },
      { latestCheckpoint: { checkpointId: "cp", kind: "daily" as const, position: { sequence: "1" }, verifiedAt: OBSERVED - 27 * 3_600_000 } },
      { lag: { pendingTransactions: 1, oldestPendingAt: OBSERVED, seconds: 1 } },
      { head: null },
    ])
      expect(() => parseRecoveryStatus(status(patch), "workspace_1"), JSON.stringify(patch)).toThrow(RECOVERY_STATUS_INVALID);
  });
});

describe("recovery status transport", () => {
  it("uses the owner read flow with workspaceId while request() stays catalog-only", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ nonce: "n" })).mockResolvedValueOnce(Response.json(status()));
    vi.stubGlobal("fetch", fetcher);
    expect(await readRecoveryStatus("workspace_1", { grantId: "g" })).toEqual(status());
    const nonce = new URL(String(fetcher.mock.calls[0]?.[0]), "https://local.invalid");
    expect(nonce.searchParams.get("target")).toBe("/owner/job-stack/api/operations/job_stack_recovery_status?workspaceId=workspace_1");
    expect(String(fetcher.mock.calls[1]?.[0])).toBe("/owner/job-stack/api/operations/job_stack_recovery_status?workspaceId=workspace_1&grant=g");
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ headers: { "x-owner-nonce": "n" }, cache: "no-store" });
    await expect(request("/api/operations/job_stack_recovery_status", undefined, { grantId: "g" })).rejects.toThrow("Read-only");
  });

  it("bounds the recovery status response before parsing", async () => {
    const stream = new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(4096).fill(32)) }, { highWaterMark: 0 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ nonce: "n" })).mockResolvedValueOnce(new Response(stream)));
    await expect(readRecoveryStatus("workspace_1", { grantId: "g" })).rejects.toThrow("exceeds the read size limit");
  });
});

describe("recovery status panel", () => {
  const unmounts: (() => void)[] = [];
  afterEach(() => {
    for (const unmount of unmounts.splice(0)) unmount();
    vi.useRealTimers();
  });
  async function render(respond: () => unknown, scopes = ["job-stack.protection.read"], clock = { now: OBSERVED }) {
    const calls: string[] = [];
    const workspace = new Workspace("g", {
      readClient: () =>
        ({
          recoveryStatus: async (workspaceId: string) => {
            calls.push("recovery:" + workspaceId);
            return respond();
          },
        }) as unknown as ReadClient,
      write: async () => {
        throw Error("x");
      },
      now: () => clock.now,
      requestKey: () => "k",
    });
    workspace.cache.setData(keys.session(), () => ({
      expiresAtMs: OBSERVED + 1,
      scopes,
      resources: [{ provider: "job-stack", kind: "workspace", id: "workspace_1", ownerId: "o" }],
    }));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <RouterContext.Provider value={createRouter()}>
          <WorkspaceContext.Provider value={workspace}>
            <RecoveryStatusPanel />
          </WorkspaceContext.Provider>
        </RouterContext.Provider>,
      ),
    );
    await flush();
    unmounts.push(() => {
      act(() => root.unmount());
      host.remove();
    });
    return { host, calls };
  }
  const flush = async () => {
    for (let i = 0; i < 5; i++) await act(async () => Promise.resolve());
  };

  it("renders 501 operation-unavailable as 'Backup status unavailable', not as an error", async () => {
    const { host } = await render(() => {
      throw new ApiError("Workspace read denied or unavailable. Refresh your selection.", 501, "operation-unavailable");
    });
    expect(host.textContent).toContain("Backup status unavailable.");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector(".recovery-badge")).toBeNull();
  });

  it("renders a schema mismatch as an error state with retry, not a badge", async () => {
    const { host } = await render(() => ({ ...status(), state: "protected", latestCheckpoint: null }));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(RECOVERY_STATUS_INVALID);
    expect(host.querySelector(".recovery-badge")).toBeNull();
  });

  it("renders a valid pending status as a backup in progress for the session's workspace", async () => {
    const { host, calls } = await render(() => pending);
    expect(calls).toEqual(["recovery:workspace_1"]);
    expect(host.querySelector(".recovery-badge")?.textContent).toBe("Backup in progress");
  });

  it("does not read without the protection scope", async () => {
    const { host, calls } = await render(() => pending, ["job-stack.records.read"]);
    expect(calls).toEqual([]);
    expect(host.textContent).toContain("does not include job-stack.protection.read");
  });

  it("polls at most every 60 seconds while visible and pauses while hidden", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let visibility: DocumentVisibilityState = "visible";
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    try {
      const clock = { now: OBSERVED };
      const { calls } = await render(() => pending, ["job-stack.protection.read"], clock);
      expect(calls).toHaveLength(1);
      clock.now += 30_000;
      await act(async () => vi.advanceTimersByTime(30_000));
      await flush();
      expect(calls).toHaveLength(1);
      clock.now += 30_000;
      await act(async () => vi.advanceTimersByTime(30_000));
      await flush();
      expect(calls).toHaveLength(2);
      visibility = "hidden";
      clock.now += 180_000;
      await act(async () => vi.advanceTimersByTime(180_000));
      await flush();
      expect(calls).toHaveLength(2);
      visibility = "visible";
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await flush();
      expect(calls).toHaveLength(3);
    } finally {
      if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  });
});
