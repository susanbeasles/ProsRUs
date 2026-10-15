import { CompactSign, importJWK, type JWK } from "jose";
import {
  CONTRACT,
  CORE_SCOPES,
  canonicalJson,
  operationById,
  validateInvocation,
  validateRpc,
  type CoreInvokeRequest,
  type SharedInvocation,
} from "../../integration/shared-contract.mjs";
import {
  canonicalizeEnvelope,
  hashEnvelope,
} from "../../src/domain/recovery-canonical";
import { recoveryFormat } from "../../src/application/recovery-package-content";

/** Public synthetic Control stand-in for command tests. It grants no production
 * authority: invocations are derived from (invocationId, operationId,
 * inputDigest) for one synthetic workspace, and `mcp_`-prefixed invocation ids
 * select the MCP entrypoint. Signing uses a key generated at test runtime. */
export const SYNTHETIC_WORKSPACE = Object.freeze({
  ownerId: "owner_fixture",
  workspaceId: "workspace_fixture",
});
export const SYNTHETIC_OWNER = "access-owner:synthetic@example.invalid";
export const SYNTHETIC_KEY_ID = "synthetic-control";
export type DenyRule = (call: {
  method: "revalidate" | "signPreparation";
  stage: string;
  operationId: string;
}) => boolean;

export function syntheticInvocation(input: {
  invocationId: string;
  operationId: string;
  inputDigest: string;
  now?: number;
  ttl?: number;
}): SharedInvocation {
  const operation = operationById(input.operationId);
  if (!operation || operation.effect === "recovery-commit")
    throw Error("fixture-operation");
  const now = input.now ?? 1000,
    expiresAtMs = now + (input.ttl ?? 600000),
    mcp = input.invocationId.startsWith("mcp_");
  const capability = {
    version: 1,
    kind: "job-stack-workspace-capability",
    id: "capability_fixture",
    revision: 1,
    issuerPrincipalId: SYNTHETIC_OWNER,
    workspace: SYNTHETIC_WORKSPACE,
    namespace: "namespace_fixture",
    initialEpochId: "epoch_fixture",
    state: "active",
    scopes: [...CORE_SCOPES],
    contract: CONTRACT,
    preparationFormat: "bound-primary-v1",
    packageFormat: "recovery-package-v1",
    runtime: "fixture",
  };
  const grant = {
    version: 2,
    kind: "job-stack-workspace",
    id: "grant_fixture",
    revision: 1,
    issuerPrincipalId: SYNTHETIC_OWNER,
    principalId: "client:client_fixture",
    clientId: "client_fixture",
    issuer: "https://control.vespoli.me",
    audience: "https://control.vespoli.me/mcp",
    capabilityId: capability.id,
    capabilityRevision: capability.revision,
    scopes: [...CORE_SCOPES],
    resources: [
      {
        provider: "job-stack",
        kind: "workspace",
        id: SYNTHETIC_WORKSPACE.workspaceId,
        ownerId: SYNTHETIC_WORKSPACE.ownerId,
      },
    ],
    createdAtMs: now,
    expiresAtMs,
    revokedAtMs: null,
    delegation: { allowed: false },
    consentId: "consent_fixture",
  };
  return validateInvocation({
    contract: CONTRACT,
    invocationId: input.invocationId,
    access: {
      kind: "canonical",
      grantId: grant.id,
      grantRevision: grant.revision,
      principalId: grant.principalId,
      clientId: grant.clientId,
      issuer: grant.issuer,
      audience: grant.audience,
      expiresAtMs,
    },
    grant,
    capability,
    operation: {
      id: operation.id,
      version: 1,
      scope: operation.scope,
      effect: operation.effect,
      inputDigest: input.inputDigest,
    },
    entrypoint: mcp ? "mcp" : "owner",
    verifiedOwnerPrincipalId: mcp ? null : SYNTHETIC_OWNER,
    authorizedAtMs: now,
    expiresAtMs,
  });
}
export async function inputDigestOf(request: CoreInvokeRequest) {
  const bytes = new TextEncoder().encode(
    CONTRACT +
      "\0invocation-input\0" +
      canonicalJson({ operationId: request.operationId, input: request.input }),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export function trustRootFor(publicJwk: JWK, keyId = SYNTHETIC_KEY_ID) {
  return JSON.stringify({
    format: "recovery-trust-root-v1",
    keyId,
    algorithm: "ES256",
    publicJwk: {
      kty: publicJwk.kty,
      crv: publicJwk.crv,
      x: publicJwk.x,
      y: publicJwk.y,
    },
  });
}

/** Synthetic authority mirroring Control's owner stage machine: one or more
 * `read`, then exactly one `before-ack`; any other stage, any call after
 * before-ack and any call after a denial is refused (denial is terminal). Every
 * call is recorded; `deny` injects revocation. Signing binds the payload digest
 * (real Control does not implement signPreparation; see docs/status.md). */
export function syntheticControl(options: {
  privateJwk: JWK;
  keyId?: string;
  now?: () => number;
}) {
  const calls: string[] = [];
  const stages = new Map<string, "read" | "acknowledged" | "denied">();
  const violations: string[] = [];
  let deny: DenyRule = () => false;
  const keyId = options.keyId ?? SYNTHETIC_KEY_ID,
    now = options.now ?? (() => 1000);
  let signingKey: CryptoKey | Uint8Array | null = null;
  async function key() {
    signingKey ??= await importJWK(options.privateJwk, "ES256");
    return signingKey;
  }
  const authority = {
    async revalidate(value: unknown) {
      const input = validateRpc("revalidate", value);
      calls.push(input.stage);
      const prior = stages.get(input.invocationId);
      const order =
        (input.stage === "read" || input.stage === "before-ack") &&
        prior !== "denied" &&
        prior !== "acknowledged" &&
        (input.stage === "read" || prior === "read");
      if (!order) violations.push(`${input.invocationId}:${input.stage}`);
      if (
        !order ||
        deny({
          method: "revalidate",
          stage: input.stage,
          operationId: input.operationId,
        })
      ) {
        stages.set(input.invocationId, "denied");
        throw Error("operation-denied");
      }
      const invocation = syntheticInvocation(input);
      stages.set(
        input.invocationId,
        input.stage === "read" ? "read" : "acknowledged",
      );
      return { invocation, now: now(), expiresAtMs: invocation.expiresAtMs };
    },
    async signPreparation(value: unknown) {
      const input = validateRpc("signPreparation", value);
      calls.push("sign-preparation");
      if (
        stages.get(input.invocationId) !== "read" ||
        deny({
          method: "signPreparation",
          stage: "sign-preparation",
          operationId: "",
        })
      )
        throw Error("operation-denied");
      const binding = {
        ...recoveryFormat,
        purpose: "preparation" as const,
        digest: await hashEnvelope("preparation", input.prepared),
      };
      const jws = await new CompactSign(canonicalizeEnvelope(binding))
        .setProtectedHeader({
          alg: "ES256",
          kid: keyId,
          typ: "job-stack-recovery+jws",
        })
        .sign(await key());
      return {
        ...input.prepared,
        signature: { keyId, algorithm: "ES256", jws },
      };
    },
  };
  return {
    authority,
    calls,
    /** Out-of-order or post-terminal calls the Product attempted. */
    violations,
    setDeny(rule: DenyRule) {
      deny = rule;
    },
    reset() {
      calls.length = 0;
      violations.length = 0;
      deny = () => false;
    },
  };
}
