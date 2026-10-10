import { describe, expect, it, vi } from "vitest";
import { createService } from "../src/application/service";
import { createActions } from "../src/jobs/actions";
import { handleAuthorized } from "../src/protocol/http";
import type { Dependencies } from "../src/application/service";
import type { Store } from "../src/storage/store";
import type { Environment } from "../src/environment";
const actor = {
  id: "owner_1",
  kind: "user" as const,
  scopes: ["read", "write", "send", "schedule"],
  expiresAt: Date.now() + 60000,
};
describe("read-first closure, synthetic dependencies only", () => {
  function fixture() {
    const effect = vi.fn(() => {
      throw Error("unexpected-effect");
    });
    const store = new Proxy({}, { get: () => effect }) as Store;
    return {
      effect,
      deps: {
        store,
        owner: "owner_1",
        now: () => Date.now(),
        artifacts: {} as R2Bucket,
        enqueue: effect,
        google: effect,
      } satisfies Dependencies,
    };
  }
  it("legacy service mutation denies before storage/provider/reservation", async () => {
    const { effect, deps } = fixture();
    await expect(
      createService(deps).invoke(actor, "capture_opportunity", {}),
    ).rejects.toThrow("operation-unavailable");
    expect(effect).not.toHaveBeenCalled();
  });
  it("legacy executor denies before reading or claiming restored intents", async () => {
    const { effect, deps } = fixture();
    await expect(
      createActions({ ...deps, settings: effect }).perform("restored-intent"),
    ).rejects.toThrow("operation-unavailable");
    expect(effect).not.toHaveBeenCalled();
  });
  it("legacy broad HTTP cannot route Principal authority", async () => {
    const env = new Proxy(
      {},
      {
        get: () => {
          throw Error("unexpected-env-access");
        },
      },
    ) as Environment;
    const response = await handleAuthorized(
      new Request("https://local.invalid/owner/job-stack/api/snapshot"),
      env,
      actor,
    );
    expect(response.status).toBe(404);
  });
});
