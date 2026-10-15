import { z } from "zod";
import {
  CONTRACT,
  validateRpc,
} from "../../../integration/shared-contract.mjs";
import { demand, DomainError, id } from "../../domain/model";
import {
  preparedEnvelopePayloadSchema,
  preparedEnvelopeSchema,
  type PreparedEnvelope,
  type PreparedEnvelopePayload,
} from "../../domain/recovery";
import {
  canonicalizeEnvelope,
  verifyRecoverySignature,
  type RecoveryVerificationKey,
} from "../../domain/recovery-canonical";
import { equalMetadata } from "../../storage/recovery-metadata";
import { unsignedPreparation } from "../../storage/recovery-package-archive";
import type { RecoverySigner } from "../recovery-ports";
import { rpcValue, type ControlAuthority } from "../shared-read-authority";

const coordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** Public verification material for Control's recovery signing key. It is not
 * a secret and grants nothing: it only lets the Product verify signatures it
 * receives. Absent or malformed configuration means signing is unavailable. */
const trustRootSchema = z
  .object({
    format: z.literal("recovery-trust-root-v1"),
    keyId: id,
    algorithm: z.literal("ES256"),
    publicJwk: z
      .object({
        kty: z.literal("EC"),
        crv: z.literal("P-256"),
        x: coordinate,
        y: coordinate,
      })
      .strict(),
  })
  .strict();
export async function parseTrustRoot(
  raw: string | undefined,
): Promise<RecoveryVerificationKey | null> {
  if (raw === undefined || raw.length > 4096) return null;
  let parsed;
  try {
    parsed = trustRootSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { ...parsed.publicJwk, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
  return { keyId: parsed.keyId, algorithm: parsed.algorithm, publicKey };
}

/** RecoverySigner whose custody is Control: the Product sends the exact unsigned
 * payload through the declared `signPreparation` RPC bound to the live
 * invocation, then independently verifies the returned envelope against the
 * configured public trust root. No key material exists in the Product. */
export function createControlSigner(
  authority: ControlAuthority,
  invocationId: string,
  trust: RecoveryVerificationKey | null,
): RecoverySigner {
  const unavailable = async (): Promise<never> => {
    throw new DomainError("RECOVERY_SIGNING_AUTHORITY_UNAVAILABLE", 503);
  };
  if (trust === null)
    return {
      capabilities: {
        custody: "trusted_server",
        algorithms: [],
        trustRootIds: [],
      },
      signPreparation: unavailable,
      verifyPreparation: unavailable,
      signCommit: unavailable,
    };
  const key = trust;
  async function verifyPreparation(prepared: PreparedEnvelope) {
    canonicalizeEnvelope(prepared);
    const parsed = preparedEnvelopeSchema.parse(prepared);
    demand(parsed.packageBinding, "PACKAGE_BINDING_REQUIRED");
    await verifyRecoverySignature(
      parsed.signature,
      "preparation",
      unsignedPreparation(parsed),
      key,
    );
  }
  async function signPreparation(
    input: PreparedEnvelopePayload,
  ): Promise<PreparedEnvelope> {
    canonicalizeEnvelope(input);
    const payload = preparedEnvelopePayloadSchema.parse(input);
    demand(payload.packageBinding, "PACKAGE_BINDING_REQUIRED");
    const request = validateRpc("signPreparation", {
      contract: CONTRACT,
      invocationId,
      transactionId: payload.transactionId,
      prepared: payload,
    });
    let response: unknown;
    try {
      response = rpcValue(await authority.signPreparation(request));
    } catch {
      throw new DomainError("RECOVERY_SIGNING_DENIED", 403);
    }
    const prepared = preparedEnvelopeSchema.parse(response);
    demand(
      equalMetadata(unsignedPreparation(prepared), payload),
      "PREPARATION_CONTENT_MISMATCH",
    );
    await verifyPreparation(prepared);
    return prepared;
  }
  return {
    capabilities: {
      custody: "trusted_server",
      algorithms: [key.algorithm],
      trustRootIds: [key.keyId],
    },
    signPreparation,
    verifyPreparation,
    // Commit certificates belong to the gated protection pipeline, not the
    // primary save path; no commit-signing RPC is used by commands.
    signCommit: unavailable,
  };
}
