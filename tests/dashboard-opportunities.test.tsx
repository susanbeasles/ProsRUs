// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../dashboard/app/App";
import { ApiError, type DomainWriteOutput, type ReadClient, type WriteInput, type WriteOperation } from "../dashboard/lib/api";
import type { Services } from "../dashboard/lib/workspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SCOPES = [
  "job-stack.records.read",
  "job-stack.opportunity.transition",
  "job-stack.opportunity.assess",
  "job-stack.opportunity.capture",
  "job-stack.offer.record",
  "job-stack.packet.create",
  "job-stack.submission.record",
];
const session = () => ({
  expiresAtMs: Date.now() + 600_000,
  scopes: SCOPES,
  resources: [{ provider: "job-stack", kind: "workspace", id: "workspace_1", ownerId: "owner_1" }],
});
const save = { versionId: "v1", transactionId: "t1", digest: "c".repeat(64), statusUrl: "/versions/v1/protection", status: "saved_primary", protection: "protection_pending" } as const;
function opportunity(id: string, state: string, revision: string) {
  return {
    origin: "domain_record",
    history: "legacy_unversioned",
    kind: "opportunity",
    entityId: id,
    revision,
    updatedAt: 1000,
    body: { id, company: "Synthetic Co", role: "Staff Engineer " + id, state, terms: { employment: "full_time", baseUsd: null, hourlyUsd: null, remote: null, match401k: null, zeroPremium: null, affordableCare: null } },
    bodyStatus: "available",
    provenance: null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Server = { records: Map<string, ReturnType<typeof opportunity>>; reads: string[]; failRead?: (id: string) => unknown };
function readClient(server: Server) {
  return {
    async session() {
      server.reads.push("session");
      return session();
    },
    async detail(_kind: string, id: string) {
      server.reads.push("detail:" + id);
      const failure = server.failRead?.(id);
      if (failure) throw failure;
      return server.records.get(id) ?? null;
    },
    async page(kind: string) {
      server.reads.push("page:" + kind);
      return {
        items: [...server.records.values()].map((r) => ({ origin: r.origin, history: r.history, kind: r.kind, entityId: r.entityId, revision: r.revision, updatedAt: r.updatedAt })),
        nextCursor: null,
      };
    },
  };
}

const mounted: (() => void)[] = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});
async function mount(
  search: string,
  server: Server,
  write: (operation: WriteOperation, input: WriteInput) => Promise<DomainWriteOutput>,
  override: Record<string, unknown> = {},
) {
  window.history.replaceState(null, "", "/owner/job-stack" + search);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let n = 0;
  const services: Services = {
    readClient: () => ({ ...readClient(server), ...override }) as unknown as ReadClient,
    write: (_grant, operation, input) => write(operation, input),
    now: () => Date.now(),
    requestKey: () => "request-" + ++n,
  };
  await act(async () => root.render(<App services={services} />));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}
async function waitFor(check: () => boolean, timeout = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw Error("Timed out; screen: " + document.body.textContent?.slice(0, 600));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}
const settle = (ms = 20) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
const text = () => document.body.textContent ?? "";
function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(name));
  if (!found) throw Error("No button " + name + "; screen: " + text().slice(0, 400));
  return found;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
function control(label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const target = [...document.querySelectorAll("label")].find((l) => l.textContent?.trim().startsWith(label));
  const id = target?.getAttribute("for");
  const element = id ? document.getElementById(id) : null;
  if (!element) throw Error("No control labelled " + label);
  return element as HTMLInputElement;
}
async function type(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function submit() {
  const form = document.querySelector<HTMLFormElement>('[role="dialog"] form');
  if (!form) throw Error("No dialog form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
const badge = () => document.querySelector(".detail > .badge")?.textContent;

async function openTransition() {
  await waitFor(() => text().includes("Move to another state"));
  await click(button("Move to another state"));
  await waitFor(() => !!document.querySelector('[role="dialog"]'));
}

describe("opportunity detail writes", () => {
  it("offers only the transitions the domain allows from the current state", async () => {
    const server: Server = { records: new Map([["opp_1", opportunity("opp_1", "qualified", "3")]]), reads: [] };
    await mount("?grant=g&record=opp_1", server, async () => {
      throw Error("not called");
    });
    await openTransition();
    const options = [...(control("New state") as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(["packet_ready", "researching", "blocked", "declined"]);
    expect(document.activeElement).toBe(control("New state"));
    await act(async () => {
      document.querySelector('[role="dialog"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement?.textContent).toContain("Move to another state");
  });

  it("renders the transition optimistically and reconciles with the server revision", async () => {
    const server: Server = { records: new Map([["opp_1", opportunity("opp_1", "qualified", "3")]]), reads: [] };
    const gate = deferred<DomainWriteOutput>();
    const writes: [WriteOperation, WriteInput][] = [];
    await mount("?grant=g&record=opp_1", server, (operation, input) => {
      writes.push([operation, input]);
      return gate.promise;
    });
    await openTransition();
    await type(control("New state"), "packet_ready");
    await type(control("Evidence for this change"), "Packet prepared from confirmed claims");
    await submit();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await waitFor(() => badge() === "packet ready");
    expect(text()).toContain("Saving…");
    expect(writes).toEqual([
      [
        "job_stack_transition_opportunity",
        {
          workspaceId: "workspace_1",
          requestKey: "request-1",
          body: { id: "opp_1", revision: 3, state: "packet_ready", evidence: "Packet prepared from confirmed claims", confirmed: false },
        },
      ],
    ]);
    server.records.set("opp_1", opportunity("opp_1", "packet_ready", "4"));
    gate.resolve({ entityId: "opp_1", revision: "4", save });
    await waitFor(() => text().includes("Row revision: 4"));
    expect(badge()).toBe("packet ready");
    expect(text()).toContain("Saved: Move to packet ready");
  });

  it("rolls the optimistic transition back and explains the failure", async () => {
    const server: Server = { records: new Map([["opp_1", opportunity("opp_1", "qualified", "3")]]), reads: [] };
    const gate = deferred<DomainWriteOutput>();
    await mount("?grant=g&record=opp_1", server, () => gate.promise);
    await openTransition();
    await type(control("New state"), "blocked");
    await type(control("Evidence for this change"), "Waiting on a reference");
    await submit();
    await waitFor(() => badge() === "blocked");
    gate.reject(new ApiError("The record changed since it was loaded. Reload it and try again.", 409, null));
    await waitFor(() => badge() === "qualified");
    expect(text()).toContain("Move to blocked was not saved. The record changed since it was loaded.");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("refetches the record after a request-key conflict and shows the conflict", async () => {
    const server: Server = { records: new Map([["opp_1", opportunity("opp_1", "qualified", "3")]]), reads: [] };
    await mount("?grant=g&record=opp_1", server, async () => {
      throw new ApiError("This request key was already used for a different change. Start the action again.", 409, "request-key-conflict");
    });
    await openTransition();
    await type(control("New state"), "researching");
    await type(control("Evidence for this change"), "Recheck");
    server.records.set("opp_1", opportunity("opp_1", "blocked", "5"));
    const before = server.reads.filter((r) => r === "detail:opp_1").length;
    await submit();
    await waitFor(() => text().includes("already used for a different change"));
    await waitFor(() => server.reads.filter((r) => r === "detail:opp_1").length > before);
    await waitFor(() => badge() === "blocked");
    expect(text()).toContain("Row revision: 5");
    expect(document.querySelector(".pending-error")?.textContent).toContain("already used for a different change");
  });

  it("disables an action with an explanation after the server reports operation-unavailable", async () => {
    const server: Server = { records: new Map([["opp_1", opportunity("opp_1", "qualified", "3")]]), reads: [] };
    let writes = 0;
    await mount("?grant=g&record=opp_1", server, async () => {
      writes++;
      throw new ApiError("This action is not enabled on the server.", 501, "operation-unavailable");
    });
    await openTransition();
    await type(control("New state"), "researching");
    await type(control("Evidence for this change"), "Recheck");
    await submit();
    await waitFor(() => text().includes("Move to another state is not available"));
    expect(badge()).toBe("qualified");
    const move = [...document.querySelectorAll("button")].find((b) => b.textContent === "Move to another state");
    expect(move?.getAttribute("aria-disabled")).toBe("true");
    expect(text()).toContain("The server reported this action as not enabled (operation-unavailable).");
    expect(writes).toBe(1);
  });

  it("shows packet and submission actions as disabled with reasons", async () => {
    const server: Server = { records: new Map([["opp_1", opportunity("opp_1", "qualified", "3")]]), reads: [] };
    await mount("?grant=g&record=opp_1", server, async () => {
      throw Error("must not write");
    });
    await waitFor(() => text().includes("Create packet is not available"));
    expect(text()).toContain("Creating packets is not enabled on the server yet. Nothing is created or sent.");
    expect(text()).toContain("Recording submissions is not enabled on the server yet. Nothing is recorded.");
  });

  it("requires confirmation before withdrawing or declining", async () => {
    const server: Server = { records: new Map([["opp_1", opportunity("opp_1", "qualified", "3")]]), reads: [] };
    let called = false;
    await mount("?grant=g&record=opp_1", server, async () => {
      called = true;
      throw Error("x");
    });
    await openTransition();
    await type(control("New state"), "declined");
    await type(control("Evidence for this change"), "Not a fit");
    await submit();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(text()).toContain("Confirmation is required to withdraw or decline.");
    expect(called).toBe(false);
  });

  it("keeps reads and rolls back when a write needs hardware-key elevation; retry reuses the request key", async () => {
    const server: Server = { records: new Map([["opp_1", opportunity("opp_1", "qualified", "3")]]), reads: [] };
    const keys: string[] = [];
    let elevated = false;
    await mount("?grant=g&record=opp_1", server, async (_operation, input) => {
      keys.push(input.requestKey);
      if (!elevated) throw new ApiError("Confirm with your security key to enable changes.", 403, "write-elevation-required");
      server.records.set("opp_1", opportunity("opp_1", "researching", "4"));
      return { entityId: "opp_1", revision: "4", save };
    });
    await openTransition();
    await type(control("New state"), "researching");
    await type(control("Evidence for this change"), "More research");
    await submit();
    await waitFor(() => text().includes("Confirm with your security key to enable changes."));
    expect(badge()).toBe("qualified");
    expect(text()).not.toContain("Choose workspace grant Personal Control Workspace authority");
    expect(document.querySelector('a[href="/owner/apps/job-stack"]')).not.toBeNull();
    expect(document.querySelector('.pending-error a[href="/owner/apps/job-stack"]')).not.toBeNull();
    expect(text()).toContain("Staff Engineer opp_1");
    elevated = true;
    const retry = [...document.querySelectorAll(".toast button")].find((b) => b.textContent === "Retry") as HTMLButtonElement;
    await click(retry);
    await waitFor(() => text().includes("Row revision: 4"));
    expect(keys).toEqual(["request-1", "request-1"]);
  });

  it("clears everything and cancels pending writes when authority is lost", async () => {
    const server: Server = {
      records: new Map([
        ["opp_1", opportunity("opp_1", "qualified", "3")],
        ["opp_2", opportunity("opp_2", "submitted", "1")],
      ]),
      reads: [],
      failRead: (id) => (id === "opp_2" ? new ApiError("Workspace read denied or unavailable. Refresh your selection.", 403, "operation-denied") : null),
    };
    const gate = deferred<DomainWriteOutput>();
    await mount("?grant=g&record=opp_1", server, () => gate.promise);
    await openTransition();
    await type(control("New state"), "packet_ready");
    await type(control("Evidence for this change"), "Ready");
    await submit();
    await waitFor(() => badge() === "packet ready");
    await act(async () => {
      window.history.pushState(null, "", "/owner/job-stack?grant=g&record=opp_2");
      window.dispatchEvent(new Event("popstate"));
    });
    await waitFor(() => text().includes("Workspace read denied or unavailable. Refresh your selection."));
    expect(text()).toContain("1 pending change was cancelled when workspace authority ended");
    expect(text()).not.toContain("Staff Engineer");
    gate.resolve({ entityId: "opp_1", revision: "4", save });
    await settle();
    expect(text()).not.toContain("Staff Engineer");
    expect(text()).not.toContain("Saved:");
  });
});

describe("tracked opportunity list", () => {
  it("drops a late page from an earlier cursor after paging", async () => {
    const first = deferred<unknown>();
    const late = { items: [{ origin: "domain_record", history: "legacy_unversioned", kind: "opportunity", entityId: "late_row", revision: "1", updatedAt: 5 }], nextCursor: "c1" };
    await mount("?grant=g&view=tracked", { records: new Map(), reads: [] }, async () => {
      throw Error("x");
    }, {
      page: async (_kind: string, cursor: string | null) =>
        cursor === null
          ? first.promise
          : { items: [{ origin: "domain_record", history: "legacy_unversioned", kind: "opportunity", entityId: "page_two_row", revision: "1", updatedAt: 5 }], nextCursor: null },
    });
    await settle(50);
    await act(async () => {
      window.history.pushState(null, "", "/owner/job-stack?grant=g&view=tracked&cursor=c1");
      window.dispatchEvent(new Event("popstate"));
    });
    await waitFor(() => text().includes("page_two_row"));
    first.resolve(late);
    await settle();
    expect(text()).not.toContain("late_row");
  });

  it("inserts a captured opportunity optimistically and replaces it with the server identity", async () => {
    const server: Server = { records: new Map([["opp_1", opportunity("opp_1", "qualified", "3")]]), reads: [] };
    const gate = deferred<DomainWriteOutput>();
    await mount("?grant=g&view=tracked", server, () => gate.promise);
    await waitFor(() => text().includes("Staff Engineer opp_1") || text().includes("opp_1"));
    await click(button("Capture opportunity"));
    await type(control("Company"), "New Co");
    await type(control("Role"), "Principal Engineer");
    await type(control("Listing URL"), "https://example.invalid/jobs/9");
    await type(control("Listing description"), "Build things");
    await submit();
    await waitFor(() => text().includes("Principal Engineer"));
    expect(text()).toContain("Saving…");
    expect(text()).toContain("Not yet confirmed by the server");
    server.records.set("opp_new", { ...opportunity("opp_new", "discovered", "1"), body: { ...opportunity("opp_new", "discovered", "1").body, role: "Principal Engineer" } });
    gate.resolve({ entityId: "opp_new", revision: "1", save });
    await waitFor(() => !text().includes("Not yet confirmed by the server"));
    expect(document.querySelector('a.record-link[href*="record=opp_new"]')?.textContent).toBe("Principal Engineer");
    expect(document.querySelector('a.record-link[href*="pending-"]')).toBeNull();
  });
});
