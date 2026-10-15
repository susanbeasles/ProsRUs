import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DomainError } from "../src/domain/model";
import {
  assertPublicRequestKey,
  decideRequestKey,
  internalBaselineKey,
  ownerInteraction,
  requireOwnerInteraction,
} from "../src/domain/command-policy";

const owner = "access-owner:synthetic@example.invalid";
const presentation = {
  entrypoint: "owner" as const,
  verifiedOwnerPrincipalId: owner,
  issuerPrincipalId: owner,
  grantId: "grant:with/any canonical chars",
  grantRevision: 3,
};
const interactionId =
  "interaction-" +
  createHash("sha256")
    .update("job-stack.owner-interaction.v1\0grant:with/any canonical chars")
    .digest("hex")
    .slice(0, 48);
function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return `${error.code}:${error.status}`;
    throw error;
  }
  return "no-error";
}

describe("owner interaction rule", () => {
  it("derives current owner interaction only from the verified owner entrypoint", () => {
    expect(ownerInteraction(presentation)).toEqual({
      id: interactionId,
      revision: 3,
    });
    expect(requireOwnerInteraction(presentation)).toEqual({
      id: interactionId,
      revision: 3,
    });
  });
  it("keeps the interaction identity stable for one grant revision so retained plans can be retried", () => {
    expect(ownerInteraction({ ...presentation })).toEqual(
      ownerInteraction(presentation),
    );
    expect(ownerInteraction({ ...presentation, grantRevision: 4 })).toEqual({
      id: interactionId,
      revision: 4,
    });
    expect(
      ownerInteraction({ ...presentation, grantId: "other-grant" })?.id,
    ).not.toBe(interactionId);
  });
  it("treats MCP or unverified presentations as no owner interaction", () => {
    for (const value of [
      { ...presentation, entrypoint: "mcp" as const },
      { ...presentation, verifiedOwnerPrincipalId: null },
      {
        ...presentation,
        verifiedOwnerPrincipalId: "access-owner:other@example.invalid",
      },
      { ...presentation, entrypoint: "recovery" as const },
    ]) {
      expect(ownerInteraction(value)).toBeNull();
      expect(code(() => requireOwnerInteraction(value))).toBe(
        "OWNER_INTERACTION_REQUIRED:403",
      );
    }
  });
});

describe("request key idempotency rule", () => {
  const digest = "a".repeat(64);
  it("starts a new request when the key is unused", () => {
    expect(decideRequestKey(null, "job-stack.claim.add.v1", digest)).toEqual({
      kind: "new",
    });
  });
  it("replays a committed request with the identical meaning", () => {
    expect(
      decideRequestKey(
        {
          operationId: "job-stack.claim.add.v1",
          inputDigest: digest,
          state: "committed",
        },
        "job-stack.claim.add.v1",
        digest,
      ),
    ).toEqual({ kind: "replay" });
  });
  it("resumes a pending request with the identical meaning", () => {
    expect(
      decideRequestKey(
        {
          operationId: "job-stack.claim.add.v1",
          inputDigest: digest,
          state: "pending",
        },
        "job-stack.claim.add.v1",
        digest,
      ),
    ).toEqual({ kind: "resume" });
  });
  it("conflicts when the same key carries a different digest or operation", () => {
    for (const [operationId, inputDigest, state] of [
      ["job-stack.claim.add.v1", "b".repeat(64), "committed"],
      ["job-stack.claim.add.v1", "b".repeat(64), "pending"],
      ["job-stack.opportunity.capture.v1", digest, "committed"],
    ] as const)
      expect(
        decideRequestKey(
          { operationId, inputDigest, state },
          "job-stack.claim.add.v1",
          digest,
        ),
      ).toEqual({ kind: "conflict" });
  });
  it("rejects malformed digests instead of comparing them", () => {
    expect(
      code(() => decideRequestKey(null, "job-stack.claim.add.v1", "A")),
    ).toBe("INVALID_INPUT_DIGEST:400");
  });
});

describe("reserved request key namespace", () => {
  it("reserves the internal prefix for host-owned baseline saves", () => {
    expect(code(() => assertPublicRequestKey("internal-baseline-x"))).toBe(
      "RESERVED_REQUEST_KEY:400",
    );
    expect(code(() => assertPublicRequestKey("Internal-x"))).toBe(
      "RESERVED_REQUEST_KEY:400",
    );
    expect(() => assertPublicRequestKey("public-key_1")).not.toThrow();
  });
  it("derives a bounded internal baseline key that public callers cannot choose", () => {
    const key = internalBaselineKey("11111111-2222-4333-8444-555555555555");
    expect(key).toBe("internal-baseline-11111111-2222-4333-8444-555555555555");
    expect(code(() => assertPublicRequestKey(key))).toBe(
      "RESERVED_REQUEST_KEY:400",
    );
    expect(code(() => internalBaselineKey("x".repeat(90)))).toBe(
      "INVALID_REQUEST_ROOT:400",
    );
  });
});
