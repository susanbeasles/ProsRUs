import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../dashboard/lib/api";
import { QueryCache, type QueryDefinition } from "../dashboard/lib/queryCache";

function held<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("query cache", () => {
  it("shares one in-flight fetch between concurrent requests for a key", async () => {
    const cache = new QueryCache();
    const gate = held<string>();
    const fetch = vi.fn(() => gate.promise);
    const def: QueryDefinition<string> = { key: ["k"], fetch };
    cache.ensure(def);
    cache.ensure(def);
    const shared = cache.fetch(def);
    expect(fetch).toHaveBeenCalledTimes(1);
    gate.resolve("value");
    expect(await shared).toBe("value");
    expect(cache.snapshot(["k"])).toMatchObject({ status: "success", data: "value", isFetching: false });
  });

  it("keeps stale data visible while revalidating (stale-while-revalidate)", async () => {
    let now = 1000;
    const cache = new QueryCache({ now: () => now });
    let value = "first";
    const gate = held<void>();
    const def: QueryDefinition<string> = {
      key: ["k"],
      staleMs: 100,
      fetch: async () => {
        if (value === "second") await gate.promise;
        return value;
      },
    };
    await cache.fetch(def);
    now += 50;
    value = "second";
    cache.ensure(def);
    expect(cache.snapshot(["k"]).isFetching).toBe(false);
    now += 100;
    cache.ensure(def);
    expect(cache.snapshot(["k"])).toMatchObject({ data: "first", isFetching: true, status: "success" });
    gate.resolve();
    await tick();
    expect(cache.snapshot(["k"])).toMatchObject({ data: "second", isFetching: false, stale: false });
  });

  it("drops a response that arrives after a navigation even if the transport ignores abort", async () => {
    const cache = new QueryCache();
    const gate = held<string>();
    const signals: AbortSignal[] = [];
    const def: QueryDefinition<string> = {
      key: ["record", "a"],
      fetch: (signal) => {
        signals.push(signal);
        return gate.promise; // never observes the signal
      },
    };
    const pending = cache.fetch(def);
    const generation = cache.generation;
    cache.beginNavigation();
    expect(signals[0]?.aborted).toBe(true);
    expect(cache.generation).toBe(generation + 1);
    gate.resolve("late");
    expect(await pending).toBeUndefined();
    expect(cache.snapshot(["record", "a"]).data).toBeUndefined();
    expect(cache.snapshot(["record", "a"]).status).toBe("idle");
  });

  it("keeps completed data for exact keys across navigation and marks aborted entries for refetch", async () => {
    const cache = new QueryCache();
    await cache.fetch({ key: ["done"], fetch: async () => 1 });
    const gate = held<number>();
    void cache.fetch({ key: ["busy"], fetch: () => gate.promise });
    cache.beginNavigation();
    expect(cache.snapshot(["done"]).data).toBe(1);
    expect(cache.snapshot(["busy"])).toMatchObject({ status: "idle", stale: true, isFetching: false });
  });

  it("invalidation aborts the matching in-flight read so a pre-mutation response cannot overwrite newer data", async () => {
    const cache = new QueryCache();
    const gate = held<string>();
    let aborted = false;
    const pending = cache.fetch({
      key: ["record", "x"],
      fetch: (signal) => {
        signal.addEventListener("abort", () => (aborted = true));
        return gate.promise;
      },
    });
    cache.setData<string>(["record", "x"], () => "optimistic");
    cache.invalidate((key) => key[0] === "record");
    expect(aborted).toBe(true);
    gate.resolve("stale server state");
    expect(await pending).toBeUndefined();
    expect(cache.peek(["record", "x"])).toBe("optimistic");
    expect(cache.snapshot(["record", "x"]).stale).toBe(true);
  });

  it("clear() forgets data, aborts everything and drops late responses", async () => {
    const cache = new QueryCache();
    await cache.fetch({ key: ["a"], fetch: async () => "a" });
    const gate = held<string>();
    const pending = cache.fetch({ key: ["b"], fetch: () => gate.promise });
    const listener = vi.fn();
    cache.subscribe(["a"], listener);
    cache.clear();
    expect(listener).toHaveBeenCalled();
    expect(cache.peek(["a"])).toBeUndefined();
    gate.resolve("b");
    expect(await pending).toBeUndefined();
    expect(cache.keys()).toEqual([]);
  });

  it("records errors without retry loops and reports them to the authority hook", async () => {
    const onError = vi.fn();
    const cache = new QueryCache({ onError });
    const fetch = vi.fn(async () => {
      throw new ApiError("denied", 403, "operation-denied");
    });
    const def: QueryDefinition<never> = { key: ["e"], fetch };
    await cache.fetch(def);
    cache.ensure(def);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.snapshot(["e"]).status).toBe("error");
    expect(onError).toHaveBeenCalledWith(expect.any(ApiError), ["e"]);
  });

  it("returns a stable snapshot object until the entry changes", async () => {
    const cache = new QueryCache();
    await cache.fetch({ key: ["s"], fetch: async () => 1 });
    const first = cache.snapshot(["s"]);
    expect(cache.snapshot(["s"])).toBe(first);
    cache.setData<number>(["s"], () => 2);
    expect(cache.snapshot(["s"])).not.toBe(first);
  });
});
