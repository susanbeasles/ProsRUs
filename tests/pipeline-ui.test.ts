// @vitest-environment happy-dom
// Rewritten deliberately: these cases previously ran dashboard/main.tsx's App through a VM harness
// with fake hooks (source-level evidence only). The App is now routed and data-cached, so the same
// cases render the real React tree in happy-dom with a synthetic read client injected at the
// services boundary. Request budgets, stale-response dropping and expiry clearing are unchanged.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../dashboard/app/App";
import { createReadClient, type ReadClient } from "../dashboard/lib/api";
import type { Services } from "../dashboard/lib/workspace";
import { PipelineList, type PipelineListProps } from "../dashboard/features/opportunities/PipelineList";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projection = {
  kind: "opportunity",
  entityId: "synthetic_record",
  revision: "1",
  updatedAt: 100,
  origin: "legacy_import",
  history: "legacy_unversioned",
  protection: "import_pending",
  approval: "No current pursuit or action approval",
  inPipeline: true,
  display: {
    status: "available",
    company: "Synthetic",
    role: "Role",
    observedStatus: "pending",
    stage: "Observed",
    nextAction: "Unknown",
    verifiedAt: null,
    sourceLabel: "synthetic.json",
    sourceId: "synthetic",
  },
};
const page = {
  format: "pipeline-page-v1",
  status: "available",
  workspaceId: "synthetic_workspace",
  view: "relationships",
  datasetId: "a".repeat(64),
  importObservedAt: 100,
  totalObservations: 154,
  historicalRelationships: 10,
  range: { start: 1, end: 1 },
  items: [projection],
  nextCursor: null,
};
const detail = {
  origin: "legacy_import",
  history: "legacy_unversioned",
  kind: "opportunity",
  entityId: "synthetic_record",
  revision: "1",
  updatedAt: 100,
  body: { display: { company: "Synthetic", role: "Detail Role" }, source: {} },
  bodyStatus: "available",
  provenance: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function client(calls: string[], overrides: Record<string, unknown> = {}) {
  return {
    async session() {
      calls.push("session");
      return { expiresAtMs: Date.now() + 60000 };
    },
    async page() {
      calls.push("old-page");
      return { items: [], nextCursor: null };
    },
    async pipelinePage(view: string) {
      calls.push("pipeline:" + view);
      return { ...page, view };
    },
    async detail() {
      calls.push("detail");
      return detail;
    },
    ...overrides,
  };
}

const mounted: (() => void)[] = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  vi.unstubAllGlobals();
});
async function mount(factory: (grant: string, signal: AbortSignal) => unknown, search = "?grant=synthetic") {
  window.history.replaceState(null, "", "/owner/job-stack" + search);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const services: Services = {
    readClient: (grant, signal) => factory(grant, signal) as ReadClient,
    write: async () => {
      throw Error("unexpected write");
    },
    now: () => Date.now(),
    requestKey: () => crypto.randomUUID(),
  };
  await act(async () => root.render(createElement(App, { services })));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { container, text: () => container.textContent ?? "" };
}
async function waitFor(check: () => boolean, timeout = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw Error("Timed out; screen: " + document.body.textContent?.slice(0, 400));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}
const settle = (ms = 30) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
async function navigate(search: string) {
  await act(async () => {
    window.history.pushState(null, "", "/owner/job-stack" + search);
    window.dispatchEvent(new Event("popstate"));
  });
}

it("initial dashboard requests session and exactly one bounded summary page without any details", async () => {
  const calls: string[] = [];
  const view = await mount(() => client(calls));
  await waitFor(() => view.text().includes("Synthetic"));
  await settle();
  expect(calls).toEqual(["session", "pipeline:relationships"]);
});

it("a deep link requests session and one existing detail without list hydration", async () => {
  const calls: string[] = [];
  const view = await mount(() => client(calls), "?grant=synthetic&record=synthetic_record");
  await waitFor(() => view.text().includes("Detail Role"));
  await settle();
  expect(calls).toEqual(["session", "detail"]);
});

it("view navigation cannot accept an older page even if transport ignores abort", async () => {
  const calls: string[] = [];
  const held = deferred<typeof page>();
  const view = await mount(() =>
    client(calls, {
      pipelinePage: async (v: string) => {
        calls.push("pipeline:" + v);
        return v === "relationships" ? held.promise : { ...page, view: "all", items: [], range: { start: 0, end: 0 }, totalObservations: 0, historicalRelationships: 0 };
      },
    }),
  );
  await waitFor(() => calls.includes("pipeline:relationships"));
  await navigate("?grant=synthetic&view=all");
  await waitFor(() => view.text().includes("No source observations match this view."));
  held.resolve(page);
  await settle();
  expect(view.text()).not.toContain("Synthetic");
  expect(view.container.querySelector('[aria-current="page"].tab')?.textContent).toContain("All observations");
});

it("grant navigation clears old page immediately and late responses cannot restore it", async () => {
  const calls: string[] = [];
  const held = deferred<typeof page>();
  const view = await mount((grant) =>
    client(calls, {
      pipelinePage: async () => (grant === "synthetic" ? held.promise : { ...page, items: [], range: { start: 0, end: 0 }, totalObservations: 0, historicalRelationships: 0 }),
    }),
  );
  await waitFor(() => calls.includes("session"));
  await navigate("?grant=other");
  held.resolve(page);
  await waitFor(() => view.text().includes("No source observations match this view."));
  expect(view.text()).not.toContain("Synthetic");
});

it("expiry clears page and selected data even if an in-flight detail later resolves", async () => {
  const held = deferred<typeof detail>();
  const view = await mount(
    () => ({ ...client([]), session: async () => ({ expiresAtMs: Date.now() + 120 }), detail: () => held.promise }),
    "?grant=synthetic&record=synthetic_record",
  );
  await waitFor(() => view.text().includes("Workspace grant expired. Select a current grant."));
  held.resolve(detail);
  await settle();
  expect(view.text()).not.toContain("Detail Role");
  expect(view.text()).toContain("Workspace grant expired");
});

it("selection navigation binds late details to exact record and generation", async () => {
  const held = deferred<typeof detail>();
  const view = await mount(
    () =>
      client([], {
        detail: async (_kind: string, id: string) =>
          id === "synthetic_record" ? held.promise : { ...detail, entityId: id, body: { display: { company: "New", role: "New Role" }, source: {} } },
      }),
    "?grant=synthetic&record=synthetic_record",
  );
  await settle();
  await navigate("?grant=synthetic&record=new_record");
  await waitFor(() => view.text().includes("New Role"));
  held.resolve(detail);
  await settle();
  expect(view.text()).toContain("new_record");
  expect(view.text()).not.toContain("Detail Role");
});

it("the page client uses one operation-bound nonce and rejects response view mismatch", async () => {
  const valid = { ...page, historicalRelationships: 1 };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ nonce: "synthetic" }))
    .mockResolvedValueOnce(Response.json(valid));
  vi.stubGlobal("fetch", fetcher);
  const c = createReadClient("synthetic") as unknown as {
    pipelinePage: (view: string, cursor: null) => Promise<unknown>;
  };
  expect(typeof c.pipelinePage).toBe("function");
  expect(await c.pipelinePage("relationships", null)).toEqual(valid);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(String(fetcher.mock.calls[0]?.[0])).toContain("job_stack_pipeline_page");
  fetcher
    .mockResolvedValueOnce(Response.json({ nonce: "next" }))
    .mockResolvedValueOnce(Response.json({ ...page, view: "all" }));
  await expect(c.pipelinePage("relationships", null)).rejects.toThrow();
});

it("summary cards explicitly label page search, source-observed counts and pending history", () => {
  const p = {
    records: [projection],
    complete: true,
    total: 154,
    historicalRelationships: 10,
    range: { start: 1, end: 1 },
    nextCursor: null,
    canPrevious: false,
    previous: () => {},
    next: () => {},
    query: "",
    setQuery: () => {},
    select: () => {},
  };
  const html = renderToStaticMarkup(createElement(PipelineList, p as unknown as PipelineListProps));
  expect(html).toContain("Synthetic");
  expect(html).toContain("Search this page");
  expect(html).toContain("Source-observed");
  expect(html).toContain("154");
  expect(html).toContain("Signed history and protection pending");
});

it("existing detail client rejects a different record identity", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ nonce: "synthetic" })).mockResolvedValueOnce(Response.json({ record: { ...detail, entityId: "other" } }));
  vi.stubGlobal("fetch", fetcher);
  await expect(createReadClient("synthetic").detail("opportunity", "synthetic_record")).rejects.toThrow("identity");
});

it("generation guards reject old pages even when abort never marks the signal", async () => {
  const held = deferred<typeof page>();
  const neverAborted = new AbortController().signal;
  const seen: AbortSignal[] = [];
  const view = await mount((_grant, signal) => {
    seen.push(signal);
    return client([], {
      pipelinePage: async (v: string) =>
        v === "relationships" ? held.promise : { ...page, view: "all", items: [], range: { start: 0, end: 0 }, totalObservations: 0, historicalRelationships: 0 },
      signal: neverAborted,
    });
  });
  await settle();
  await navigate("?grant=synthetic&view=all");
  held.resolve(page);
  await waitFor(() => view.text().includes("No source observations match this view."));
  expect(view.text()).not.toContain("Synthetic");
});

it("an old render effect cannot start after the current selection advances", async () => {
  const calls: string[] = [];
  const session = deferred<{ expiresAtMs: number }>();
  const view = await mount(() =>
    client(calls, {
      session: () => {
        calls.push("session");
        return session.promise;
      },
    }),
  );
  await navigate("?grant=synthetic&view=all");
  session.resolve({ expiresAtMs: Date.now() + 60000 });
  await waitFor(() => calls.includes("pipeline:all"));
  await settle();
  expect(calls).not.toContain("pipeline:relationships");
  expect(view.text()).toContain("Synthetic");
});

it("a deep link without a selected grant shows an access error rather than endless loading", async () => {
  const calls: string[] = [];
  const view = await mount(() => client(calls), "?record=synthetic_record");
  await waitFor(() => view.text().includes("Select an existing workspace grant"));
  expect(calls).toEqual([]);
});

it("selected version response must match the exact requested version identity", async () => {
  const calls: string[] = [];
  const view = await mount(
    () =>
      client(calls, {
        detail: async () => ({ ...detail, origin: "domain_record", history: "versioned", lineageId: "lineage", versionId: "current", manifestDigest: "b".repeat(64) }),
        versions: async () => ({ items: [{ versionId: "requested", lineageId: "lineage", createdAt: 1 }], nextCursor: null }),
        version: async () => ({ versionId: "different", lineageId: "lineage", entityId: detail.entityId }),
        protection: async () => {
          calls.push("protection");
          return {};
        },
      }),
    "?grant=synthetic&record=synthetic_record&history=1&version=requested",
  );
  await waitFor(() => view.text().includes("Version does not belong to the selected record"));
  await settle();
  expect(calls).not.toContain("protection");
});
