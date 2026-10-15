import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  isAuthorityLoss,
  mutate,
  needsElevation,
  type DomainWriteOutput,
  type ReadRecord,
  type WriteInput,
  type WriteOperation,
} from "../dashboard/lib/api";
import { MutationClient, patchQuery, retryableFailure, type MutationSpec } from "../dashboard/lib/mutations";
import { keys } from "../dashboard/lib/queries";
import { QueryCache } from "../dashboard/lib/queryCache";
import { createRequestKey, IntentTracker } from "../dashboard/lib/requestKeys";
import { transitionSpec, captureSpec } from "../dashboard/features/opportunities/specs";

afterEach(() => vi.unstubAllGlobals());

const save = {
  versionId: "version_1",
  transactionId: "transaction_1",
  digest: "a".repeat(64),
  statusUrl: "/versions/version_1/protection",
  status: "saved_primary",
  protection: "protection_pending",
} as const;
const output = (entityId: string, revision: string): DomainWriteOutput => ({ entityId, revision, save });
function held<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

function opportunity(state: string, revision = "3"): ReadRecord {
  return {
    origin: "domain_record",
    history: "legacy_unversioned",
    kind: "opportunity",
    entityId: "opp_1",
    revision,
    updatedAt: 1,
    body: { company: "Synthetic", role: "Role", state },
    bodyStatus: "available",
    provenance: null,
  };
}
function client(send: (operation: WriteOperation, input: WriteInput, signal: AbortSignal) => Promise<DomainWriteOutput>, extra: Partial<ConstructorParameters<typeof MutationClient>[0]> = {}) {
  const cache = new QueryCache();
  let n = 0;
  const mutations = new MutationClient({
    cache,
    workspaceId: () => "workspace_1",
    send,
    requestKey: () => "key-" + ++n,
    ...extra,
  });
  return { cache, mutations };
}
const state = (cache: QueryCache) => (cache.peek<ReadRecord>(keys.record("opportunity", "opp_1"))?.body as { state: string }).state;

describe("mutation client", () => {
  it("applies the optimistic change immediately and lets the server revision win on success", async () => {
    const gate = held<DomainWriteOutput>();
    const send = vi.fn(() => gate.promise);
    const { cache, mutations } = client(send);
    cache.setData(keys.record("opportunity", "opp_1"), () => opportunity("qualified"));
    const handle = mutations.start(transitionSpec({ id: "opp_1", revision: 3, state: "packet_ready", evidence: "Ready", confirmed: false }));
    expect(state(cache)).toBe("packet_ready");
    expect(mutations.get(handle.id)?.status).toBe("queued");
    await settle();
    expect(send).toHaveBeenCalledWith(
      "job_stack_transition_opportunity",
      { workspaceId: "workspace_1", requestKey: "key-1", body: { id: "opp_1", revision: 3, state: "packet_ready", evidence: "Ready", confirmed: false } },
      expect.any(AbortSignal),
    );
    gate.resolve(output("opp_1", "4"));
    const record = await handle.settled;
    expect(record.status).toBe("success");
    expect(cache.peek<ReadRecord>(keys.record("opportunity", "opp_1"))?.revision).toBe("4");
    expect(cache.snapshot(keys.record("opportunity", "opp_1")).stale).toBe(true);
  });

  it("rolls the optimistic change back when the write fails", async () => {
    const { cache, mutations } = client(async () => {
      throw new ApiError("The record changed since it was loaded. Reload it and try again.", 409, null);
    });
    cache.setData(keys.record("opportunity", "opp_1"), () => opportunity("qualified"));
    const handle = mutations.start(transitionSpec({ id: "opp_1", revision: 3, state: "blocked", evidence: "Hold", confirmed: false }));
    expect(state(cache)).toBe("blocked");
    const record = await handle.settled;
    expect(record.status).toBe("error");
    expect(record.retryable).toBe(false);
    expect(state(cache)).toBe("qualified");
  });

  it("never overwrites newer server data during rollback", () => {
    const cache = new QueryCache();
    cache.setData(["k"], () => "server-1");
    const rollback = patchQuery<string>(cache, ["k"], () => "optimistic");
    cache.setData(["k"], () => "server-2");
    rollback();
    expect(cache.peek(["k"])).toBe("server-2");
  });

  it("serializes writes on one entity and uses the newest reconciled revision for the queued one", async () => {
    const gates = [held<DomainWriteOutput>(), held<DomainWriteOutput>()];
    const sent: WriteInput[] = [];
    const { cache, mutations } = client((_op, input) => {
      sent.push(input);
      return gates[sent.length - 1]?.promise ?? Promise.reject(Error("unexpected"));
    });
    cache.setData(keys.record("opportunity", "opp_1"), () => opportunity("qualified", "3"));
    const first = mutations.start(transitionSpec({ id: "opp_1", revision: 3, state: "packet_ready", evidence: "a", confirmed: false }));
    const second = mutations.start(transitionSpec({ id: "opp_1", revision: 3, state: "submitted", evidence: "b", confirmed: false }));
    await settle();
    expect(sent).toHaveLength(1);
    expect(state(cache)).toBe("submitted");
    gates[0]?.resolve(output("opp_1", "4"));
    await first.settled;
    await settle();
    expect(sent).toHaveLength(2);
    expect((sent[1]?.body as { revision: number }).revision).toBe(4);
    gates[1]?.resolve(output("opp_1", "5"));
    expect((await second.settled).status).toBe("success");
  });

  it("runs writes on different entities concurrently", async () => {
    const gate = held<DomainWriteOutput>();
    const send = vi.fn(() => gate.promise);
    const { mutations } = client(send);
    const spec = (entity: string): MutationSpec<object> => ({ operation: "job_stack_prepare_interview", entity, label: entity, values: {}, body: () => ({ interviewId: entity }) });
    mutations.start(spec("a"));
    mutations.start(spec("b"));
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    gate.resolve(output("x", "1"));
  });

  it("retries an ambiguous failure with the same request key and the same body", async () => {
    const inputs: WriteInput[] = [];
    let fail = true;
    const { cache, mutations } = client(async (_op, input) => {
      inputs.push(input);
      if (fail) throw new ApiError("Outcome unknown.", null, "network");
      return output("opp_1", "4");
    });
    cache.setData(keys.record("opportunity", "opp_1"), () => opportunity("qualified"));
    const handle = mutations.start(transitionSpec({ id: "opp_1", revision: 3, state: "packet_ready", evidence: "x", confirmed: false }));
    const failed = await handle.settled;
    expect(failed).toMatchObject({ status: "error", retryable: true });
    expect(state(cache)).toBe("qualified");
    cache.setData(keys.record("opportunity", "opp_1"), () => opportunity("qualified", "9"));
    fail = false;
    const retry = mutations.retry(handle.id);
    expect(retry?.requestKey).toBe(handle.requestKey);
    expect(state(cache)).toBe("packet_ready");
    expect((await retry?.settled)?.status).toBe("success");
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toEqual(inputs[0]);
    expect(mutations.retry(handle.id)).toBeNull();
  });

  it("cancels running and queued writes on authority loss, rolls back and ignores late success", async () => {
    const gate = held<DomainWriteOutput>();
    const { cache, mutations } = client(() => gate.promise);
    cache.setData(keys.record("opportunity", "opp_1"), () => opportunity("qualified"));
    const running = mutations.start(transitionSpec({ id: "opp_1", revision: 3, state: "packet_ready", evidence: "a", confirmed: false }));
    const queued = mutations.start(transitionSpec({ id: "opp_1", revision: 3, state: "blocked", evidence: "b", confirmed: false }));
    await settle();
    expect(mutations.cancelAll()).toBe(2);
    expect(state(cache)).toBe("qualified");
    gate.resolve(output("opp_1", "4"));
    expect((await running.settled).status).toBe("cancelled");
    expect((await queued.settled).status).toBe("cancelled");
    expect(cache.peek<ReadRecord>(keys.record("opportunity", "opp_1"))?.revision).toBe("3");
  });

  it("reports 401/403 authority loss but not hardware-key elevation", async () => {
    const onAuthorityLoss = vi.fn();
    const errors = [new ApiError("x", 403, "write-elevation-required"), new ApiError("x", 403, "operation-denied")];
    const { mutations } = client(async () => {
      throw errors.shift();
    }, { onAuthorityLoss });
    const spec: MutationSpec<object> = { operation: "job_stack_prepare_interview", entity: "i", label: "i", values: {}, body: () => ({ interviewId: "i" }) };
    const elevation = await mutations.start(spec).settled;
    expect(elevation).toMatchObject({ status: "error", retryable: true });
    expect(onAuthorityLoss).not.toHaveBeenCalled();
    await mutations.start(spec).settled;
    expect(onAuthorityLoss).toHaveBeenCalledTimes(1);
  });

  it("replaces a provisional created row with the server's entity id", async () => {
    const { cache, mutations } = client(async () => output("server_id", "1"));
    cache.setData(keys.records("opportunity", null), () => ({ items: [], nextCursor: null }));
    const terms = { employment: "full_time" as const, baseUsd: null, hourlyUsd: null, remote: null, match401k: null, zeroPremium: null, affordableCare: null };
    const handle = mutations.start(captureSpec({ company: "C", role: "R", sourceUrl: "https://example.invalid/job", description: "D", terms }));
    const page = () => cache.peek<{ items: { entityId: string }[] }>(keys.records("opportunity", null));
    expect(page()?.items.map((i) => i.entityId)).toEqual(["pending-" + handle.requestKey]);
    await handle.settled;
    expect(page()?.items.map((i) => i.entityId)).toEqual(["server_id"]);
    expect(cache.peek<ReadRecord>(keys.record("opportunity", "server_id"))?.revision).toBe("1");
  });

  it("fails closed without a workspace identity and never sends", async () => {
    const send = vi.fn();
    const { mutations } = client(send, { workspaceId: () => null });
    const record = await mutations.start({ operation: "job_stack_prepare_interview", entity: "i", label: "i", values: {}, body: () => ({ interviewId: "i" }) }).settled;
    expect(record.status).toBe("error");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("request keys and intents", () => {
  it("creates catalog-valid keys and rejects invalid ones", () => {
    expect(createRequestKey()).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
    expect(() => createRequestKey(() => "bad key")).toThrow();
  });
  it("retries identical values of one intent and starts a new intent for changed values", () => {
    const tracker = new IntentTracker();
    expect(tracker.decide({ a: 1 }, () => true)).toEqual({ kind: "start" });
    tracker.remember({ a: 1, b: [1] }, "m1");
    expect(tracker.decide({ b: [1], a: 1 }, () => true)).toEqual({ kind: "retry", mutationId: "m1" });
    expect(tracker.decide({ a: 2, b: [1] }, () => true)).toEqual({ kind: "start" });
    expect(tracker.decide({ a: 1, b: [1] }, () => false)).toEqual({ kind: "start" });
  });
  it("classifies retryability and authority loss", () => {
    expect(retryableFailure(new ApiError("x", null, "network"))).toBe(true);
    expect(retryableFailure(new ApiError("x", 503, "job-stack-unavailable"))).toBe(true);
    expect(retryableFailure(new ApiError("x", 502, "invalid-product-response"))).toBe(true);
    expect(retryableFailure(new ApiError("x", 409, "request-key-conflict"))).toBe(false);
    expect(retryableFailure(new ApiError("x", 400, "invalid-operation-input"))).toBe(false);
    expect(retryableFailure(new ApiError("x", 413, "body-too-large"))).toBe(false);
    expect(retryableFailure(new ApiError("x", 501, "operation-unavailable"))).toBe(false);
    expect(isAuthorityLoss(new ApiError("x", 401, null))).toBe(true);
    for (const code of ["operation-denied", "job-stack-grant-inactive", "job-stack-scope-not-granted", "workspace-not-granted", null])
      expect(isAuthorityLoss(new ApiError("x", 403, code))).toBe(true);
    expect(isAuthorityLoss(new ApiError("x", 403, "write-elevation-required"))).toBe(false);
    expect(needsElevation(new ApiError("x", 403, "write-elevation-required"))).toBe(true);
    expect(isAuthorityLoss(new ApiError("x", 403, "invalid-owner-request"))).toBe(false);
  });
});

describe("mutate transport (Control write contract)", () => {
  const input = {
    workspaceId: "workspace_1",
    requestKey: "11111111-2222-3333-4444-555555555555",
    body: { interviewId: "interview_1" },
  };
  const ok = () => Response.json(output("interview_1", "2"));
  const nonce = (value: string) => Response.json({ nonce: value });

  it("binds a fresh nonce to POST and the query-free target, then posts JSON with grant only", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(nonce("n1")).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetcher);
    expect(await mutate("job_stack_prepare_interview", input, { grantId: "grant 1" })).toEqual(output("interview_1", "2"));
    const nonceUrl = new URL(String(fetcher.mock.calls[0]?.[0]), "https://local.invalid");
    expect(nonceUrl.pathname).toBe("/owner/job-stack/api/nonce");
    expect(Object.fromEntries(nonceUrl.searchParams)).toEqual({
      grant: "grant 1",
      method: "POST",
      target: "/owner/job-stack/api/operations/job_stack_prepare_interview",
    });
    const postUrl = new URL(String(fetcher.mock.calls[1]?.[0]), "https://local.invalid");
    expect(postUrl.pathname).toBe("/owner/job-stack/api/operations/job_stack_prepare_interview");
    expect(Object.fromEntries(postUrl.searchParams)).toEqual({ grant: "grant 1" });
    const init = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(init).toMatchObject({ method: "POST", cache: "no-store", headers: { "content-type": "application/json", "x-owner-nonce": "n1" } });
    expect(JSON.parse(new TextDecoder().decode(init.body as Uint8Array))).toEqual(input);
  });

  it("retries a rejected nonce once with a fresh nonce and the same request key, then surfaces the error", async () => {
    const denied = () => Response.json({ error: "invalid-owner-request" }, { status: 403 });
    const fetcher = vi.fn().mockResolvedValueOnce(nonce("n1")).mockResolvedValueOnce(denied()).mockResolvedValueOnce(nonce("n2")).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetcher);
    await mutate("job_stack_prepare_interview", input, { grantId: "g" });
    expect((fetcher.mock.calls[3]?.[1] as RequestInit).headers).toMatchObject({ "x-owner-nonce": "n2" });
    expect((fetcher.mock.calls[3]?.[1] as RequestInit).body).toEqual((fetcher.mock.calls[1]?.[1] as RequestInit).body);
    fetcher.mockReset();
    fetcher.mockResolvedValueOnce(nonce("a")).mockResolvedValueOnce(denied()).mockResolvedValueOnce(nonce("b")).mockResolvedValueOnce(denied());
    const error = await mutate("job_stack_prepare_interview", input, { grantId: "g" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 403, code: "invalid-owner-request" });
    expect(isAuthorityLoss(error)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("maps every documented Control error to a specific, non-echoing error", async () => {
    const cases: [number, string, string][] = [
      [403, "write-elevation-required", "Confirm with your security key"],
      [403, "workspace-not-granted", "does not cover the selected workspace"],
      [409, "request-key-conflict", "already used for a different change"],
      [501, "operation-unavailable", "not enabled on the server"],
      [400, "invalid-operation-input", "invalid for the operation"],
      [413, "body-too-large", "64 KiB"],
      [502, "invalid-product-response", "outcome is unknown"],
      [503, "job-stack-unavailable", "unavailable"],
    ];
    for (const [status, code, text] of cases) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(nonce("n")).mockResolvedValueOnce(Response.json({ error: code, secret: "PRIVATE" }, { status })));
      const error = (await mutate("job_stack_prepare_interview", input, { grantId: "g" }).catch((e: unknown) => e)) as ApiError;
      expect(error).toBeInstanceOf(ApiError);
      expect(error.code).toBe(code);
      expect(error.message).toContain(text);
      expect(error.message).not.toContain("PRIVATE");
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(nonce("n")).mockResolvedValueOnce(new Response("x", { status: 415 })));
    await expect(mutate("job_stack_prepare_interview", input, { grantId: "g" })).rejects.toThrow("request format");
  });

  it("refuses non-write operations, missing request keys, undeclared fields and oversized bodies before any fetch", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(mutate("job_stack_records", input, { grantId: "g" })).rejects.toThrow("unavailable");
    await expect(mutate("job_stack_send_reply", input, { grantId: "g" })).rejects.toThrow("unavailable");
    await expect(mutate("job_stack_prepare_interview", { ...input, requestKey: "" }, { grantId: "g" })).rejects.toMatchObject({ code: "request-key-required" });
    await expect(mutate("job_stack_prepare_interview", { ...input, body: { interviewId: "i", extra: true } }, { grantId: "g" })).rejects.toMatchObject({ code: "invalid-input" });
    // Schema-valid (20 000 characters per field) but 80 000 UTF-8 bytes: over Control's 64 KiB body limit.
    const huge = { ...input, body: { questionId: "q", value: "é".repeat(20_000), reason: "é".repeat(20_000) } };
    await expect(mutate("job_stack_resolve_profile_conflict", huge, { grantId: "g" })).rejects.toMatchObject({ code: "input-too-large" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("treats a 200 whose body fails the catalog output schema as an unknown outcome", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(nonce("n")).mockResolvedValueOnce(Response.json({ entityId: "x" })));
    const error = await mutate("job_stack_prepare_interview", input, { grantId: "g" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid-product-response" });
    expect(retryableFailure(error)).toBe(true);
  });

  it("bounds the write response to the operation output limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4096).fill(32));
      },
    }, { highWaterMark: 0 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(nonce("n")).mockResolvedValueOnce(new Response(stream)));
    await expect(mutate("job_stack_prepare_interview", input, { grantId: "g" })).rejects.toThrow("exceeds the read size limit");
  });
});
