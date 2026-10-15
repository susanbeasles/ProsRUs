import { createContext, createElement, useContext, useEffect, useRef, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import type { FocusTarget, Route, Router } from "./router";

export const RouterContext = createContext<Router | null>(null);

export function useRouter(): Router {
  const router = useContext(RouterContext);
  if (!router) throw Error("Router context missing");
  return router;
}

export function useRoute(): Route {
  const router = useRouter();
  return useSyncExternalStore(router.subscribe, router.route, router.route);
}

function useGeneration(router: Router | null): number {
  return useSyncExternalStore(
    router ? router.subscribe : noopSubscribe,
    () => router?.generation ?? 0,
    () => router?.generation ?? 0,
  );
}
const noopSubscribe = () => () => {};

/** Moves focus to this element when the latest navigation targets it (route-change focus). */
export function useNavigationFocus<T extends HTMLElement>(target: FocusTarget) {
  const router = useContext(RouterContext);
  const ref = useRef<T>(null);
  const generation = useGeneration(router);
  useEffect(() => {
    if (ref.current && router?.consumeFocus(target)) ref.current.focus();
  }, [router, target, generation]);
  return ref;
}

/** Error and access states take the pending focus target, whichever it is. */
export function useNavigationFocusAny<T extends HTMLElement>() {
  const router = useContext(RouterContext);
  const ref = useRef<T>(null);
  const generation = useGeneration(router);
  useEffect(() => {
    const pending = router?.pendingFocus();
    if (ref.current && pending && router?.consumeFocus(pending)) ref.current.focus();
  }, [router, generation]);
  return ref;
}

/** In-app link: a real href (new tab works) with client-side navigation on plain clicks. */
export function RouteLink({
  to,
  children,
  ...rest
}: { to: Route; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const router = useRouter();
  return createElement(
    "a",
    {
      ...rest,
      href: router.href(to),
      onClick: (event: MouseEvent<HTMLAnchorElement>) => {
        rest.onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        router.navigate(to);
      },
    },
    children,
  );
}
