// Rewritten deliberately for the routed dashboard. The previous version executed callbacks parsed
// out of the 382-line dashboard/main.tsx App; that component is now split into app/router.ts
// (semantic route equality), app/navigation.ts (navigation -> cache generation) and lib/workspace.ts
// (per-grant cache and mutations). The same invariants are asserted against those real modules:
// equal navigation keeps in-flight reads, distinct navigation aborts them and drops late responses,
// a grant change discards the workspace, and refresh always clears and advances.
import { expect, it } from "vitest";
import { bindNavigation } from "../dashboard/app/navigation";
import { createRouter, type RouterWindow } from "../dashboard/app/router";
import { keys } from "../dashboard/lib/queries";
import { WorkspaceStore, type Services } from "../dashboard/lib/workspace";

const services: Services = {
  readClient: () => {
    throw Error("no reads in this test");
  },
  write: async () => {
    throw Error("no writes in this test");
  },
  now: () => 1000,
  requestKey: () => "synthetic-key",
};

function fixture(query: string) {
  const listeners = new Set<() => void>();
  let pushes = 0;
  const win = {
    location: { search: "?" + query, pathname: "/owner/job-stack" },
    history: {
      state: null as unknown,
      pushState(state: unknown, _unused: string, url: string) {
        pushes++;
        win.history.state = state;
        win.location.search = url.slice(url.indexOf("?"));
      },
      replaceState() {},
    },
    addEventListener: (_type: "popstate", listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: "popstate", listener: () => void) => listeners.delete(listener),
  };
  const router = createRouter(win as unknown as RouterWindow);
  router.start();
  const store = new WorkspaceStore(services);
  bindNavigation(router, store);
  const workspace = store.forGrant(router.route().grant);
  const detail = { entityId: "record" },
    protection = { versionId: "past" };
  workspace.cache.setData(keys.record("opportunity", "record"), () => detail);
  workspace.cache.setData(keys.protection("past"), () => protection);
  let signal: AbortSignal | undefined;
  let release: (value: unknown) => void = () => {};
  const inFlight = workspace.cache.fetch({
    key: keys.version("past", "lineage", "record"),
    fetch: (s) => {
      signal = s;
      return new Promise((resolve) => (release = resolve));
    },
  });
  const generation = workspace.cache.generation;
  return {
    router,
    store,
    workspace,
    win,
    signal: () => signal,
    pushes: () => pushes,
    late: async () => {
      release({ versionId: "past" });
      return inFlight;
    },
    unchanged: () =>
      workspace.cache.peek(keys.record("opportunity", "record")) === detail &&
      workspace.cache.peek(keys.protection("past")) === protection &&
      workspace.cache.generation === generation,
    pop(search: string) {
      win.location.search = search;
      for (const listener of listeners) listener();
    },
  };
}

const current = "grant=grant&record=record",
  history = current + "&history=1",
  past = history + "&version=past";
for (const [name, query, action] of [
  ["selected history version", past, (f: ReturnType<typeof fixture>) => f.router.navigate((r) => ({ ...r, versionId: "past" }))],
  ["current record", current, (f: ReturnType<typeof fixture>) => f.router.navigate((r) => ({ ...r, record: "record", history: false, versionId: null }))],
  ["current history target", history, (f: ReturnType<typeof fixture>) => f.router.navigate((r) => ({ ...r, record: "record", history: true, versionId: null }))],
  ["current history version list", history, (f: ReturnType<typeof fixture>) => f.router.navigate((r) => ({ ...r, versionId: null }))],
] as const)
  it(`repeating the ${name} preserves current data and its in-flight controller`, () => {
    const f = fixture(query);
    expect(action(f)).toBe(false);
    expect(f.signal()?.aborted).toBe(false);
    expect(f.unchanged()).toBe(true);
    expect(f.pushes()).toBe(0);
  });

it("equal semantic pop navigation preserves data despite URL order/irrelevant fields", () => {
  const f = fixture(past);
  f.pop("?version=past&history=1&record=record&grant=grant&ignored=1");
  expect(f.signal()?.aborted).toBe(false);
  expect(f.unchanged()).toBe(true);
});

for (const [label, target] of [
  ['selectVersion("other")', { versionId: "other" }],
  ['select("other_record")', { record: "other_record", history: false, versionId: null }],
] as const)
  it(`distinct navigation cancels and changes actual loader dependencies: ${label}`, async () => {
    const f = fixture(past);
    const before = f.workspace.cache.generation;
    expect(f.router.navigate((r) => ({ ...r, ...target }))).toBe(true);
    expect(f.signal()?.aborted).toBe(true);
    expect(f.workspace.cache.generation).toBe(before + 1);
    expect(await f.late()).toBeUndefined();
    expect(f.workspace.cache.peek(keys.version("past", "lineage", "record"))).toBeUndefined();
    expect(f.pushes()).toBe(1);
  });

it("a distinct grant pop cancels old detail and changes actual loader dependencies", async () => {
  const f = fixture(past);
  f.pop("?grant=other&record=record&history=1&version=past");
  expect(f.signal()?.aborted).toBe(true);
  expect(f.workspace.cache.peek(keys.record("opportunity", "record"))).toBeUndefined();
  expect(f.workspace.cache.peek(keys.protection("past"))).toBeUndefined();
  const next = f.store.forGrant("other");
  expect(next).not.toBe(f.workspace);
  expect(next.cache.keys()).toEqual([]);
  expect(await f.late()).toBeUndefined();
  expect(f.pushes()).toBe(0);
});

it("explicit refresh clears and always advances a real loader dependency", async () => {
  const f = fixture(past);
  const before = f.workspace.cache.generation;
  f.workspace.refresh();
  expect(f.signal()?.aborted).toBe(true);
  expect(f.workspace.cache.peek(keys.record("opportunity", "record"))).toBeUndefined();
  expect(f.workspace.cache.peek(keys.protection("past"))).toBeUndefined();
  expect(f.workspace.cache.generation).toBeGreaterThan(before);
  expect(await f.late()).toBeUndefined();
});

it("a repeated new target stays idempotent before another render or effect", () => {
  const f = fixture(past);
  expect(f.router.navigate((r) => ({ ...r, versionId: "other" }))).toBe(true);
  const generation = f.workspace.cache.generation;
  expect(f.router.navigate((r) => ({ ...r, versionId: "other" }))).toBe(false);
  expect(f.pushes()).toBe(1);
  expect(f.workspace.cache.generation).toBe(generation);
  expect(f.router.route().versionId).toBe("other");
});
