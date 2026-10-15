import { describe, expect, it, vi } from "vitest";
import { createRouter, normalizeRoute, pageRoute, parseRoute, routeSearch, sameRoute, type RouterWindow } from "../dashboard/app/router";

function fakeWindow(search: string, state: unknown = null) {
  const listeners = new Set<(event: PopStateEvent) => void>();
  const pushes: string[] = [];
  const win = {
    location: { search, pathname: "/owner/job-stack" },
    history: {
      state,
      pushState(next: unknown, _unused: string, url: string) {
        pushes.push(url);
        win.history.state = next;
        win.location.search = url.slice(url.indexOf("?") >= 0 ? url.indexOf("?") : url.length);
      },
      replaceState(next: unknown, _unused: string, url: string) {
        win.history.state = next;
        win.location.search = url.slice(url.indexOf("?") >= 0 ? url.indexOf("?") : url.length);
      },
    },
    addEventListener: (_type: "popstate", listener: (event: PopStateEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: "popstate", listener: (event: PopStateEvent) => void) => listeners.delete(listener),
  };
  return {
    win: win as RouterWindow,
    pushes,
    pop(nextSearch: string, nextState: unknown = null) {
      win.location.search = nextSearch;
      win.history.state = nextState;
      for (const listener of listeners) listener({} as PopStateEvent);
    },
  };
}

describe("router", () => {
  it("keeps pre-router deep links: no page means the pipeline with its exact selection", () => {
    expect(parseRoute("?grant=g&record=r&history=1&version=v&view=all&cursor=c")).toEqual({
      page: "opportunities",
      grant: "g",
      record: "r",
      history: true,
      versionId: "v",
      view: "all",
      cursor: "c",
    });
    expect(parseRoute("?grant=g").view).toBe("relationships");
    expect(parseRoute("?grant=g&view=unknown").view).toBe("relationships");
    expect(parseRoute("?grant=g&page=nope").page).toBe("opportunities");
    expect(parseRoute("?grant=g&page=history&view=claim").view).toBe("claim");
    expect(parseRoute("?grant=g&page=overview&view=all").view).toBeNull();
  });

  it("compares routes semantically, ignoring parameter order and unknown parameters", () => {
    expect(sameRoute(parseRoute("?version=v&history=1&record=r&grant=g&ignored=1"), parseRoute("?grant=g&record=r&history=1&version=v"))).toBe(true);
    expect(sameRoute(parseRoute("?grant=g&view=relationships"), parseRoute("?grant=g"))).toBe(true);
    expect(sameRoute(parseRoute("?grant=g&record=a"), parseRoute("?grant=g&record=b"))).toBe(false);
  });

  it("serializes canonical URLs that parse back to the same route", () => {
    for (const search of ["?grant=g", "?grant=g&page=settings", "?grant=g&view=all&cursor=c&record=r&history=1&version=v", "?grant=g&page=history&view=claim&record=x&version=y"]) {
      const route = parseRoute(search);
      expect(sameRoute(parseRoute(routeSearch(route)), route)).toBe(true);
    }
    expect(routeSearch(pageRoute("g", "opportunities"))).toBe("?grant=g");
    expect(routeSearch(normalizeRoute({ ...pageRoute("g", "conversations"), view: "messages" }))).toBe("?grant=g&page=conversations&view=messages");
  });

  it("ignores navigation to the current route and notifies distinct navigation synchronously", () => {
    const { win, pushes } = fakeWindow("?grant=g&record=r");
    const router = createRouter(win);
    const onNavigate = vi.fn(),
      onChange = vi.fn();
    router.onNavigate(onNavigate);
    router.subscribe(onChange);
    expect(router.navigate((r) => ({ ...r }))).toBe(false);
    expect(pushes).toEqual([]);
    expect(router.navigate((r) => ({ ...r, record: "other" }))).toBe(true);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate.mock.calls[0]?.[1]).toMatchObject({ record: "other" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(pushes).toEqual(["/owner/job-stack?grant=g&record=other"]);
    expect(router.navigate((r) => ({ ...r, record: "other" }))).toBe(false);
    expect(pushes).toHaveLength(1);
  });

  it("ignores semantically equal Back/Forward locations", () => {
    const fake = fakeWindow("?grant=g&record=r");
    const router = createRouter(fake.win);
    router.start();
    const onNavigate = vi.fn();
    router.onNavigate(onNavigate);
    fake.pop("?record=r&grant=g&unrelated=1");
    expect(onNavigate).not.toHaveBeenCalled();
    fake.pop("?grant=other&record=r");
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(router.route().grant).toBe("other");
  });

  it("keeps a page trail for previous/next and restores it from history state", () => {
    const fake = fakeWindow("?grant=g");
    const router = createRouter(fake.win);
    router.start();
    router.nextPage("c1");
    router.nextPage("c2");
    expect(router.route().cursor).toBe("c2");
    expect(router.trail()).toEqual([null, "c1"]);
    router.previousPage();
    expect(router.route().cursor).toBe("c1");
    expect(router.trail()).toEqual([null]);
    fake.pop("?grant=g&cursor=c2", { trail: [null, "c1"] });
    expect(router.trail()).toEqual([null, "c1"]);
    router.navigate((r) => ({ ...r, view: "all" }));
    expect(router.trail()).toEqual([]);
    fake.pop("?grant=g&cursor=zz", { trail: "not a trail" });
    expect(router.trail()).toEqual([]);
  });

  it("requests focus for the detail heading on record changes and the page heading otherwise", () => {
    const router = createRouter(fakeWindow("?grant=g").win);
    router.navigate((r) => ({ ...r, record: "x" }));
    expect(router.pendingFocus()).toBe("detail-heading");
    expect(router.consumeFocus("page-heading")).toBe(false);
    expect(router.consumeFocus("detail-heading")).toBe(true);
    expect(router.consumeFocus("detail-heading")).toBe(false);
    router.navigate(pageRoute("g", "settings"));
    expect(router.pendingFocus()).toBe("page-heading");
  });
});
