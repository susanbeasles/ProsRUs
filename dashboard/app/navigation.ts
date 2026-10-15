import type { WorkspaceStore } from "../lib/workspace";
import type { Router } from "./router";

/**
 * The navigation invariant: every distinct route change, before views re-render, either replaces
 * the workspace (grant change: all reads aborted, pending writes cancelled, cache dropped) or
 * advances the cache generation so every in-flight read aborts and late responses are dropped.
 * Equal routes never reach this listener (Router.navigate/sync ignore them).
 */
export function bindNavigation(router: Router, store: WorkspaceStore): () => void {
  return router.onNavigate((previous, next) => {
    const workspace = store.forGrant(next.grant);
    if (previous.grant !== next.grant) return;
    workspace.cache.beginNavigation();
    workspace.restore();
  });
}
