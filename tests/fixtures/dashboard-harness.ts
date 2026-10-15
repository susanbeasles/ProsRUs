import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
/** Executes the actual App callbacks/effects with deterministic hooks; not browser or React rendering evidence. */
export function dashboardHarness(
  client: (grant: string, signal: AbortSignal) => unknown,
  search = "?grant=synthetic",
  ignoreAbort = false,
  deferInitialEffects = false,
) {
  const source = readFileSync(
    new URL("../../dashboard/main.tsx", import.meta.url),
    "utf8",
  );
  const parsed = ts.createSourceFile(
    "main.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const functions = parsed.statements.filter(
    (n): n is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(n) &&
      ["App", "locationState"].includes(n.name?.text ?? ""),
  );
  const executable = ts.transpileModule(
    functions.map((n) => n.getText(parsed)).join("\n"),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
      },
    },
  ).outputText;
  const states: unknown[] = [],
    refs: { current: unknown }[] = [],
    effects: { deps: unknown[]; cleanup?: () => void }[] = [];
  let stateIndex = 0,
    refIndex = 0,
    effectIndex = 0,
    dirty = false,
    props: Record<string, unknown> = {},
    refresh = () => {};
  let holdEffects = deferInitialEffects, tree: unknown;
  const pending: (() => void)[] = [],
    timers = new Map<number, () => void>(),
    listeners = new Map<string, () => void>();
  let timerId = 0;
  const location = {
    href: "https://local.invalid/owner/job-stack" + search,
    search,
  };
  const ctx = {
    URL,
    URLSearchParams,
    AbortController: ignoreAbort ? class extends AbortController { override abort() {} } : AbortController,
    Date,
    Error,
    Set,
    Map,
    Math,
    JSON,
    location,
    createReadClient: client,
    Opportunities: "Opportunities",
    useRef(value: unknown) {
      const i = refIndex++;
      return refs[i] ?? (refs[i] = { current: value });
    },
    useState(value: unknown) {
      const i = stateIndex++;
      if (!(i in states))
        states[i] = typeof value === "function" ? value() : value;
      return [
        states[i],
        (next: unknown) => {
          const result = typeof next === "function" ? next(states[i]) : next;
          if (!Object.is(result, states[i])) {
            states[i] = result;
            dirty = true;
          }
        },
      ];
    },
    useEffect(run: () => void | (() => void), deps: unknown[] = []) {
      const i = effectIndex++,
        prior = effects[i];
      if (
        !prior ||
        deps.some((x, j) => !Object.is(x, prior.deps[j])) ||
        deps.length !== prior.deps.length
      )
        pending.push(() => {
          prior?.cleanup?.();
          const cleanup = run();
          effects[i] = {
            deps,
            cleanup: typeof cleanup === "function" ? cleanup : undefined,
          };
        });
    },
    setTimeout(fn: () => void) {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    addEventListener(name: string, fn: () => void) {
      listeners.set(name, fn);
    },
    removeEventListener(name: string) {
      listeners.delete(name);
    },
    window: {
      history: {
        pushState(_a: unknown, _b: unknown, url: URL) {
          location.href = url.href;
          location.search = url.search;
        },
      },
    },
    React: {
      createElement(
        type: unknown,
        p: Record<string, unknown> | null,
        ...children: unknown[]
      ) {
        if (type === "Opportunities") props = p ?? {};
        if (type === "button" && children.includes("Refresh authorized reads"))
          refresh = p?.onClick as () => void;
        return { type, props: p, children };
      },
    },
  };
  const context = vm.createContext(ctx);
  vm.runInContext(executable, context);
  function render() {
    stateIndex = refIndex = effectIndex = 0;
    dirty = false;
    props = {};
    tree = vm.runInContext("App()", context);
    if (!holdEffects) for (const run of pending.splice(0)) run();
  }
  async function flush() {
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setImmediate(r));
      if (dirty) render();
    }
  }
  render();
  return {
    flush,
    tree: () => tree,
    releaseEffects() { holdEffects=false; for (const run of pending.splice(0)) run(); },
    props: () => props,
    refresh: () => refresh(),
    pop(search: string) {
      location.search = search;
      location.href = "https://local.invalid/owner/job-stack" + search;
      listeners.get("popstate")?.();
    },
    expire() {
      for (const fn of [...timers.values()]) fn();
    },
    dispose() {
      for (const e of effects) e?.cleanup?.();
      timers.clear();
    },
    render,
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
