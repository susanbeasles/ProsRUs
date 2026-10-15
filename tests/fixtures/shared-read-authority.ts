import {
  CONTRACT,
  canonicalJson,
  operationById,
  validateInvocation,
  type CoreInvokeRequest,
} from "../../integration/shared-contract.mjs";
import { parseReadRequest } from "../../src/application/shared-read-authority";

/** Public synthetic contract corpus; this fixture grants no production authority. */
export async function sharedReadFixture(
  supplied: CoreInvokeRequest = {
    contract: CONTRACT,
    invocationId: "invocation_fixture",
    operationId: "job-stack.records.read.v1",
    input: { workspaceId: "workspace_fixture", kind: "opportunity", cursor: null },
  },
  now = 1000,
) {
  const request = parseReadRequest(supplied);
  const operation = operationById(request.operationId);
  if (!operation || operation.effect !== "read") throw Error("fixture-read-only");
  const inputDigest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
    CONTRACT + "\0invocation-input\0" + canonicalJson({ operationId: request.operationId, input: request.input }),
  ))), byte => byte.toString(16).padStart(2, "0")).join("");
  const ownerPrincipal = "access-owner:synthetic@example.invalid";
  const expiresAtMs = now + 60000;
  const capability = {
    version: 1, kind: "job-stack-workspace-capability", id: "capability_fixture", revision: 1,
    issuerPrincipalId: ownerPrincipal,
    workspace: { ownerId: "owner_fixture", workspaceId: request.input.workspaceId },
    namespace: "namespace_fixture", initialEpochId: "epoch_fixture", state: "active",
    scopes: [operation.scope], contract: CONTRACT,
    preparationFormat: "bound-primary-v1", packageFormat: "recovery-package-v1", runtime: "fixture",
  };
  const grant = {
    version: 2, kind: "job-stack-workspace", id: "grant_fixture", revision: 1,
    issuerPrincipalId: ownerPrincipal, principalId: "client:client_fixture", clientId: "client_fixture",
    issuer: "https://control.vespoli.me", audience: "https://control.vespoli.me/mcp",
    capabilityId: capability.id, capabilityRevision: capability.revision, scopes: [operation.scope],
    resources: [{ provider: "job-stack", kind: "workspace", id: request.input.workspaceId, ownerId: "owner_fixture" }],
    createdAtMs: now, expiresAtMs, revokedAtMs: null, delegation: { allowed: false }, consentId: "consent_fixture",
  };
  const access = {
    kind: "canonical", grantId: grant.id, grantRevision: grant.revision,
    principalId: grant.principalId, clientId: grant.clientId,
    issuer: grant.issuer, audience: grant.audience, expiresAtMs,
  };
  const invocation = validateInvocation({
    contract: CONTRACT, invocationId: request.invocationId, access, grant, capability,
    operation: { id: operation.id, version: 1, scope: operation.scope, effect: "read", inputDigest },
    entrypoint: "owner", verifiedOwnerPrincipalId: ownerPrincipal,
    authorizedAtMs: now, expiresAtMs,
  });
  return { request, invocation, response: { invocation, now, expiresAtMs } };
}
