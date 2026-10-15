import { z } from "zod";
import {
  CONTRACT,
  canonicalJson,
  detachedJson,
  stageAllowed,
  validateCoreInput,
  validateInvocation,
  operationById,
  type CoreEffect,
  type CoreInvokeRequest,
  type SharedInvocation,
  type RpcByName,
} from "../../integration/shared-contract.mjs";
import { demand } from "../domain/model";
export interface ReadAuthority {
  revalidate(request: RpcByName["revalidate"]): Promise<unknown>;
}
/** The reciprocal Control `JobStackAuthority` surface the Product calls. Only
 * current-authority revalidation and preparation signing are used. */
export interface ControlAuthority extends ReadAuthority {
  signPreparation(request: RpcByName["signPreparation"]): Promise<unknown>;
}
export type RevalidationStage = RpcByName["revalidate"]["stage"];
export type CurrentInvocation = Readonly<{
  invocation: SharedInvocation;
  now: number;
  expiresAtMs: number;
}>;
// Only this trusted binding response may carry Workerd's disposal marker.
export function rpcValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return detachedJson(value);
  const marker = Object.getOwnPropertyDescriptor(value, Symbol.dispose);
  if (!marker) return detachedJson(value);
  demand(
    !marker.enumerable && typeof marker.value === "function",
    "operation-denied",
  );
  const copy = Object.create(Object.getPrototypeOf(value));
  for (const key of Reflect.ownKeys(value)) {
    if (key !== Symbol.dispose) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      demand(descriptor, "operation-denied");
      Object.defineProperty(copy, key, descriptor);
    }
  }
  try {
    return detachedJson(copy);
  } finally {
    marker.value.call(value);
  }
}
/** Closed public envelope for any registered catalog operation. The internal
 * recovery commit operation is never reachable through this ingress. */
export function parseCoreRequest(
  value: unknown,
  accept: (effect: string) => boolean = (effect) =>
    effect !== "recovery-commit",
): CoreInvokeRequest {
  const envelope = z
    .object({
      contract: z.literal(CONTRACT),
      invocationId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
      operationId: z.string(),
      input: z.unknown(),
    })
    .strict()
    .parse(detachedJson(value));
  const operation = operationById(envelope.operationId);
  demand(
    operation &&
      operation.effect !== "recovery-commit" &&
      accept(operation.effect),
    "operation-unavailable",
  );
  const input = validateCoreInput(operation.id, envelope.input);
  // The finite operation discriminator and its exact input were both validated.
  return { ...envelope, operationId: operation.id, input } as CoreInvokeRequest;
}
export function parseReadRequest(value: unknown): CoreInvokeRequest {
  return parseCoreRequest(value, (effect) => effect === "read");
}
export async function readInvocation(
  request: CoreInvokeRequest,
  authority: ReadAuthority,
  stage: "read" | "before-ack" = "read",
): Promise<SharedInvocation> {
  return (await currentInvocation(request, authority, stage, "read"))
    .invocation;
}
/** Fresh current-authority decision for one exact stage. Never cached: every
 * call is a new Control revalidation bound to the exact input digest. */
export async function currentInvocation(
  request: CoreInvokeRequest,
  authority: ReadAuthority,
  stage: RevalidationStage,
  effect: CoreEffect,
): Promise<CurrentInvocation> {
  const envelope = z
    .object({
      contract: z.literal(CONTRACT),
      invocationId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
      operationId: z.string(),
      input: z.unknown(),
    })
    .strict()
    .parse(detachedJson(request));
  demand(envelope.operationId === request.operationId, "operation-denied");
  demand(
    operationById(request.operationId)?.effect === effect &&
      stageAllowed(request.operationId, stage),
    "operation-denied",
  );
  const input = validateCoreInput(request.operationId, envelope.input);
  const bytes = new TextEncoder().encode(
    CONTRACT +
      "\0invocation-input\0" +
      canonicalJson({ operationId: request.operationId, input }),
  );
  const inputDigest = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const result = z
    .object({
      invocation: z.unknown(),
      now: z.number().int().nonnegative(),
      expiresAtMs: z.number().int().nonnegative(),
    })
    .strict()
    .parse(
      rpcValue(
        await authority.revalidate({
          contract: CONTRACT,
          invocationId: envelope.invocationId,
          operationId: request.operationId,
          inputDigest,
          stage,
        }),
      ),
    );
  const invocation = validateInvocation(result.invocation);
  demand(
    invocation.invocationId === envelope.invocationId &&
      invocation.operation.id === request.operationId &&
      invocation.operation.inputDigest === inputDigest &&
      invocation.operation.effect === effect &&
      invocation.capability.workspace.workspaceId === input.workspaceId &&
      result.now < result.expiresAtMs &&
      result.expiresAtMs <= invocation.expiresAtMs,
    "operation-denied",
  );
  return { invocation, now: result.now, expiresAtMs: result.expiresAtMs };
}
