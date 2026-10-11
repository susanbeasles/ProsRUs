import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

// Execute the maintained callbacks and dependency expression, not a rewritten
// navigation model. This is source-level evidence, not browser/React execution.
const source = readFileSync(
  new URL("../dashboard/main.tsx", import.meta.url),
  "utf8",
);
const parsed = ts.createSourceFile(
  "main.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const app = parsed.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "App",
);
const location = parsed.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "locationState",
);
if (!app?.body || !location) throw Error("Actual navigation source missing");
const callbacks = app.body.statements.filter(ts.isFunctionDeclaration);
const effects = app.body.statements
  .filter(ts.isExpressionStatement)
  .map((node) => node.expression)
  .filter(
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      node.expression.getText(parsed) === "useEffect",
  );
const dependencies = effects.at(-1)?.arguments[1];
let pop: ts.Expression | undefined, refresh: ts.Expression | undefined;
function inspect(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === "pop")
    pop = node.initializer;
  if (
    ts.isJsxAttribute(node) &&
    node.name.getText(parsed) === "onClick" &&
    node.initializer &&
    ts.isJsxExpression(node.initializer) &&
    node.initializer.expression?.getText(parsed).includes("setRefresh")
  )
    refresh = node.initializer.expression;
  ts.forEachChild(node, inspect);
}
inspect(app);
if (!dependencies || !pop || !refresh)
  throw Error("Actual navigation callback/dependencies missing");
const callbackSource =
  [location, ...callbacks].map((node) => node.getText(parsed)).join("\n") +
  `\nfunction readDependencies(){return ${dependencies.getText(parsed)};}\nfunction runPop(){(${pop.getText(parsed)})();}\nfunction runRefresh(){(${refresh.getText(parsed)})();}`;
const executable = ts.transpileModule(callbackSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
type Selection = {
  grant: string;
  record: string | null;
  history: boolean;
  versionId: string | null;
  view: "relationships" | "all";
  cursor: string | null;
};
function fixture(query: string) {
  const url = new URL("https://local.invalid/owner/job-stack?" + query),
    controller = new AbortController();
  const params = url.searchParams;
  const selection: Selection = {
    grant: params.get("grant") ?? "",
    record: params.get("record"),
    history: params.get("history") === "1",
    versionId: params.get("version"),
    view: params.get("view") === "all" ? "all" : "relationships",
    cursor: params.get("cursor"),
  };
  const state: {
    current: unknown;
    versions: unknown;
    version: unknown;
    protection: unknown;
  } = {
    current: { entityId: "record" },
    versions: [{ versionId: "past" }],
    version: { versionId: "past" },
    protection: { status: "available" },
  };
  const original = { ...state };
  let cleared = 0,
    pushes = 0,
    selectionUpdates = 0;
  const context = {
    URL,
    URLSearchParams,
    location: { href: url.href, search: url.search },
    selection,
    selectionRef: { current: selection },
    refresh: 0,
    detailController: { current: controller },
    navigationGeneration: {current:0},
    pageTrail: {current:[]},
    active: {current:new Set([controller])},
    page:null,
    setRecords:()=>{},setPage:()=>{},setTotal:()=>{},setComplete:()=>{},setError:()=>{},
    setCurrent: (v: unknown) => {
      cleared++;
      state.current = v;
    },
    setVersions: (v: unknown) => {
      state.versions = v;
    },
    setVersion: (v: unknown) => {
      state.version = v;
    },
    setProtection: (v: unknown) => {
      state.protection = v;
    },
    setSelection: (v: Selection) => {
      selectionUpdates++;
      context.selection = v;
    },
    setRefresh: (f: (v: number) => number) => {
      context.refresh = f(context.refresh);
    },
    window: {
      history: {
        pushState: (_state: unknown, _title: string, u: URL) => {
          pushes++;
          context.location.href = u.href;
          context.location.search = u.search;
        },
      },
    },
  };
  const sandbox = vm.createContext(context);
  vm.runInContext(executable, sandbox);
  function run(code: string) {
    return vm.runInContext(code, sandbox);
  }
  const before: readonly unknown[] = run("readDependencies()");
  return {
    state,
    original,
    controller,
    context,
    run,
    unchanged: () => {
      const after: readonly unknown[] = run("readDependencies()");
      return before.every((v, i) => Object.is(v, after[i]));
    },
    counts: () => ({ cleared, pushes, selectionUpdates }),
  };
}
const current = "grant=grant&record=record",
  history = current + "&history=1",
  past = history + "&version=past";
for (const [name, query, action] of [
  ["selected history version", past, 'selectVersion("past")'],
  ["current record", current, 'select("record")'],
  ["current history target", history, 'select("record",true)'],
  ["current history version list", history, "selectVersion(null)"],
] as const)
  it(`repeating the ${name} preserves current data and its in-flight controller`, () => {
    const f = fixture(query);
    f.run(action);
    expect(f.controller.signal.aborted).toBe(false);
    expect(f.state).toEqual(f.original);
    expect(f.unchanged()).toBe(true);
    expect(f.counts()).toEqual({ cleared: 0, pushes: 0, selectionUpdates: 0 });
  });
it("equal semantic pop navigation preserves data despite URL order/irrelevant fields", () => {
  const f = fixture(past);
  f.context.location.search =
    "?version=past&history=1&record=record&grant=grant&ignored=1";
  f.run("runPop()");
  expect(f.controller.signal.aborted).toBe(false);
  expect(f.state).toEqual(f.original);
  expect(f.unchanged()).toBe(true);
  expect(f.counts().cleared).toBe(0);
});
for (const action of ['selectVersion("other")', 'select("other_record")'])
  it(`distinct navigation cancels and changes actual loader dependencies: ${action}`, () => {
    const f = fixture(past);
    f.run(action);
    expect(f.controller.signal.aborted).toBe(true);
    expect(f.state.current).toBe(null);
    expect(f.state.protection).toBe(null);
    expect(f.unchanged()).toBe(false);
    expect(f.counts().pushes).toBe(1);
  });
it("a distinct grant pop cancels old detail and changes actual loader dependencies", () => {
  const f = fixture(past);
  f.context.location.search =
    "?grant=other&record=record&history=1&version=past";
  f.run("runPop()");
  expect(f.controller.signal.aborted).toBe(true);
  expect(f.state.current).toBe(null);
  expect(f.state.protection).toBe(null);
  expect(f.unchanged()).toBe(false);
  expect(f.counts().pushes).toBe(0);
});
it("explicit refresh clears and always advances a real loader dependency", () => {
  const f = fixture(past);
  f.run("runRefresh()");
  expect(f.controller.signal.aborted).toBe(true);
  expect(f.state.current).toBe(null);
  expect(f.state.protection).toBe(null);
  expect(f.unchanged()).toBe(false);
  expect(f.context.refresh).toBe(1);
});
it("a repeated new target stays idempotent before another render or effect", () => {
  const f = fixture(past);
  f.run('selectVersion("other")');
  const once = f.counts();
  f.run('selectVersion("other")');
  expect(f.counts()).toEqual(once);
  expect(f.context.selectionRef.current.versionId).toBe("other");
});
