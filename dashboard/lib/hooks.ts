import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { MutationHandle, MutationRecord, MutationSpec } from "./mutations";
import type { ReadQuery } from "./queries";
import { hashKey, type QuerySnapshot } from "./queryCache";
import { IntentTracker } from "./requestKeys";
import type { Authority, Workspace } from "./workspace";

export const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw Error("Workspace context missing");
  return workspace;
}

export type QueryState<T> = QuerySnapshot<T> & { readonly refetch: () => void };
const NONE = () => () => {};
const IDLE: QuerySnapshot<never> = Object.freeze({
  status: "idle",
  data: undefined,
  error: undefined,
  updatedAt: 0,
  generation: -1,
  isFetching: false,
  stale: true,
});

/**
 * Subscribes to one cached read and keeps it loaded. A null query is disabled (no request). The
 * cache drops any response that arrives after a navigation, invalidation or authority loss.
 */
export function useQuery<T>(query: ReadQuery<T> | null): QueryState<T> {
  const workspace = useWorkspace();
  const hash = query ? hashKey(query.key) : null;
  // The key captures every input of run(), so the definition only changes with the hash.
  const definition = useMemo(() => (query ? workspace.read(query) : null), [workspace, hash]);
  const subscribe = useCallback(
    (notify: () => void) => (definition ? workspace.cache.subscribe(definition.key, notify) : NONE()),
    [workspace, definition],
  );
  const snapshot = useCallback(
    () => (definition ? workspace.cache.snapshot<T>(definition.key) : IDLE),
    [workspace, definition],
  );
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (definition) workspace.cache.ensure(definition);
  }, [workspace, definition, state.status, state.stale, state.isFetching]);
  const refetch = useCallback(() => {
    if (definition) void workspace.cache.fetch(definition);
  }, [workspace, definition]);
  return useMemo(() => ({ ...state, refetch }), [state, refetch]);
}

export function useAuthority(): Authority {
  const workspace = useWorkspace();
  return useSyncExternalStore(workspace.subscribe, workspace.authority, workspace.authority);
}

export function useMutationRecords(): readonly MutationRecord[] {
  const { mutations } = useWorkspace();
  return useSyncExternalStore(mutations.subscribe, mutations.list, mutations.list);
}

/** Pending, failed and recently completed mutations of one entity (newest first). */
export function useEntityMutations(entity: string | null): readonly MutationRecord[] {
  const records = useMutationRecords();
  return useMemo(() => (entity ? records.filter((record) => record.entity === entity) : []), [records, entity]);
}

/**
 * One user intent (a form): submitting identical values after a retryable failure retries the
 * earlier mutation with its request key; changed values start a new intent with a new key.
 */
export function useIntent() {
  const workspace = useWorkspace();
  const tracker = useRef(new IntentTracker());
  return useCallback(
    <V>(spec: MutationSpec<V>): MutationHandle => {
      const decision = tracker.current.decide(spec.values, (id) => {
        const record = workspace.mutations.get(id);
        return record?.status === "error" && record.retryable;
      });
      const handle =
        (decision.kind === "retry" ? workspace.mutations.retry(decision.mutationId) : null) ??
        workspace.mutations.start(spec);
      tracker.current.remember(spec.values, handle.id);
      void handle.settled.then((record) => {
        if (record.status === "success") tracker.current.reset();
      });
      return handle;
    },
    [workspace],
  );
}

/** Reads a cached value without fetching it (used to enrich list rows with already-loaded details). */
export function usePeek<T>(key: readonly (string | number | boolean | null)[] | null): T | undefined {
  const workspace = useWorkspace();
  const hash = key ? hashKey(key) : null;
  const subscribe = useCallback(
    (notify: () => void) => (key ? workspace.cache.subscribe(key, notify) : NONE()),
    [workspace, hash],
  );
  const read = useCallback(() => (key ? workspace.cache.peek<T>(key) : undefined), [workspace, hash]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Refetches at most once per interval, only while the document is visible; returning to a visible
 * tab refetches when the data is older than the interval. Hidden tabs never poll.
 */
export function useVisiblePolling(refetch: () => void, updatedAt: number, intervalMs: number, enabled: boolean) {
  const workspace = useWorkspace();
  const latest = useRef({ refetch, updatedAt });
  latest.current = { refetch, updatedAt };
  useEffect(() => {
    if (!enabled) return;
    const due = () =>
      document.visibilityState === "visible" && workspace.services.now() - latest.current.updatedAt >= intervalMs;
    const poll = () => {
      if (due()) latest.current.refetch();
    };
    const timer = setInterval(poll, intervalMs);
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [workspace, intervalMs, enabled]);
}
