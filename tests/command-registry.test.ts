import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  coreOperations,
  operationById,
} from "../integration/shared-contract.mjs";
import {
  COMMAND_REGISTRY,
  EXTERNAL_EFFECTS,
  commandFor,
  denyLegacyOperation,
  legacyAvailability,
  registryCoverage,
} from "../src/application/commands/registry";
import { publicFailure } from "../src/application/commands/execute";
import { createSerialQueue } from "../src/application/commands/serial";
import { DomainError } from "../src/domain/model";
import { commandHarness } from "./fixtures/command-harness";

describe("finite command registry", () => {
  it("decides availability for exactly the non-read catalog operations", () => {
    const { commands, registered } = registryCoverage();
    expect(registered).toEqual(commands);
    expect(commands).toHaveLength(20);
    for (const operation of coreOperations.filter((o) => o.effect === "read"))
      expect(() => commandFor(operation.id)).toThrow("operation-unavailable");
  });
  it("routes all fourteen domain local-writes, unavailable ones with a reason", () => {
    const domain = coreOperations.filter((o) => o.domainOperation !== null);
    expect(domain).toHaveLength(14);
    for (const operation of domain) {
      const decision =
        COMMAND_REGISTRY[operation.id as keyof typeof COMMAND_REGISTRY];
      if (decision.state === "available")
        expect(commandFor(operation.id)).toMatchObject({
          kind: "domain",
          effect: "local-write",
          ownerOnly: operation.ownerOnly,
        });
      else expect(decision.reason).toBe("claim-permission-resolver-unavailable");
    }
    expect(
      domain
        .filter(
          (o) =>
            COMMAND_REGISTRY[o.id as keyof typeof COMMAND_REGISTRY].state ===
            "unavailable",
        )
        .map((o) => o.id)
        .sort(),
    ).toEqual(["job-stack.packet.create.v1", "job-stack.submission.record.v1"]);
  });
  it("keeps catalog operations without maintained mechanics unavailable", () => {
    for (const [id, reason] of [
      ["job-stack.meeting.import.v1", "meeting-authorization-resolver-unavailable"],
      ["job-stack.profile.export.v1", "profile-export-mechanics-unavailable"],
      ["job-stack.packet.create.v1", "claim-permission-resolver-unavailable"],
      ["job-stack.submission.record.v1", "claim-permission-resolver-unavailable"],
    ] as const) {
      expect(COMMAND_REGISTRY[id]).toEqual({ state: "unavailable", reason });
      expect(() => commandFor(id)).toThrow("operation-unavailable");
    }
    expect(commandFor("job-stack.version.save.v1").kind).toBe("version-save");
    expect(commandFor("job-stack.upload.chunk.v1")).toMatchObject({
      kind: "upload-chunk",
      effect: "intake",
    });
  });
  it("never dispatches unregistered, internal or external operations", () => {
    for (const id of [
      "job-stack.recovery.commit.v1",
      "job-stack.reply.send.v1",
      "send_reply",
      "schedule_interview",
      "",
    ])
      expect(() => commandFor(id)).toThrow("operation-unavailable");
    expect(operationById("job-stack.reply.send.v1")).toBeNull();
    for (const name of [
      "send_reply",
      "schedule_interview",
      "reschedule_interview",
      "cancel_interview",
      "sync_mail",
      "discover",
      "import_document",
      "reconcile_action",
      "queue",
      "scheduled",
    ]) {
      expect(Object.hasOwn(EXTERNAL_EFFECTS, name)).toBe(true);
      expect(legacyAvailability(name)).toMatch(/gated|reserved/);
      expect(() => denyLegacyOperation(name)).toThrow("operation-unavailable");
    }
    expect(legacyAvailability("capture_opportunity")).toBe(
      "superseded-by-command-registry",
    );
  });
  it("denies unavailable catalog operations before any authority call", async () => {
    const h = await commandHarness();
    await expect(
      h.invoke("job-stack.packet.create.v1", {
        requestKey: "packet-1",
        body: { opportunityId: "opportunity-1", claimIds: ["claim-1"] },
      }),
    ).rejects.toThrow("operation-unavailable");
    await expect(
      h.invoke("job-stack.profile.export.v1", {
        requestKey: "export-1",
        changeSetId: "change-1",
        format: "json",
      }),
    ).rejects.toThrow("operation-unavailable");
    expect(h.control.calls).toEqual([]);
    expect(h.sqlite.count("command_requests")).toBe(0);
  });
});

describe("public failure codes", () => {
  it("passes only fixed lowercase codes and hides storage or input text", () => {
    expect(publicFailure(Error("operation-denied"))).toBe("operation-denied");
    expect(publicFailure(new DomainError("REVISION_CONFLICT", 409))).toBe(
      "revision-conflict",
    );
    expect(publicFailure(new DomainError("REQUEST_KEY_CONFLICT", 409))).toBe(
      "request-key-conflict",
    );
    expect(publicFailure(new DomainError("IDEMPOTENCY_CONFLICT", 409))).toBe(
      "request-key-conflict",
    );
    expect(publicFailure(new ZodError([]))).toBe("operation-invalid");
    expect(publicFailure(Error("invalid-shared-value"))).toBe(
      "operation-invalid",
    );
    expect(
      publicFailure(Error("D1_ERROR: UNIQUE constraint failed: records.body")),
    ).toBe("operation-failed");
    expect(publicFailure(new DomainError("has spaces in it"))).toBe(
      "operation-failed",
    );
  });
});

describe("command serialization", () => {
  it("runs commands strictly in order and survives failures", async () => {
    const queue = createSerialQueue(),
      events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = queue.run(async () => {
      events.push("first:start");
      await gate;
      events.push("first:end");
      throw Error("first-failed");
    });
    const second = queue.run(async () => {
      events.push("second");
      return 2;
    });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    release();
    await expect(first).rejects.toThrow("first-failed");
    expect(await second).toBe(2);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });
});
