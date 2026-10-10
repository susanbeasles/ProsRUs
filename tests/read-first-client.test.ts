import { expect, it, vi, afterEach } from "vitest";
import { request } from "../dashboard/api";
afterEach(() => vi.unstubAllGlobals());
it("binds every owner data read to selected grant and a fresh one-use operation nonce", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ nonce: "synthetic_nonce" }))
    .mockResolvedValueOnce(Response.json({ items: [], nextCursor: null }));
  vi.stubGlobal("fetch", fetcher);
  await request(
    "/api/operations/job_stack_records?kind=opportunity",
    undefined,
    { grantId: "synthetic grant" },
  );
  expect(String(fetcher.mock.calls[0]?.[0])).toContain("/api/nonce?");
  expect(String(fetcher.mock.calls[0]?.[0])).toContain("grant=synthetic+grant");
  expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
    "x-owner-nonce": "synthetic_nonce",
  });
});
it("never fetches legacy mutation or data without a selected grant", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(request("/api/snapshot")).rejects.toThrow();
  await expect(
    request(
      "/api/operations/send_reply",
      { message: "inert" },
      { grantId: "synthetic" },
    ),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

import { validateCoreInput } from "../integration/shared-contract.mjs";
it("runtime rejects combined recognized selectors and content/upload variants", () => {
  expect(() =>
    validateCoreInput("job-stack.records.read.v1", {
      workspaceId: "workspace",
      kind: "opportunity",
      cursor: null,
      entityId: "record",
    }),
  ).toThrow("invalid-shared-value");
  expect(() =>
    validateCoreInput("job-stack.version.save.v1", {
      workspaceId: "workspace",
      requestKey: "request",
      lineageId: "lineage",
      entityId: "entity",
      kind: "profile",
      expectedParentIds: [],
      sourceVersionIds: [],
      branchRequested: false,
      content: { text: "synthetic" },
      uploadHandle: "upload",
    }),
  ).toThrow("invalid-shared-value");
});

import { createReadClient } from "../dashboard/api";
const pendingProtection = {
  versionId: "synthetic_version",
  documentApproval: "draft",
  primarySave: "journal_complete",
  replication: "protection_pending",
  integrity: "unchecked",
  retentionEvidence: [],
  lastCheckedAt: null,
  freshnessKnown: false,
};
it("reads exact selected protection with the same grant, nonce and abort signal", async () => {
  const signal = new AbortController().signal;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ nonce: "protection_nonce" }))
    .mockResolvedValueOnce(Response.json(pendingProtection));
  vi.stubGlobal("fetch", fetcher);
  expect(
    await createReadClient("selected_grant", signal).protection(
      "synthetic_version",
    ),
  ).toEqual(pendingProtection);
  const nonce = new URL(
    String(fetcher.mock.calls[0]?.[0]),
    "https://local.invalid",
  );
  expect(nonce.searchParams.get("target")).toBe(
    "/owner/job-stack/api/operations/job_stack_protection?versionId=synthetic_version",
  );
  expect(nonce.searchParams.get("grant")).toBe("selected_grant");
  expect(String(fetcher.mock.calls[1]?.[0])).toContain(
    "versionId=synthetic_version",
  );
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
    signal,
    cache: "no-store",
    headers: { "x-owner-nonce": "protection_nonce" },
  });
});
it("rejects a mismatched protection identity and denied protection", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ nonce: "nonce" }))
    .mockResolvedValueOnce(
      Response.json({ ...pendingProtection, versionId: "other_version" }),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    createReadClient("grant").protection("synthetic_version"),
  ).rejects.toThrow("Protection identity mismatch");
  fetcher
    .mockResolvedValueOnce(Response.json({ nonce: "next_nonce" }))
    .mockResolvedValueOnce(new Response("denied", { status: 403 }));
  await expect(
    createReadClient("grant").protection("synthetic_version"),
  ).rejects.toThrow("denied or unavailable");
});
it("does not refill protection after cancellation even if transport ignores abort", async () => {
  const controller = new AbortController();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ nonce: "nonce" }))
    .mockImplementationOnce(async () => {
      controller.abort();
      return Response.json(pendingProtection);
    });
  vi.stubGlobal("fetch", fetcher);
  await expect(
    createReadClient("grant", controller.signal).protection(
      "synthetic_version",
    ),
  ).rejects.toThrow();
});
it("does not send the protected data read after cancellation during nonce acquisition", async () => {
  const controller = new AbortController();
  const fetcher = vi.fn().mockImplementationOnce(async () => {
    controller.abort();
    return Response.json({ nonce: "nonce" });
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(
    createReadClient("grant", controller.signal).protection(
      "synthetic_version",
    ),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
