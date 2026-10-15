import {
  canonicalJson,
  LIMITS,
  type CoreEffect,
  type CoreInvokeRequest,
  type SharedInvocation,
} from "../../../integration/shared-contract.mjs";
import {
  currentInvocation,
  type ReadAuthority,
} from "../shared-read-authority";

/** Control's owner flow accepts one or more `read` decisions followed by
 * exactly one `before-ack`; any call after `before-ack`, or after a denial, is
 * refused. Commands therefore only ever ask for these two stages. */
export type CommandStage = "read" | "before-ack";
/** One command invocation's current-authority session. The first decision pins
 * the exact invocation; every later stage is a fresh Control revalidation that
 * must return the same invocation (deadlines may only narrow). Any failure is
 * the fixed public denial and terminal for this invocation. Nothing is cached
 * across invocations. */
export type CommandSession = Readonly<{
  request: CoreInvokeRequest;
  invocation: SharedInvocation;
  workspace: Readonly<{ ownerId: string; workspaceId: string }>;
  /** Latest trusted authority time (monotone within the session). */
  now: () => number;
  /** Stage of the most recent authority decision, for audit attribution. */
  stage: () => CommandStage;
  authorize: (stage: CommandStage) => Promise<void>;
  /** True once the single before-ack decision passed in this invocation. */
  acknowledged: () => boolean;
}>;
function pinned(invocation: SharedInvocation) {
  const { expiresAtMs, ...identity } = invocation;
  void expiresAtMs;
  return canonicalJson(identity, LIMITS.privateComposite);
}
export async function openCommandSession(
  request: CoreInvokeRequest,
  authority: ReadAuthority,
  effect: CoreEffect,
): Promise<CommandSession> {
  let current;
  try {
    current = await currentInvocation(request, authority, "read", effect);
  } catch {
    throw Error("operation-denied");
  }
  const invocation = current.invocation,
    identity = pinned(invocation);
  let now = current.now,
    expiresAtMs = invocation.expiresAtMs,
    stage: CommandStage = "read",
    acknowledged = false,
    denied = false;
  async function authorize(next: CommandStage) {
    // Never ask again after the terminal before-ack or after any denial.
    if (denied || acknowledged) throw Error("operation-denied");
    stage = next;
    try {
      const fresh = await currentInvocation(request, authority, next, effect);
      if (
        pinned(fresh.invocation) !== identity ||
        fresh.invocation.expiresAtMs > expiresAtMs ||
        fresh.now < now
      )
        throw Error("operation-denied");
      expiresAtMs = fresh.invocation.expiresAtMs;
      now = fresh.now;
    } catch {
      denied = true;
      throw Error("operation-denied");
    }
    if (next === "before-ack") acknowledged = true;
  }
  return Object.freeze({
    request,
    invocation,
    workspace: Object.freeze({ ...invocation.capability.workspace }),
    now: () => now,
    stage: () => stage,
    authorize,
    acknowledged: () => acknowledged,
  });
}
