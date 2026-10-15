import { base64url, compactVerify } from "jose";
import { DomainError, demand } from "./model";
import type {
  RecoveryPurpose,
  RecoverySignature,
  SignatureAlgorithm,
} from "./recovery";

export const RECOVERY_SCHEMA_VERSION = 1;
export const RECOVERY_CANONICALIZATION_VERSION = "jcs-rfc8785-v1";
export const RECOVERY_HASH_ALGORITHM = "sha256-domain-v1";
export const MAX_ENVELOPE_BYTES = 128 * 1024;
export const MAX_JSON_DEPTH = 64;
const encoder = new TextEncoder();
const metadataPurposes = new Set([
  "manifest",
  "transaction",
  "preparation",
  "commit",
  "checkpoint",
  "receipt",
  "inventory",
  "epoch_transition",
  "request",
]);

function validateUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      demand(next >= 0xdc00 && next <= 0xdfff, "INVALID_UNICODE");
      index += 1;
    } else {
      demand(unit < 0xdc00 || unit > 0xdfff, "INVALID_UNICODE");
    }
  }
}

function encodeJson(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
): string {
  demand(depth <= MAX_JSON_DEPTH, "JSON_DEPTH_EXCEEDED");
  if (value === null) return "null";
  if (typeof value === "string") {
    validateUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    demand(Number.isFinite(value), "NONFINITE_JSON_NUMBER");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return JSON.stringify(value);
  demand(typeof value === "object", "INVALID_JSON_VALUE");
  demand(!ancestors.has(value), "CYCLIC_JSON_VALUE");
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    demand(
      Object.getOwnPropertySymbols(value).length === 0,
      "INVALID_JSON_VALUE",
    );
    if (Array.isArray(value)) {
      demand(
        Object.keys(descriptors).length === value.length + 1,
        "INVALID_JSON_VALUE",
      );
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        demand(
          descriptor && "value" in descriptor && descriptor.enumerable,
          "INVALID_JSON_VALUE",
        );
        items.push(encodeJson(descriptor.value, ancestors, depth + 1));
      }
      return `[${items.join(",")}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    demand(
      prototype === Object.prototype || prototype === null,
      "INVALID_JSON_VALUE",
    );
    const properties = Object.keys(descriptors)
      .sort()
      .map((key) => {
        const descriptor = descriptors[key];
        demand(
          descriptor && "value" in descriptor && descriptor.enumerable,
          "INVALID_JSON_VALUE",
        );
        validateUnicode(key);
        return `${JSON.stringify(key)}:${encodeJson(descriptor.value, ancestors, depth + 1)}`;
      });
    return `{${properties.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** RFC 8785: native primitive serialization, UTF-16 key sorting, no normalization. */
export function canonicalizeEnvelope(value: unknown): Uint8Array {
  const bytes = encoder.encode(encodeJson(value, new Set(), 0));
  demand(bytes.byteLength <= MAX_ENVELOPE_BYTES, "ENVELOPE_TOO_LARGE");
  return bytes;
}

/** Scan the original grammar and decoded keys before JSON.parse can discard duplicates. */
export function parseEnvelopeJson(text: string): unknown {
  demand(
    encoder.encode(text).byteLength <= MAX_ENVELOPE_BYTES,
    "ENVELOPE_TOO_LARGE",
  );
  let offset = 0;
  function whitespace(): void {
    while (/[\t\n\r ]/.test(text[offset] ?? "x")) offset += 1;
  }
  function string(): string {
    const start = offset;
    demand(text[offset] === '"', "INVALID_JSON");
    offset += 1;
    while (offset < text.length) {
      const character = text[offset];
      if (character === '"') {
        offset += 1;
        let decoded: unknown;
        try {
          decoded = JSON.parse(text.slice(start, offset));
        } catch {
          throw new DomainError("INVALID_JSON");
        }
        demand(typeof decoded === "string", "INVALID_JSON");
        validateUnicode(decoded);
        return decoded;
      }
      if (character === "\\") {
        offset += 1;
        if (text[offset] === "u") {
          demand(
            /^[a-fA-F0-9]{4}$/.test(text.slice(offset + 1, offset + 5)),
            "INVALID_JSON",
          );
          offset += 5;
        } else {
          demand('"\\/bfnrt'.includes(text[offset] ?? "\0"), "INVALID_JSON");
          offset += 1;
        }
      } else {
        demand(text.charCodeAt(offset) >= 0x20, "INVALID_JSON");
        offset += 1;
      }
    }
    throw new DomainError("INVALID_JSON");
  }
  function value(depth: number): void {
    demand(depth <= MAX_JSON_DEPTH, "JSON_DEPTH_EXCEEDED");
    whitespace();
    const character = text[offset];
    if (character === '"') {
      string();
      return;
    }
    if (character === "{" || character === "[") {
      const object = character === "{";
      const end = object ? "}" : "]";
      const keys = new Set<string>();
      offset += 1;
      whitespace();
      if (text[offset] === end) {
        offset += 1;
        return;
      }
      while (true) {
        if (object) {
          const key = string();
          demand(!keys.has(key), "DUPLICATE_JSON_KEY");
          keys.add(key);
          whitespace();
          demand(text[offset] === ":", "INVALID_JSON");
          offset += 1;
        }
        value(depth + 1);
        whitespace();
        if (text[offset] === end) {
          offset += 1;
          return;
        }
        demand(text[offset] === ",", "INVALID_JSON");
        offset += 1;
        whitespace();
      }
    }
    const token =
      /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
        text.slice(offset),
      )?.[0];
    demand(token, "INVALID_JSON");
    if (!/^(true|false|null)$/.test(token))
      demand(Number.isFinite(Number(token)), "NONFINITE_JSON_NUMBER");
    offset += token.length;
  }
  value(0);
  whitespace();
  demand(offset === text.length, "INVALID_JSON");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DomainError("INVALID_JSON");
  }
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function domainBytes(purpose: string, bytes: Uint8Array): Uint8Array {
  const prefix = encoder.encode(
    `job-stack-recovery/${RECOVERY_SCHEMA_VERSION}/${RECOVERY_HASH_ALGORITHM}/${purpose}\0`,
  );
  const result = new Uint8Array(prefix.byteLength + bytes.byteLength);
  result.set(prefix);
  result.set(bytes, prefix.byteLength);
  return result;
}

export async function hashArtifact(bytes: Uint8Array): Promise<string> {
  return digestBytes(domainBytes("blob", bytes));
}

export async function hashEnvelope(
  purpose: string,
  value: unknown,
): Promise<string> {
  demand(metadataPurposes.has(purpose), "INVALID_RECOVERY_PURPOSE");
  return digestBytes(domainBytes(purpose, canonicalizeEnvelope(value)));
}

export type RecoveryVerificationKey = Readonly<{
  keyId: string;
  algorithm: SignatureAlgorithm;
  publicKey: CryptoKey;
}>;

/** Public-key verification only. Production signing/key custody belongs to the host port. */
export async function verifyRecoverySignature(
  signature: RecoverySignature,
  purpose: RecoveryPurpose,
  value: unknown,
  trust: RecoveryVerificationKey,
): Promise<void> {
  demand(metadataPurposes.has(purpose), "INVALID_RECOVERY_PURPOSE");
  demand(
    signature.keyId === trust.keyId && signature.algorithm === trust.algorithm,
    "SIGNATURE_POLICY_MISMATCH",
  );
  demand(trust.publicKey.type === "public", "SIGNATURE_POLICY_MISMATCH");
  const header = signature.jws.split(".")[0];
  demand(header, "SIGNATURE_POLICY_MISMATCH");
  // JOSE's JSON decoder alone cannot detect duplicate protected-header names.
  parseEnvelopeJson(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      base64url.decode(header),
    ),
  );
  const verified = await compactVerify(signature.jws, trust.publicKey, {
    algorithms: [trust.algorithm],
  });
  demand(
    verified.protectedHeader.kid === trust.keyId &&
      verified.protectedHeader.typ === "job-stack-recovery+jws",
    "SIGNATURE_POLICY_MISMATCH",
  );
  const binding = parseEnvelopeJson(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      verified.payload,
    ),
  );
  demand(
    binding !== null && typeof binding === "object" && !Array.isArray(binding),
    "SIGNATURE_POLICY_MISMATCH",
  );
  const canonicalBinding = canonicalizeEnvelope(binding);
  demand(
    canonicalBinding.byteLength === verified.payload.byteLength &&
      canonicalBinding.every((byte, index) => byte === verified.payload[index]),
    "SIGNATURE_NONCANONICAL",
  );
  const fields = Object.getOwnPropertyDescriptors(binding);
  const field = (name: string): unknown => fields[name]?.value as unknown;
  demand(
    Object.keys(fields).sort().join(",") ===
      "canonicalizationVersion,digest,hashAlgorithm,purpose,schemaVersion",
    "SIGNATURE_POLICY_MISMATCH",
  );
  demand(
    field("schemaVersion") === RECOVERY_SCHEMA_VERSION &&
      field("canonicalizationVersion") === RECOVERY_CANONICALIZATION_VERSION &&
      field("hashAlgorithm") === RECOVERY_HASH_ALGORITHM,
    "SIGNATURE_POLICY_MISMATCH",
  );
  demand(field("purpose") === purpose, "SIGNATURE_PURPOSE_MISMATCH");
  demand(
    field("digest") === (await hashEnvelope(purpose, value)),
    "SIGNATURE_DIGEST_MISMATCH",
  );
}
