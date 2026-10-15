// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../dashboard/app/App";
import { ApiError, type DomainWriteOutput, type ReadClient, type WriteInput, type WriteOperation } from "../dashboard/lib/api";
import type { Services } from "../dashboard/lib/workspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ALL_SCOPES = [
  "job-stack.records.read",
  "job-stack.profile.read",
  "job-stack.claim.add",
  "job-stack.claim.review",
  "job-stack.conversation.capture",
  "job-stack.conversation.associate",
  "job-stack.conversation.draft.save",
  "job-stack.interview.prepare",
  "job-stack.packet.create",
  "job-stack.submission.record",
  "job-stack.settings.update",
  "job-stack.request.read",
];
type Fake = {
  scopes?: string[];
  pages?: Record<string, unknown[]>;
  records?: Record<string, unknown>;
  failPage?: (kind: string) => boolean;
  holdPages?: Promise<void>;
};
function row(kind: string, entityId: string, body: Record<string, unknown>, revision = "2") {
  return { origin: "domain_record", history: "legacy_unversioned", kind, entityId, revision, updatedAt: 1000, body, bodyStatus: "available", provenance: null };
}
const summary = (r: ReturnType<typeof row>) => ({ origin: r.origin, history: r.history, kind: r.kind, entityId: r.entityId, revision: r.revision, updatedAt: r.updatedAt });

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});
async function mount(search: string, fake: Fake = {}, write?: (operation: WriteOperation, input: WriteInput) => Promise<DomainWriteOutput>) {
  window.history.replaceState(null, "", "/owner/job-stack" + search);
  const reads: string[] = [];
  const client = {
    session: async () => ({
      expiresAtMs: Date.now() + 600_000,
      scopes: fake.scopes ?? ALL_SCOPES,
      resources: [{ provider: "job-stack", kind: "workspace", id: "workspace_1", ownerId: "o" }],
    }),
    page: async (kind: string) => {
      reads.push("page:" + kind);
      await fake.holdPages;
      if (fake.failPage?.(kind)) throw Error("Workspace read denied or unavailable. Refresh your selection.");
      return { items: fake.pages?.[kind] ?? [], nextCursor: null };
    },
    profile: async () => ({ items: [], nextCursor: null }),
    pipelinePage: async (view: string) => ({
      format: "pipeline-page-v1",
      status: "available",
      workspaceId: "workspace_1",
      view,
      datasetId: "a".repeat(64),
      importObservedAt: 1,
      totalObservations: 0,
      historicalRelationships: 0,
      range: { start: 0, end: 0 },
      items: [],
      nextCursor: null,
    }),
    detail: async (kind: string, id: string) => {
      reads.push("detail:" + kind + ":" + id);
      return fake.records?.[kind + ":" + id] ?? null;
    },
    requestResult: async () => ({ result: null }),
    recoveryStatus: async () => {
      throw new ApiError("Workspace read denied or unavailable. Refresh your selection.", 501, "operation-unavailable");
    },
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const services: Services = {
    readClient: () => client as unknown as ReadClient,
    write: (_grant, operation, input) => (write ? write(operation, input) : Promise.reject(Error("unexpected write"))),
    now: () => Date.now(),
    requestKey: () => "11111111-2222-3333-4444-555555555555",
  };
  await act(async () => root.render(<App services={services} />));
  unmounts.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, reads };
}
async function waitFor(check: () => boolean, timeout = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw Error("Timed out; screen: " + document.body.textContent?.slice(0, 700));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}
const text = () => document.body.textContent ?? "";
const notEnabled = (title: string) => document.querySelector(`[role="note"][aria-label="${title} (not enabled)"]`);

describe("feature pages", () => {
  it("overview shows first-page counts, recent records and an explicit backup-status state", async () => {
    const opp = row("opportunity", "opp_1", { role: "Engineer", company: "Co" });
    await mount("?grant=g&page=overview", { pages: { opportunity: [summary(opp)] }, scopes: [...ALL_SCOPES, "job-stack.protection.read"] });
    await waitFor(() => text().includes("Recently updated records") && text().includes("opp_1"));
    expect(text()).toContain("Opportunity records");
    await waitFor(() => text().includes("Backup status unavailable."));
    expect(document.querySelector(".recovery-badge")).toBeNull();
    expect(text()).not.toContain("Protected");
  });

  it("shows a skeleton while loading, then the empty state", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    await mount("?grant=g&page=packets", { holdPages: hold });
    await waitFor(() => text().includes("Loading packets…"));
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    release();
    await waitFor(() => text().includes("No packets yet"));
  });

  it("shows an error state with a retry that reloads the list", async () => {
    let fail = true;
    await mount("?grant=g&page=interviews", { failPage: () => fail });
    await waitFor(() => !!document.querySelector('[role="alert"]'));
    expect(text()).toContain("Workspace read denied or unavailable");
    fail = false;
    const retry = [...document.querySelectorAll('[role="alert"] button')].find((b) => b.textContent === "Try again") as HTMLButtonElement;
    await act(async () => retry.click());
    await waitFor(() => text().includes("No interviews recorded"));
  });

  it("conversations explain that sending is not enabled instead of offering a send button", async () => {
    const thread = row("thread", "thread_1", { subject: "Hello", recipient: "r@example.org", draft: "Draft text" });
    await mount("?grant=g&page=conversations&record=thread_1", { records: { "thread:thread_1": thread } });
    await waitFor(() => text().includes("Hello"));
    expect(notEnabled("Sending replies")).not.toBeNull();
    expect(text()).toContain("The shared catalog has no send operation");
    expect([...document.querySelectorAll("button")].some((b) => /send/i.test(b.textContent ?? ""))).toBe(false);
    expect(text()).toContain("Save draft reply");
  });

  it("interviews explain that scheduling is not enabled", async () => {
    await mount("?grant=g&page=interviews");
    await waitFor(() => !!notEnabled("Scheduling, rescheduling and cancelling interviews"));
    expect([...document.querySelectorAll("button")].some((b) => /schedule/i.test(b.textContent ?? ""))).toBe(false);
  });

  it("profile, activity and history state what is not enabled", async () => {
    await mount("?grant=g&page=profile");
    await waitFor(() => !!notEnabled("Profile export"));
    for (const unmount of unmounts.splice(0)) unmount();
    await mount("?grant=g&page=activity");
    await waitFor(() => !!notEnabled("Workspace audit trail"));
    expect(text()).toContain("No changes yet");
    for (const unmount of unmounts.splice(0)) unmount();
    await mount("?grant=g&page=history&view=claim");
    await waitFor(() => text().includes("No claim records"));
    await waitFor(() => text().includes("does not include job-stack.protection.read"));
  });

  it("explains a missing grant scope instead of rendering a failing button", async () => {
    await mount("?grant=g&page=profile", { scopes: ["job-stack.records.read"] });
    await waitFor(() => text().includes("Add claim is not available"));
    expect(text()).toContain("This grant does not include job-stack.claim.add.");
    expect([...document.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Add claim"))).toBe(false);
  });

  it("marks owner-only actions", async () => {
    const claim = row("claim", "claim_1", { field: "Achievement", text: "Shipped", status: "unverified", permitted: false, sourceIds: [] });
    await mount("?grant=g&page=profile&record=claim_1", { records: { "claim:claim_1": claim } });
    await waitFor(() => text().includes("Review claim"));
    const review = [...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Review claim"));
    expect(review?.querySelector(".badge.owner")?.textContent).toBe("Owner only");
  });

  it("saves settings revision-aware with only declared fields", async () => {
    const writes: WriteInput[] = [];
    const settings = row("settings", "settings_1", { discoveryEnabled: true, targetingProfile: { private: true }, approvedRecipients: [], boards: [], interviewWindows: [], sender: null, notificationEmail: null, calendarId: null }, "5");
    await mount(
      "?grant=g&page=settings",
      { pages: { settings: [summary(settings)] }, records: { "settings:settings_1": settings } },
      async (_operation, input) => {
        writes.push(input);
        return { entityId: "settings_1", revision: "6", save: { versionId: "v", transactionId: "t", digest: "f".repeat(64), statusUrl: "/versions/v/protection", status: "saved_primary", protection: "protection_pending" } };
      },
    );
    await waitFor(() => text().includes("Save settings"));
    const form = document.querySelector<HTMLFormElement>("form.schema-form");
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => writes.length === 1);
    const body = writes[0]?.body as Record<string, unknown>;
    expect(body.revision).toBe(5);
    expect(body.discoveryEnabled).toBe(true);
    expect(body).not.toHaveProperty("targetingProfile");
    expect(Object.keys(body).sort()).toEqual(
      ["approvedRecipients", "boards", "calendarId", "correspondenceEnabled", "discoveryEnabled", "integrationVerified", "interviewWindows", "notificationEmail", "profileResolved", "remindersEnabled", "revision", "sender", "sendingEnabled"].sort(),
    );
  });

  it("moves focus to the new page heading after navigation and announces it", async () => {
    await mount("?grant=g&page=overview");
    await waitFor(() => text().includes("Your recruiting workspace"));
    const link = [...document.querySelectorAll("nav a")].find((a) => a.textContent === "Packets") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/owner/job-stack?grant=g&page=packets");
    await act(async () => link.click());
    await waitFor(() => document.activeElement?.tagName === "H1");
    expect(document.activeElement?.textContent).toBe("Packets");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(document.querySelector('[aria-live="polite"].visually-hidden')?.textContent).toBe("Packets");
  });
});
