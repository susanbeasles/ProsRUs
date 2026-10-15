/**
 * Framework-free query cache: key -> {data, updatedAt, generation}.
 *
 * Invariants:
 * - A fetch commits only if its AbortSignal is still live, the cache generation it started in is
 *   still current, and it is still the entry's latest fetch. A response that arrives after a
 *   navigation, invalidation or clear is dropped even when the transport ignores abort.
 * - Concurrent requests for the same key share one in-flight fetch.
 * - Data stays visible while it is revalidated (stale-while-revalidate); clear() removes it.
 */
export type QueryKey = readonly (string | number | boolean | null)[];
export type QueryStatus = "idle" | "loading" | "success" | "error";
export type QueryDefinition<T> = {
  readonly key: QueryKey;
  readonly fetch: (signal: AbortSignal) => Promise<T>;
  /** Milliseconds before successful data is considered stale; defaults to 30 seconds. */
  readonly staleMs?: number;
};
export type QuerySnapshot<T> = {
  readonly status: QueryStatus;
  readonly data: T | undefined;
  readonly error: unknown;
  readonly updatedAt: number;
  readonly generation: number;
  readonly isFetching: boolean;
  readonly stale: boolean;
};
type InFlight = {
  readonly controller: AbortController;
  readonly generation: number;
  readonly promise: Promise<unknown>;
};
type Entry = {
  readonly hash: string;
  readonly key: QueryKey;
  definition: QueryDefinition<unknown> | undefined;
  status: QueryStatus;
  data: unknown;
  error: unknown;
  updatedAt: number;
  generation: number;
  stale: boolean;
  inFlight: InFlight | undefined;
  snapshot: QuerySnapshot<unknown> | undefined;
};
const IDLE: QuerySnapshot<never> = Object.freeze({
  status: "idle",
  data: undefined,
  error: undefined,
  updatedAt: 0,
  generation: -1,
  isFetching: false,
  stale: true,
});
export const DEFAULT_STALE_MS = 30_000;

export function hashKey(key: QueryKey): string {
  return JSON.stringify(key);
}

export class QueryCache {
  #entries = new Map<string, Entry>();
  #listeners = new Map<string, Set<() => void>>();
  #generation = 0;
  readonly #now: () => number;
  readonly #onError: (error: unknown, key: QueryKey) => void;

  constructor(options: { now?: () => number; onError?: (error: unknown, key: QueryKey) => void } = {}) {
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? (() => {});
  }

  get generation() {
    return this.#generation;
  }

  snapshot<T>(key: QueryKey): QuerySnapshot<T> {
    const entry = this.#entries.get(hashKey(key));
    if (!entry) return IDLE;
    entry.snapshot ??= Object.freeze({
      status: entry.status,
      data: entry.data,
      error: entry.error,
      updatedAt: entry.updatedAt,
      generation: entry.generation,
      isFetching: entry.inFlight !== undefined,
      stale: this.#isStale(entry),
    });
    return entry.snapshot as QuerySnapshot<T>;
  }

  peek<T>(key: QueryKey): T | undefined {
    return this.#entries.get(hashKey(key))?.data as T | undefined;
  }

  keys(): QueryKey[] {
    return [...this.#entries.values()].map((entry) => entry.key);
  }

  subscribe(key: QueryKey, listener: () => void): () => void {
    const hash = hashKey(key);
    let set = this.#listeners.get(hash);
    if (!set) this.#listeners.set(hash, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) this.#listeners.delete(hash);
    };
  }

  /** Starts a fetch when the key has no fresh data and none is in flight. */
  ensure<T>(definition: QueryDefinition<T>): void {
    const entry = this.#entry(definition.key);
    entry.definition = definition as QueryDefinition<unknown>;
    if (entry.inFlight && entry.inFlight.generation === this.#generation) return;
    if (entry.status === "error" && !entry.stale) return;
    if (entry.status === "success" && !this.#isStale(entry)) return;
    void this.fetch(definition);
  }

  /** Fetches now (sharing a current in-flight fetch) and resolves undefined if the result is dropped. */
  fetch<T>(definition: QueryDefinition<T>): Promise<T | undefined> {
    const entry = this.#entry(definition.key);
    entry.definition = definition as QueryDefinition<unknown>;
    if (entry.inFlight && entry.inFlight.generation === this.#generation)
      return entry.inFlight.promise as Promise<T | undefined>;
    entry.inFlight?.controller.abort();
    const controller = new AbortController(),
      generation = this.#generation;
    const commits = () =>
      !controller.signal.aborted &&
      this.#generation === generation &&
      entry.inFlight?.controller === controller &&
      this.#entries.get(entry.hash) === entry;
    const promise = (async () => {
      try {
        const data = await definition.fetch(controller.signal);
        if (!commits()) return undefined;
        entry.status = "success";
        entry.data = data;
        entry.error = undefined;
        entry.updatedAt = this.#now();
        entry.generation = generation;
        entry.stale = false;
        entry.inFlight = undefined;
        this.#notify(entry);
        return data;
      } catch (error) {
        if (!commits()) return undefined;
        entry.status = "error";
        entry.error = error;
        entry.stale = false;
        entry.inFlight = undefined;
        this.#notify(entry);
        this.#onError(error, entry.key);
        return undefined;
      }
    })();
    entry.inFlight = { controller, generation, promise };
    if (entry.status === "idle" || (entry.status === "error" && entry.data === undefined))
      entry.status = "loading";
    this.#notify(entry);
    return promise;
  }

  /** Writes data directly (optimistic updates and reconciliation); it never advances the generation. */
  setData<T>(key: QueryKey, update: (previous: T | undefined) => T | undefined): void {
    const entry = this.#entry(key);
    const next = update(entry.data as T | undefined);
    if (Object.is(next, entry.data)) return;
    if (next === undefined) {
      entry.inFlight?.controller.abort();
      this.#entries.delete(entry.hash);
      entry.snapshot = undefined;
      this.#emit(entry.hash);
      return;
    }
    entry.data = next;
    entry.status = "success";
    entry.error = undefined;
    entry.updatedAt = this.#now();
    this.#notify(entry);
  }

  /**
   * Aborts matching in-flight fetches and marks their data stale. Subscribed views refetch through
   * ensure(); a response that started before the invalidation can no longer commit.
   */
  invalidate(match: (key: QueryKey) => boolean): void {
    for (const entry of [...this.#entries.values()]) {
      if (!match(entry.key)) continue;
      entry.inFlight?.controller.abort();
      entry.inFlight = undefined;
      entry.stale = true;
      if (entry.status === "loading") entry.status = "idle";
      this.#notify(entry);
    }
  }

  /**
   * A navigation (selection change) advances the generation and aborts every in-flight read.
   * Completed data for exact keys remains cached; aborted entries become stale so the views of the
   * new selection fetch again.
   */
  beginNavigation(): void {
    this.#generation++;
    for (const entry of [...this.#entries.values()]) {
      if (!entry.inFlight) continue;
      entry.inFlight.controller.abort();
      entry.inFlight = undefined;
      entry.stale = true;
      if (entry.status === "loading") entry.status = "idle";
      this.#notify(entry);
    }
  }

  /** Authority loss, grant change or explicit refresh: abort everything and forget all data. */
  clear(): void {
    this.#generation++;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    for (const entry of entries) {
      entry.inFlight?.controller.abort();
      entry.inFlight = undefined;
      entry.snapshot = undefined;
    }
    for (const hash of [...this.#listeners.keys()]) this.#emit(hash);
  }

  #entry(key: QueryKey): Entry {
    const hash = hashKey(key);
    let entry = this.#entries.get(hash);
    if (!entry) {
      entry = {
        hash,
        key,
        definition: undefined,
        status: "idle",
        data: undefined,
        error: undefined,
        updatedAt: 0,
        generation: this.#generation,
        stale: true,
        inFlight: undefined,
        snapshot: undefined,
      };
      this.#entries.set(hash, entry);
    }
    return entry;
  }

  #isStale(entry: Entry): boolean {
    return (
      entry.stale ||
      entry.status !== "success" ||
      this.#now() - entry.updatedAt >= (entry.definition?.staleMs ?? DEFAULT_STALE_MS)
    );
  }

  #notify(entry: Entry) {
    entry.snapshot = undefined;
    this.#emit(entry.hash);
  }

  #emit(hash: string) {
    for (const listener of [...(this.#listeners.get(hash) ?? [])]) listener();
  }
}
