import { createHash } from "node:crypto";
import { demand, id } from "./model";

/** Pure command rules shared by every registered owner command. No I/O. */
export type OwnerPresentation = Readonly<{
  entrypoint: "owner" | "mcp" | "recovery";
  verifiedOwnerPrincipalId: string | null;
  issuerPrincipalId: string;
  grantId: string;
  grantRevision: number;
}>;
export type OwnerInteraction = Readonly<{ id: string; revision: number }>;

/** A current owner interaction exists only when Control verified the owner
 * presentation for this exact invocation. MCP clients never qualify. Its
 * identity is the owner-selected grant and revision, so a retained plan stays
 * retryable under the same grant while any grant change alters the meaning. */
export function ownerInteraction(
  value: OwnerPresentation,
): OwnerInteraction | null {
  if (
    value.entrypoint !== "owner" ||
    value.verifiedOwnerPrincipalId === null ||
    value.verifiedOwnerPrincipalId !== value.issuerPrincipalId
  )
    return null;
  demand(
    typeof value.grantId === "string" &&
      value.grantId.length > 0 &&
      value.grantId.length <= 256,
    "INVALID_GRANT_IDENTITY",
  );
  demand(
    Number.isSafeInteger(value.grantRevision) && value.grantRevision > 0,
    "INVALID_GRANT_REVISION",
  );
  const digest = createHash("sha256")
    .update(`job-stack.owner-interaction.v1\0${value.grantId}`)
    .digest("hex");
  return {
    id: `interaction-${digest.slice(0, 48)}`,
    revision: value.grantRevision,
  };
}
export function requireOwnerInteraction(
  value: OwnerPresentation,
): OwnerInteraction {
  const interaction = ownerInteraction(value);
  demand(interaction, "OWNER_INTERACTION_REQUIRED", 403);
  return interaction;
}

export type LedgerEntry = Readonly<{
  operationId: string;
  inputDigest: string;
  state: "pending" | "committed";
}>;
export type RequestKeyDecision = Readonly<{
  kind: "new" | "resume" | "replay" | "conflict";
}>;
/** One request key carries one meaning per owner/workspace across all commands. */
export function decideRequestKey(
  entry: LedgerEntry | null,
  operationId: string,
  inputDigest: string,
): RequestKeyDecision {
  demand(/^[a-f0-9]{64}$/.test(inputDigest), "INVALID_INPUT_DIGEST");
  if (entry === null) return { kind: "new" };
  if (entry.operationId !== operationId || entry.inputDigest !== inputDigest)
    return { kind: "conflict" };
  return { kind: entry.state === "committed" ? "replay" : "resume" };
}

const RESERVED_PREFIX = "internal-";
/** Host-owned prerequisite saves use this prefix; public callers cannot. */
export function assertPublicRequestKey(requestKey: string): void {
  id.parse(requestKey);
  demand(
    !requestKey.toLowerCase().startsWith(RESERVED_PREFIX),
    "RESERVED_REQUEST_KEY",
  );
}
export function internalBaselineKey(requestRootId: string): string {
  const key = `${RESERVED_PREFIX}baseline-${requestRootId}`;
  demand(id.safeParse(key).success, "INVALID_REQUEST_ROOT");
  return key;
}
