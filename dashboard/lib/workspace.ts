import {
  createReadClient,
  isAuthorityLoss,
  mutate,
  type DomainWriteOutput,
  type ReadClient,
  type ReadSession,
  type WriteInput,
  type WriteOperation,
} from "./api";
import { MutationClient } from "./mutations";
import { keys, type ReadQuery } from "./queries";
import { QueryCache, type QueryDefinition } from "./queryCache";
import { createRequestKey } from "./requestKeys";

/** Capabilities supplied at the application boundary (replaced by fakes in tests). */
export type Services = {
  readonly readClient: (grantId: string, signal: AbortSignal) => ReadClient;
  readonly write: (
    grantId: string,
    operation: WriteOperation,
    input: WriteInput,
    signal: AbortSignal,
  ) => Promise<DomainWriteOutput>;
  readonly now: () => number;
  readonly requestKey: () => string;
};

export const browserServices: Services = {
  readClient: createReadClient,
  write: (grantId, operation, input, signal) => mutate(operation, input, { grantId, signal }),
  now: () => Date.now(),
  requestKey: () => createRequestKey(),
};

export const GRANT_REQUIRED = "Select an existing workspace grant to view observations.";
export const GRANT_EXPIRED = "Workspace grant expired. Select a current grant.";

export type Authority =
  | { readonly status: "active" }
  | { readonly status: "lost"; readonly message: string; readonly cancelled: number };
const ACTIVE: Authority = Object.freeze({ status: "active" });

/**
 * Everything that belongs to one selected grant: its query cache, its mutation client and its
 * authority state. A grant change disposes the whole workspace; nothing crosses grants.
 */
export class Workspace {
  readonly grant: string;
  readonly services: Services;
  readonly cache: QueryCache;
  readonly mutations: MutationClient;
  #authority: Authority = ACTIVE;
  readonly #listeners = new Set<() => void>();

  constructor(grant: string, services: Services) {
    this.grant = grant;
    this.services = services;
    this.cache = new QueryCache({
      now: services.now,
      onError: (error) => {
        if (isAuthorityLoss(error)) this.loseAuthority(error instanceof Error ? error.message : GRANT_REQUIRED);
      },
    });
    this.mutations = new MutationClient({
      cache: this.cache,
      workspaceId: () => this.workspaceId,
      send: (operation, input, signal) => services.write(grant, operation, input, signal),
      requestKey: services.requestKey,
      now: services.now,
      onAuthorityLoss: (error) => this.loseAuthority(error instanceof Error ? error.message : GRANT_REQUIRED),
    });
  }

  get session(): ReadSession | undefined {
    return this.cache.peek<ReadSession>(keys.session());
  }

  /** The selected workspace from the current session; writes are refused without it. */
  get workspaceId(): string | null {
    return this.session?.resources?.[0]?.id ?? null;
  }

  /** Whether the current session grants the scope of a catalog operation (e.g. job-stack.claim.add). */
  allows(scope: string): boolean {
    return this.session?.scopes?.includes(scope) ?? false;
  }

  read<T>(query: ReadQuery<T>): QueryDefinition<T> {
    return {
      key: query.key,
      staleMs: query.staleMs,
      fetch: (signal) => query.run(this.services.readClient(this.grant, signal)),
    };
  }

  readonly authority = (): Authority => this.#authority;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Clears all reads, cancels every pending mutation and records why access ended. */
  loseAuthority(message: string): void {
    const cancelled = this.mutations.cancelAll("Workspace authority ended");
    this.cache.clear();
    const previous = this.#authority.status === "lost" ? this.#authority.cancelled : 0;
    this.#authority = Object.freeze({ status: "lost", message, cancelled: previous + cancelled });
    this.#emit();
  }

  /** A distinct navigation or explicit refresh tries the selected grant again. */
  restore(): void {
    if (this.#authority.status === "active") return;
    this.#authority = ACTIVE;
    this.#emit();
  }

  /** Explicit refresh: forget every cached read (pending writes continue) and re-check authority. */
  refresh(): void {
    this.cache.clear();
    this.restore();
  }

  dispose(): void {
    this.mutations.dispose("Workspace grant changed");
    this.cache.clear();
  }

  #emit() {
    for (const listener of [...this.#listeners]) listener();
  }
}

/** Holds the single live workspace of an application instance. */
export class WorkspaceStore {
  readonly #services: Services;
  #current: Workspace | null = null;

  constructor(services: Services) {
    this.#services = services;
  }

  forGrant(grant: string): Workspace {
    if (this.#current?.grant !== grant) {
      this.#current?.dispose();
      this.#current = new Workspace(grant, this.#services);
    }
    return this.#current;
  }
}
