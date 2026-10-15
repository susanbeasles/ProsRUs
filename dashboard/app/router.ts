/**
 * Tiny router over the existing URL parameters (grant, record, history, version, view, cursor)
 * plus `page`. Routes compare semantically: parameter order and unknown parameters never cause a
 * navigation, so repeating the current selection keeps in-flight reads alive.
 */
export const PAGES = [
  "overview",
  "opportunities",
  "conversations",
  "interviews",
  "profile",
  "packets",
  "activity",
  "settings",
  "history",
] as const;
export type PageId = (typeof PAGES)[number];
/** Without `page`, a link opens the pipeline exactly as pre-router deep links did. */
export const DEFAULT_PAGE: PageId = "opportunities";
export const HISTORY_KINDS = ["opportunity", "claim", "profile", "evidence", "artifact", "packet", "thread", "interview", "offer", "settings"] as const;
/** Page-scoped sub-views; the first entry is the default. */
export const PAGE_VIEWS: Readonly<Record<PageId, readonly string[]>> = {
  overview: [],
  opportunities: ["relationships", "all", "tracked"],
  conversations: ["threads", "messages"],
  interviews: ["interviews", "prep"],
  profile: ["claims", "profile", "conflicts"],
  packets: [],
  activity: [],
  settings: [],
  history: HISTORY_KINDS,
};

export type Route = Readonly<{
  page: PageId;
  grant: string;
  record: string | null;
  history: boolean;
  versionId: string | null;
  view: string | null;
  cursor: string | null;
}>;
export type Trail = readonly (string | null)[];
export type FocusTarget = "page-heading" | "detail-heading";

export function normalizeRoute(route: Route): Route {
  const views = PAGE_VIEWS[route.page];
  const versioned = route.page === "opportunities" || route.page === "history";
  const record = route.record || null;
  return Object.freeze({
    page: route.page,
    grant: route.grant,
    record,
    history: route.page === "opportunities" && record !== null && route.history,
    versionId: versioned && record ? route.versionId || null : null,
    view: views.length ? (route.view !== null && views.includes(route.view) ? route.view : (views[0] ?? null)) : null,
    cursor: route.cursor || null,
  });
}

export function parseRoute(search: string): Route {
  const query = new URLSearchParams(search);
  const page = query.get("page");
  return normalizeRoute({
    page: (PAGES as readonly string[]).includes(page ?? "") ? (page as PageId) : DEFAULT_PAGE,
    grant: query.get("grant") ?? "",
    record: query.get("record"),
    history: query.get("history") === "1",
    versionId: query.get("version"),
    view: query.get("view"),
    cursor: query.get("cursor"),
  });
}

export function sameRoute(a: Route, b: Route): boolean {
  return (
    a.page === b.page &&
    a.grant === b.grant &&
    a.record === b.record &&
    a.history === b.history &&
    a.versionId === b.versionId &&
    a.view === b.view &&
    a.cursor === b.cursor
  );
}

export function routeSearch(route: Route): string {
  const r = normalizeRoute(route);
  const query = new URLSearchParams();
  if (r.grant) query.set("grant", r.grant);
  if (r.page !== DEFAULT_PAGE) query.set("page", r.page);
  if (r.view !== null && r.view !== PAGE_VIEWS[r.page][0]) query.set("view", r.view);
  if (r.cursor) query.set("cursor", r.cursor);
  if (r.record) query.set("record", r.record);
  if (r.history) query.set("history", "1");
  if (r.versionId) query.set("version", r.versionId);
  const text = query.toString();
  return text ? "?" + text : "";
}

/** A fresh route for a page within the same grant (sub-view, selection and cursor reset). */
export function pageRoute(grant: string, page: PageId, patch: Partial<Route> = {}): Route {
  return normalizeRoute({
    page,
    grant,
    record: null,
    history: false,
    versionId: null,
    view: null,
    cursor: null,
    ...patch,
  });
}

function parseTrail(state: unknown): (string | null)[] {
  if (typeof state !== "object" || state === null || !("trail" in state)) return [];
  const trail = (state as { trail: unknown }).trail;
  return Array.isArray(trail) && trail.length <= 1000 && trail.every((c) => c === null || (typeof c === "string" && c.length <= 4096))
    ? [...(trail as (string | null)[])]
    : [];
}

export type RouterWindow = {
  readonly location: { readonly search: string; readonly pathname: string };
  readonly history: {
    readonly state: unknown;
    pushState(state: unknown, unused: string, url: string): void;
    replaceState(state: unknown, unused: string, url: string): void;
  };
  addEventListener(type: "popstate", listener: (event: PopStateEvent) => void): void;
  removeEventListener(type: "popstate", listener: (event: PopStateEvent) => void): void;
};
type NavigationListener = (previous: Route, next: Route) => void;

export class Router {
  readonly #window: RouterWindow;
  #route: Route;
  #trail: (string | null)[];
  #generation = 0;
  #focus: FocusTarget | null = null;
  readonly #listeners = new Set<() => void>();
  readonly #navigation = new Set<NavigationListener>();

  constructor(win: RouterWindow) {
    this.#window = win;
    this.#route = parseRoute(win.location.search);
    this.#trail = parseTrail(win.history.state);
  }

  readonly route = (): Route => this.#route;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Called synchronously on every distinct route change, before views re-render. */
  onNavigate(listener: NavigationListener): () => void {
    this.#navigation.add(listener);
    return () => this.#navigation.delete(listener);
  }

  get generation() {
    return this.#generation;
  }

  trail(): Trail {
    return this.#trail;
  }

  href(route: Route): string {
    return this.#window.location.pathname + routeSearch(route);
  }

  /** Returns false (and does nothing) when the target is semantically the current route. */
  navigate(target: Route | ((current: Route) => Route), options: { replace?: boolean; trail?: Trail } = {}): boolean {
    const next = normalizeRoute(typeof target === "function" ? target(this.#route) : target);
    if (sameRoute(next, this.#route)) return false;
    const trail = options.trail
      ? [...options.trail]
      : next.grant !== this.#route.grant || next.page !== this.#route.page || next.view !== this.#route.view
        ? []
        : this.#trail;
    const url = this.href(next);
    if (options.replace) this.#window.history.replaceState({ trail }, "", url);
    else this.#window.history.pushState({ trail }, "", url);
    this.#commit(next, trail);
    return true;
  }

  nextPage(cursor: string): boolean {
    return this.navigate((r) => ({ ...r, cursor, record: null, history: false, versionId: null }), {
      trail: [...this.#trail, this.#route.cursor],
    });
  }

  previousPage(): boolean {
    const trail = [...this.#trail];
    const cursor = trail.pop() ?? null;
    return this.navigate((r) => ({ ...r, cursor, record: null, history: false, versionId: null }), { trail });
  }

  /** Re-reads the location after Back/Forward; an equal route is ignored. */
  readonly sync = (): void => {
    const next = parseRoute(this.#window.location.search);
    const trail = parseTrail(this.#window.history.state);
    if (sameRoute(next, this.#route)) {
      this.#trail = trail;
      return;
    }
    this.#commit(next, trail);
  };

  start(): () => void {
    const listener = () => this.sync();
    this.#window.addEventListener("popstate", listener);
    return () => this.#window.removeEventListener("popstate", listener);
  }

  /** The heading that should receive focus after the latest navigation; consumed once. */
  consumeFocus(target: FocusTarget): boolean {
    if (this.#focus !== target) return false;
    this.#focus = null;
    return true;
  }

  pendingFocus(): FocusTarget | null {
    return this.#focus;
  }

  #commit(next: Route, trail: (string | null)[]) {
    const previous = this.#route;
    this.#route = next;
    this.#trail = trail;
    this.#generation++;
    this.#focus = next.record && (next.record !== previous.record || next.page !== previous.page) ? "detail-heading" : "page-heading";
    for (const listener of [...this.#navigation]) listener(previous, next);
    for (const listener of [...this.#listeners]) listener();
  }
}

export function createRouter(win: RouterWindow = window): Router {
  return new Router(win);
}
