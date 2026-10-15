import type { DomainWriteOutput, WriteInput, WriteOperation } from "./api";
import { ApiError, isAbort, isAuthorityLoss } from "./api";
import type { QueryCache, QueryKey } from "./queryCache";
import { createRequestKey } from "./requestKeys";

export type MutationStatus = "queued" | "running" | "success" | "error" | "cancelled";
export type MutationRecord = Readonly<{
  id: string;
  requestKey: string;
  operation: WriteOperation;
  entity: string;
  label: string;
  status: MutationStatus;
  error: unknown;
  result: DomainWriteOutput | undefined;
  createdAt: number;
  settledAt: number | null;
  attempts: number;
  retryable: boolean;
  cancelReason: string | null;
}>;
export type Rollback = () => void;
export type MutationContext = { readonly requestKey: string; readonly mutationId: string; readonly at: number };
export type MutationSpec<V> = {
  readonly operation: WriteOperation;
  /** Serialization key: mutations on the same entity run one at a time, in order. */
  readonly entity: string;
  readonly label: string;
  readonly values: V;
  /** Builds the request body when the mutation actually runs (after earlier ones on the entity). */
  readonly body: (values: V, cache: QueryCache) => unknown;
  readonly optimistic?: (cache: QueryCache, values: V, context: MutationContext) => Rollback | void;
  readonly reconcile?: (cache: QueryCache, result: DomainWriteOutput, values: V, context: MutationContext) => void;
  readonly invalidate?: (key: QueryKey) => boolean;
};
export type MutationHandle = { readonly id: string; readonly requestKey: string; readonly settled: Promise<MutationRecord> };

type Internal = {
  record: MutationRecord;
  readonly spec: MutationSpec<unknown>;
  input: WriteInput | undefined;
  controller: AbortController | undefined;
  rollback: Rollback | undefined;
  settle: (record: MutationRecord) => void;
};

const PENDING: readonly MutationStatus[] = ["queued", "running"];
const NOT_RETRYABLE = new Set([
  "invalid-input",
  "input-too-large",
  "request-key-required",
  "request-key-conflict",
  "operation-unavailable",
  "workspace-unavailable",
  "invalid-operation-input",
  "body-too-large",
  "workspace-not-granted",
  "job-stack-scope-not-granted",
  "job-stack-grant-inactive",
  "operation-denied",
]);
/**
 * Rejected before processing (elevation, nonce) or of unknown outcome (invalid or missing response):
 * resending the identical request with the same key is safe and may succeed.
 */
const RETRY_SAME_KEY = new Set(["write-elevation-required", "invalid-owner-request", "invalid-product-response", "invalid-response", "network"]);

/** Retrying is only offered when resending the identical request could produce a different outcome. */
export function retryableFailure(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.code && NOT_RETRYABLE.has(error.code)) return false;
  if (error.code && RETRY_SAME_KEY.has(error.code)) return true;
  if (error.status === null) return true;
  return error.status >= 500 || error.status === 408 || error.status === 429;
}

export type MutationDependencies = {
  readonly cache: QueryCache;
  readonly workspaceId: () => string | null;
  readonly send: (operation: WriteOperation, input: WriteInput, signal: AbortSignal) => Promise<DomainWriteOutput>;
  readonly requestKey?: () => string;
  readonly now?: () => number;
  readonly onAuthorityLoss?: (error: unknown) => void;
  readonly historyLimit?: number;
};

/**
 * Write orchestration with optimistic updates. Each intent owns one request key that every retry
 * reuses; mutations on one entity are serialized; authority loss cancels everything pending.
 */
export class MutationClient {
  readonly #deps: MutationDependencies;
  readonly #items = new Map<string, Internal>();
  readonly #tails = new Map<string, Promise<void>>();
  readonly #listeners = new Set<() => void>();
  #snapshot: readonly MutationRecord[] = [];
  #sequence = 0;
  #disposed = false;

  constructor(deps: MutationDependencies) {
    this.#deps = deps;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Newest first; a stable array between changes (suitable for useSyncExternalStore). */
  readonly list = (): readonly MutationRecord[] => this.#snapshot;

  get(id: string): MutationRecord | undefined {
    return this.#items.get(id)?.record;
  }

  pendingCount(): number {
    return this.#snapshot.filter((record) => PENDING.includes(record.status)).length;
  }

  start<V>(spec: MutationSpec<V>): MutationHandle {
    const requestKey = createRequestKey(this.#deps.requestKey);
    const id = "m" + ++this.#sequence;
    let settle!: (record: MutationRecord) => void;
    const settled = new Promise<MutationRecord>((resolve) => (settle = resolve));
    const internal: Internal = {
      record: Object.freeze({
        id,
        requestKey,
        operation: spec.operation,
        entity: spec.entity,
        label: spec.label,
        status: "queued",
        error: undefined,
        result: undefined,
        createdAt: this.#now(),
        settledAt: null,
        attempts: 0,
        retryable: false,
        cancelReason: null,
      }),
      spec: spec as MutationSpec<unknown>,
      input: undefined,
      controller: undefined,
      rollback: undefined,
      settle,
    };
    this.#items.set(id, internal);
    if (this.#disposed) {
      this.#update(internal, { status: "cancelled", settledAt: this.#now(), cancelReason: "Workspace closed" });
      settle(internal.record);
      return { id, requestKey, settled };
    }
    this.#apply(internal);
    this.#publish();
    this.#schedule(internal);
    return { id, requestKey, settled };
  }

  /** Resends a failed intent with the same request key and the same body. */
  retry(id: string): MutationHandle | null {
    const internal = this.#items.get(id);
    if (!internal || this.#disposed || internal.record.status !== "error" || !internal.record.retryable) return null;
    let settle!: (record: MutationRecord) => void;
    const settled = new Promise<MutationRecord>((resolve) => (settle = resolve));
    internal.settle = settle;
    this.#update(internal, { status: "queued", error: undefined, settledAt: null, retryable: false });
    this.#apply(internal);
    this.#schedule(internal);
    return { id, requestKey: internal.record.requestKey, settled };
  }

  /** Cancels queued and running mutations, aborts their requests and rolls back optimistic data. */
  cancelAll(reason = "Workspace authority ended"): number {
    let cancelled = 0;
    // Newest first, so stacked optimistic values unwind back to the original data.
    for (const internal of [...this.#items.values()].reverse()) {
      if (!PENDING.includes(internal.record.status)) continue;
      cancelled++;
      internal.controller?.abort();
      this.#rollback(internal);
      this.#update(internal, { status: "cancelled", settledAt: this.#now(), cancelReason: reason });
      internal.settle(internal.record);
    }
    return cancelled;
  }

  dispose(reason = "Workspace closed"): number {
    const cancelled = this.cancelAll(reason);
    this.#disposed = true;
    return cancelled;
  }

  #schedule(internal: Internal) {
    const entity = internal.spec.entity;
    const previous = this.#tails.get(entity) ?? Promise.resolve();
    const tail = previous.then(() => this.#execute(internal)).then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(entity, tail);
    void tail.then(() => {
      if (this.#tails.get(entity) === tail) this.#tails.delete(entity);
    });
  }

  async #execute(internal: Internal) {
    if (internal.record.status !== "queued" || this.#disposed) return;
    const { spec } = internal;
    const context = { requestKey: internal.record.requestKey, mutationId: internal.record.id, at: this.#now() };
    if (!internal.input) {
      const workspaceId = this.#deps.workspaceId();
      try {
        if (!workspaceId) throw new ApiError("Workspace identity unavailable", null, "workspace-unavailable");
        internal.input = {
          workspaceId,
          requestKey: internal.record.requestKey,
          body: spec.body(spec.values, this.#deps.cache),
        };
      } catch (error) {
        this.#fail(internal, error);
        return;
      }
    }
    const controller = new AbortController();
    internal.controller = controller;
    this.#update(internal, { status: "running", attempts: internal.record.attempts + 1 });
    try {
      const result = await this.#deps.send(spec.operation, internal.input, controller.signal);
      if ((internal.record.status as MutationStatus) !== "running" || controller.signal.aborted) return;
      internal.rollback = undefined;
      this.#update(internal, { status: "success", result, settledAt: this.#now() });
      spec.reconcile?.(this.#deps.cache, result, spec.values, context);
      if (spec.invalidate) this.#deps.cache.invalidate(spec.invalidate);
      internal.settle(internal.record);
    } catch (error) {
      if ((internal.record.status as MutationStatus) !== "running" || (controller.signal.aborted && isAbort(error))) return;
      this.#fail(internal, error);
      if (isAuthorityLoss(error)) this.#deps.onAuthorityLoss?.(error);
    } finally {
      if (internal.controller === controller) internal.controller = undefined;
    }
  }

  #fail(internal: Internal, error: unknown) {
    this.#rollback(internal);
    this.#update(internal, {
      status: "error",
      error,
      settledAt: this.#now(),
      retryable: internal.input !== undefined && retryableFailure(error),
    });
    if (internal.spec.invalidate) this.#deps.cache.invalidate(internal.spec.invalidate);
    internal.settle(internal.record);
  }

  #apply(internal: Internal) {
    const context = { requestKey: internal.record.requestKey, mutationId: internal.record.id, at: this.#now() };
    internal.rollback = internal.spec.optimistic?.(this.#deps.cache, internal.spec.values, context) ?? undefined;
  }

  #rollback(internal: Internal) {
    const rollback = internal.rollback;
    internal.rollback = undefined;
    rollback?.();
  }

  #update(internal: Internal, patch: Partial<MutationRecord>) {
    internal.record = Object.freeze({ ...internal.record, ...patch });
    this.#publish();
  }

  #publish() {
    const limit = this.#deps.historyLimit ?? 50;
    const all = [...this.#items.values()].reverse();
    let kept = 0;
    for (const internal of all) {
      if (PENDING.includes(internal.record.status) || internal.record.status === "error") continue;
      if (++kept > limit) this.#items.delete(internal.record.id);
    }
    this.#snapshot = Object.freeze([...this.#items.values()].map((internal) => internal.record).reverse());
    for (const listener of [...this.#listeners]) listener();
  }

  #now() {
    return (this.#deps.now ?? Date.now)();
  }
}

/**
 * Optimistically replaces one cached query value. The rollback restores the previous value only if
 * the cache still holds the optimistic value; newer server data is never overwritten.
 */
export function patchQuery<T>(cache: QueryCache, key: QueryKey, update: (current: T) => T): Rollback {
  const previous = cache.peek<T>(key);
  if (previous === undefined) return () => {};
  const applied = update(previous);
  cache.setData<T>(key, () => applied);
  return () => {
    if (cache.peek<T>(key) === applied) cache.setData<T>(key, () => previous);
  };
}

export function combine(...rollbacks: (Rollback | void)[]): Rollback {
  return () => {
    for (const rollback of [...rollbacks].reverse()) rollback?.();
  };
}
