import { expect, it, vi, afterEach } from "vitest";
import { dashboardHarness, deferred } from "./fixtures/dashboard-harness";
import { createReadClient } from "../dashboard/api";
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
  body: { display: { company: "Synthetic", role: "Role" }, source: {} },
  bodyStatus: "available",
  provenance: null,
};
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
afterEach(() => vi.unstubAllGlobals());
it("initial dashboard requests session and exactly one bounded summary page without any details", async () => {
  const calls: string[] = [];
  const h = dashboardHarness(() => client(calls));
  await h.flush();
  expect(calls).toEqual(["session", "pipeline:relationships"]);
  expect(h.props().records).toEqual([projection]);
  h.dispose();
});
it("a deep link requests session and one existing detail without list hydration", async () => {
  const calls: string[] = [];
  const h = dashboardHarness(
    () => client(calls),
    "?grant=synthetic&record=synthetic_record",
  );
  await h.flush();
  expect(calls).toEqual(["session", "detail"]);
  expect(h.props().current).toEqual(detail);
  h.dispose();
});
it("view navigation cannot accept an older page even if transport ignores abort", async () => {
  const calls: string[] = [];
  const held = deferred<typeof page>();
  const h = dashboardHarness(() =>
    client(calls, {
      pipelinePage: async (view: string) => {
        calls.push("pipeline:" + view);
        return view === "relationships"
          ? held.promise
          : { ...page, view: "all", items: [] };
      },
    }),
  );
  await h.flush();
  (h.props().setAll as (all: boolean) => void)(true);
  await h.flush();
  held.resolve(page);
  await h.flush();
  expect(h.props().records).toEqual([]);
  expect(h.props().all).toBe(true);
  h.dispose();
});
it("grant navigation clears old page immediately and late responses cannot restore it", async () => {
  const calls: string[] = [];
  const held = deferred<typeof page>();
  const h = dashboardHarness((grant) =>
    client(calls, {
      pipelinePage: async () =>
        grant === "synthetic" ? held.promise : { ...page, items: [] },
    }),
  );
  await h.flush();
  h.pop("?grant=other");
  held.resolve(page);
  await h.flush();
  expect(h.props().records).toEqual([]);
  h.dispose();
});
it("expiry clears page and selected data even if an in-flight detail later resolves", async () => {
  const calls: string[] = [];
  const held = deferred<typeof detail>();
  const h = dashboardHarness(
    () => client(calls, { detail: () => held.promise }),
    "?grant=synthetic&record=synthetic_record",
  );
  await h.flush();
  h.expire();
  held.resolve(detail);
  await h.flush();
  expect(h.props().current).not.toEqual(detail);
  h.dispose();
});
it("selection navigation binds late details to exact record and generation", async () => {
  const held = deferred<typeof detail>();
  const calls: string[] = [];
  const h = dashboardHarness(
    () =>
      client(calls, {
        detail: async (_kind: string, id: string) =>
          id === "synthetic_record"
            ? held.promise
            : { ...detail, entityId: id },
      }),
    "?grant=synthetic&record=synthetic_record",
  );
  await h.flush();
  (h.props().select as (id: string) => void)("new_record");
  await h.flush();
  held.resolve(detail);
  await h.flush();
  expect((h.props().current as { entityId: string }).entityId).toBe(
    "new_record",
  );
  h.dispose();
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
  expect(String(fetcher.mock.calls[0]?.[0])).toContain(
    "job_stack_pipeline_page",
  );
  fetcher
    .mockResolvedValueOnce(Response.json({ nonce: "next" }))
    .mockResolvedValueOnce(Response.json({ ...page, view: "all" }));
  await expect(c.pipelinePage("relationships", null)).rejects.toThrow();
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Opportunities,
  type PipelineProps,
} from "../dashboard/pages/Opportunities";
it("summary cards explicitly label page search, source-observed counts and pending history", () => {
  const p = {
    records: [projection],
    current: null,
    selected: null,
    complete: true,
    loaded: 1,
    total: 154,
    historicalRelationships: 10,
    range: { start: 1, end: 1 },
    nextCursor: null,
    canPrevious: false,
    previous: () => {},
    next: () => {},
    query: "",
    setQuery: () => {},
    all: false,
    setAll: () => {},
    select: () => {},
    history: false,
    versions: [],
    version: null,
    selectedVersion: null,
    protection: null,
    selectVersion: () => {},
  };
  const html = renderToStaticMarkup(
    createElement(Opportunities, p as unknown as PipelineProps),
  );
  expect(html).toContain("Synthetic");
  expect(html).toContain("Search this page");
  expect(html).toContain("Source-observed");
  expect(html).toContain("154");
  expect(html).toContain("Signed history and protection pending");
});
it('existing detail client rejects a different record identity',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json({nonce:'synthetic'})).mockResolvedValueOnce(Response.json({record:{...detail,entityId:'other'}}));
 vi.stubGlobal('fetch',fetcher);
 await expect(createReadClient('synthetic').detail('opportunity','synthetic_record')).rejects.toThrow('identity');
});
it('generation guards reject old pages even when abort never marks the signal',async()=>{
 const calls:string[]=[];const held=deferred<typeof page>();
 const h=dashboardHarness(()=>client(calls,{pipelinePage:async(view:string)=>view==='relationships'?held.promise:{...page,view:'all',items:[]}}),'?grant=synthetic',true);
 await h.flush();(h.props().setAll as (all:boolean)=>void)(true);await h.flush();held.resolve(page);await h.flush();
 expect(h.props().all).toBe(true);expect(h.props().records).toEqual([]);h.dispose();
});
it('an old render effect cannot start after the current selection ref advances',async()=>{
 const calls:string[]=[];const held=deferred<typeof page>();
 const h=dashboardHarness(()=>client(calls,{pipelinePage:async(view:string)=>{calls.push('pipeline:'+view);return view==='all'?held.promise:page;}}),'?grant=synthetic',true,true);
 (h.props().setAll as (all:boolean)=>void)(true);h.releaseEffects();await h.flush();
 expect(calls).not.toContain('pipeline:relationships');expect(h.props().records).toEqual([]);
 held.resolve({...page,view:'all'});await h.flush();h.dispose();
});
it('a deep link without a selected grant shows an access error rather than endless loading',async()=>{
 const calls:string[]=[];const h=dashboardHarness(()=>client(calls),'?record=synthetic_record');await h.flush();
 expect(calls).toEqual([]);expect(JSON.stringify(h.tree())).toContain('Select an existing workspace grant');h.dispose();
});

it('selected version response must match the exact requested version identity',async()=>{
 const calls:string[]=[];
 const h=dashboardHarness(()=>client(calls,{
  detail:async()=>({...detail,history:'versioned',lineageId:'lineage',versionId:'current'}),
  versions:async()=>({items:[{versionId:'requested',createdAt:1}],nextCursor:null}),
  version:async()=>({versionId:'different',lineageId:'lineage',entityId:detail.entityId}),
  protection:async()=>{calls.push('protection');return {};},
 }),'?grant=synthetic&record=synthetic_record&history=1&version=requested');
 await h.flush();
 expect(JSON.stringify(h.tree())).toContain('Version does not belong to the selected record');
 expect(calls).not.toContain('protection');h.dispose();
});
