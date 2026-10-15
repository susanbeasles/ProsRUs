import { Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { PageSkeleton } from "../components/Feedback";
import { ToastProvider } from "../components/Toasts";
import { WorkspaceContext } from "../lib/hooks";
import { browserServices, WorkspaceStore, type Services } from "../lib/workspace";
import { AuthorityGate } from "./AuthorityGate";
import { RouterContext } from "./context";
import { ErrorBoundary } from "./ErrorBoundary";
import { MutationToasts } from "./MutationToasts";
import { bindNavigation } from "./navigation";
import { createRouter, routeSearch, type Router } from "./router";
import { ROUTES } from "./routes";
import { Shell } from "./Shell";

/**
 * Composition root. Every distinct navigation advances the cache generation (aborting in-flight
 * reads) before views re-render; a grant change replaces the whole workspace.
 */
export function App({ services = browserServices, router: provided }: { services?: Services; router?: Router }) {
  const [router] = useState(() => provided ?? createRouter());
  const [store] = useState(() => new WorkspaceStore(services));
  const route = useSyncExternalStore(router.subscribe, router.route, router.route);
  useEffect(() => router.start(), [router]);
  useEffect(() => bindNavigation(router, store), [router, store]);
  const workspace = store.forGrant(route.grant);
  const Page = ROUTES[route.page];
  return (
    <RouterContext.Provider value={router}>
      <WorkspaceContext.Provider value={workspace}>
        <ToastProvider key={workspace.grant}>
          <MutationToasts />
          <Shell>
            <ErrorBoundary resetKey={routeSearch(route)}>
              <AuthorityGate>
                <Suspense fallback={<PageSkeleton />}>
                  <Page />
                </Suspense>
              </AuthorityGate>
            </ErrorBoundary>
          </Shell>
        </ToastProvider>
      </WorkspaceContext.Provider>
    </RouterContext.Provider>
  );
}
