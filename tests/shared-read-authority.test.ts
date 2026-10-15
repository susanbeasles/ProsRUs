import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { parseReadRequest, readInvocation } from "../src/application/shared-read-authority";
import { validateRpc } from "../integration/shared-contract.mjs";
import { sharedReadFixture } from "./fixtures/shared-read-authority";

it("sends the exact current-authority RPC for both read and before-ack stages", async () => {
  const fixture = await sharedReadFixture();
  const revalidate = vi.fn(async value => {
    validateRpc("revalidate", value);
    return fixture.response;
  });
  for (const stage of ["read", "before-ack"] as const) {
    expect(await readInvocation(fixture.request, { revalidate }, stage)).toEqual(fixture.invocation);
    expect(revalidate.mock.lastCall?.[0]).toEqual({
      contract: "job-stack.shared-auth.v1", invocationId: "invocation_fixture",
      operationId: "job-stack.records.read.v1", stage,
      inputDigest: createHash("sha256").update('job-stack.shared-auth.v1\0invocation-input\0{"input":{"cursor":null,"kind":"opportunity","workspaceId":"workspace_fixture"},"operationId":"job-stack.records.read.v1"}').digest("hex"),
    });
  }
});

it("rejects identity, target, revision, scope, revocation and expiry drift", async () => {
  const { request, response: r } = await sharedReadFixture();
  const v = r.invocation;
  const changed = [
    { ...r, extra: "not-a-contract-field" },
    { ...r, now: r.expiresAtMs },
    { ...r, expiresAtMs: r.expiresAtMs + 1 },
    { ...r, invocation: { ...v, invocationId: "foreign_invocation" } },
    { ...r, invocation: { ...v, operation: { ...v.operation, inputDigest: "0".repeat(64) } } },
    { ...r, invocation: { ...v, verifiedOwnerPrincipalId: "access-owner:other@example.invalid" } },
    { ...r, invocation: { ...v, grant: { ...v.grant, revision: 2 } } },
    { ...r, invocation: { ...v, grant: { ...v.grant, revokedAtMs: r.now } } },
    { ...r, invocation: { ...v, grant: { ...v.grant, scopes: ["job-stack.version.read"] } } },
    { ...r, invocation: { ...v, capability: { ...v.capability, state: "disabled" } } },
    { ...r, invocation: { ...v, capability: { ...v.capability, workspace: { ...v.capability.workspace, workspaceId: "foreign_workspace" } } } },
  ];
  for (const value of changed)
    await expect(readInvocation(request, { revalidate: async () => value })).rejects.toThrow();
});

it("requires a second current decision before acknowledgement and never caches admission", async () => {
  const fixture = await sharedReadFixture();
  let revoked = false;
  const revalidate = vi.fn(async () => {
    if (revoked) throw Error("operation-denied");
    return fixture.response;
  });
  await readInvocation(fixture.request, { revalidate });
  revoked = true;
  await expect(readInvocation(fixture.request, { revalidate }, "before-ack")).rejects.toThrow("operation-denied");
  expect(revalidate).toHaveBeenCalledTimes(2);
});

it("accepts and disposes only the trusted non-enumerable Workerd disposal marker", async () => {
  const fixture = await sharedReadFixture();
  const dispose = vi.fn();
  const value = Object.defineProperty({ ...fixture.response }, Symbol.dispose, { value: dispose });
  await readInvocation(fixture.request, { revalidate: async () => value });
  expect(dispose).toHaveBeenCalledOnce();
  const untrusted = Object.defineProperty({ ...fixture.response }, Symbol.dispose, { value: dispose, enumerable: true });
  await expect(readInvocation(fixture.request, { revalidate: async () => untrusted })).rejects.toThrow();
});

it("closed read ingress does not accept caller-supplied authority or mutation operations", async () => {
  const fixture = await sharedReadFixture();
  expect(() => parseReadRequest({ ...fixture.request, invocation: fixture.invocation })).toThrow();
  expect(() => parseReadRequest({ ...fixture.request, operationId: "job-stack.claim.add.v1" })).toThrow("operation-unavailable");
});
