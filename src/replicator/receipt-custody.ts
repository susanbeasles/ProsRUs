import { CompactSign, importJWK } from "jose";
import { z } from "zod";
import { demand } from "../domain/model";
import type { RecoverySignature, RecoverySignatureBinding } from "../domain/recovery";
import {
  canonicalizeEnvelope,
  type RecoveryVerificationKey,
} from "../domain/recovery-canonical";

const coordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** The replicator's own signing key, held only in its Secrets Store binding.
 * It signs receipts and checkpoint manifests; it can sign nothing else. */
const signingKeySchema = z
  .object({
    format: z.literal("recovery-signing-key-v1"),
    keyId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    algorithm: z.literal("ES256"),
    privateJwk: z
      .object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: coordinate, y: coordinate, d: coordinate })
      .strict(),
  })
  .strict();

export type ReceiptCustody = Readonly<{
  keyId: string;
  verificationKey: RecoveryVerificationKey;
  sign: (
    binding: RecoverySignatureBinding & Readonly<{ purpose: "receipt" | "checkpoint" }>,
  ) => Promise<RecoverySignature>;
}>;

/** Absent, unreadable or malformed key material means custody is unavailable:
 * the replicator then waits at the receipt stage instead of inventing evidence.
 * The secret value is never logged or echoed in an error. */
export async function loadReceiptCustody(raw: string | null | undefined): Promise<ReceiptCustody | null> {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  let parsed: z.infer<typeof signingKeySchema>;
  try {
    parsed = signingKeySchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
  const { d: omitted, ...publicJwk } = parsed.privateJwk;
  void omitted;
  const privateKey = await importJWK({ ...parsed.privateJwk, alg: "ES256" }, "ES256");
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { ...publicJwk, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
  return {
    keyId: parsed.keyId,
    verificationKey: { keyId: parsed.keyId, algorithm: "ES256", publicKey },
    async sign(binding) {
      demand(binding.purpose === "receipt" || binding.purpose === "checkpoint", "SIGNING_PURPOSE_FORBIDDEN", 403);
      const jws = await new CompactSign(canonicalizeEnvelope(binding))
        .setProtectedHeader({ alg: "ES256", kid: parsed.keyId, typ: "job-stack-recovery+jws" })
        .sign(privateKey);
      return { keyId: parsed.keyId, algorithm: "ES256", jws };
    },
  };
}
