import { z } from "zod";
import {
  operationByName,
  validateCoreInput,
  validateCoreOutput,
  type CoreOperationId,
  type OutputById,
} from "../../integration/shared-contract.mjs";

export { validateCoreOutput };

/**
 * A transport failure with the HTTP status and the server's kebab-case error code when one was
 * supplied. The message is always one of the fixed strings below; response bytes are never echoed.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * 403 codes that do not end authority: a write needs a fresh hardware-key elevation in Control, or
 * a one-use nonce was rejected (mutate() already retried it once).
 */
export const WRITE_ELEVATION_REQUIRED = "write-elevation-required";
const NON_AUTHORITY_403 = new Set([WRITE_ELEVATION_REQUIRED, "invalid-owner-request"]);

/** 401, or 403 with any other (or no) code, from a read, nonce or write: the selected authority is gone. */
export function isAuthorityLoss(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 401) return true;
  return error.status === 403 && !(error.code !== null && NON_AUTHORITY_403.has(error.code));
}

export function needsElevation(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.code === WRITE_ELEVATION_REQUIRED;
}

/** Control's elevation page: writes need a 15-minute hardware-key confirmation there. */
export const ELEVATION_URL = "/owner/apps/job-stack";

export function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}

async function responseJson(response: Response, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
  if (!response.body) throw Error("Workspace response is invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0, oversized = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        oversized = true;
        throw Error("overbound");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    cancel();
    signal?.throwIfAborted();
    throw Error(oversized ? "Workspace response exceeds the read size limit" : "Workspace response is invalid");
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

const ERROR_BODY_BYTES = 1024;
const errorBody = z.object({ error: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64) });

/** Reads at most 1 KiB of an error response and returns only a well-formed kebab-case code. */
async function errorCode(response: Response, signal?: AbortSignal): Promise<string | null> {
  try {
    const parsed = errorBody.safeParse(await responseJson(response, ERROR_BODY_BYTES, signal));
    return parsed.success ? parsed.data.error : null;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

const READ_PATH =
  /^\/api\/operations\/job_stack_(session|records|pipeline_page|profile|version|versions|request|protection|artifact)(?:\?|$)/;

export async function request(
  path: string,
  body?: unknown,
  selection?: { grantId: string; signal?: AbortSignal },
) {
  if (body !== undefined || !selection?.grantId || !READ_PATH.test(path))
    throw Error("Read-only workspace selection required");
  selection.signal?.throwIfAborted();
  const operation = operationByName(path.split("?")[0]?.split("/").at(-1) ?? "");
  if (!operation || operation.effect !== "read")
    throw Error("Read-only workspace selection required");
  return ownerRead(path, operation.maxOutputBytes, selection);
}

/** The owner GET read flow: one-use nonce bound to grant and exact target, then a bounded read. */
async function ownerRead(path: string, maxOutputBytes: number, selection: { grantId: string; signal?: AbortSignal }) {
  selection.signal?.throwIfAborted();
  const target = new URL("/owner/job-stack" + path, "https://local.invalid");
  target.searchParams.sort();
  const relative = target.pathname + target.search;
  const nonceQuery = new URLSearchParams({
    grant: selection.grantId,
    target: relative,
  });
  const nonceResponse = await fetch(
    "/owner/job-stack/api/nonce?" + nonceQuery,
    { signal: selection.signal, cache: "no-store" },
  );
  if (!nonceResponse.ok)
    throw new ApiError(
      "Workspace access unavailable. Select a current grant.",
      nonceResponse.status,
      await errorCode(nonceResponse, selection.signal),
    );
  const { nonce } = z
    .object({ nonce: z.string().min(1) })
    .strict()
    .parse(await responseJson(nonceResponse, 4096, selection.signal));
  selection.signal?.throwIfAborted();
  target.searchParams.set("grant", selection.grantId);
  const response = await fetch(target.pathname + target.search, {
    headers: { "x-owner-nonce": nonce },
    signal: selection.signal,
    cache: "no-store",
  });
  if (!response.ok)
    throw new ApiError(
      "Workspace read denied or unavailable. Refresh your selection.",
      response.status,
      await errorCode(response, selection.signal),
    );
  const result = await responseJson(response, maxOutputBytes, selection.signal);
  selection.signal?.throwIfAborted();
  return result;
}

/**
 * `job_stack_recovery_status` (delivery contracts section 10) is added to the shared catalog by
 * another workstream. Until then this one named read uses the same owner GET flow with a local
 * output bound; request() itself stays catalog-only. The caller validates recovery-status-v1.
 */
export const RECOVERY_STATUS_READ = Object.freeze({
  name: "job_stack_recovery_status",
  scope: "job-stack.protection.read",
  maxOutputBytes: 16384,
});

export async function readRecoveryStatus(workspaceId: string, selection: { grantId: string; signal?: AbortSignal }) {
  if (!selection.grantId) throw Error("Read-only workspace selection required");
  const catalog = operationByName(RECOVERY_STATUS_READ.name);
  if (catalog && catalog.effect !== "read") throw Error("Read-only workspace selection required");
  return ownerRead(
    "/api/operations/" + RECOVERY_STATUS_READ.name + "?" + new URLSearchParams({ workspaceId }),
    catalog?.maxOutputBytes ?? RECOVERY_STATUS_READ.maxOutputBytes,
    selection,
  );
}

/** The catalog's local-write domain operations the owner dashboard may invoke through mutate(). */
export const WRITE_OPERATIONS = [
  "job_stack_add_claim",
  "job_stack_review_claim",
  "job_stack_resolve_profile_conflict",
  "job_stack_capture_opportunity",
  "job_stack_assess_opportunity",
  "job_stack_transition_opportunity",
  "job_stack_create_packet",
  "job_stack_record_submission",
  "job_stack_capture_conversation",
  "job_stack_associate_conversation",
  "job_stack_save_draft",
  "job_stack_prepare_interview",
  "job_stack_record_offer",
  "job_stack_update_settings",
] as const;
export type WriteOperation = (typeof WRITE_OPERATIONS)[number];
export type DomainWriteOutput = OutputById["job-stack.opportunity.transition.v1"];
export type WriteInput = { workspaceId: string; requestKey: string; body: unknown };

const REQUEST_KEY = /^[A-Za-z0-9_-]{1,100}$/;

/** Catalog metadata for a dashboard write; null for anything that is not an enabled domain write. */
export function writeOperation(name: string) {
  if (!(WRITE_OPERATIONS as readonly string[]).includes(name)) return null;
  const operation = operationByName(name);
  if (!operation || operation.effect !== "local-write" || !operation.domainOperation) return null;
  return operation;
}

const UNKNOWN_OUTCOME = "Outcome unknown. Retrying reuses the same request key, so the change cannot apply twice.";
/** Control/Product error code -> fixed owner-facing message (response bytes are never echoed). */
const WRITE_MESSAGES: Readonly<Record<string, string>> = {
  [WRITE_ELEVATION_REQUIRED]: "Confirm with your security key to enable changes.",
  "invalid-owner-request": "The owner request was rejected twice. Reload the dashboard and try again.",
  "request-key-conflict": "This request key was already used for a different change. Start the action again.",
  "operation-unavailable": "This action is not enabled on the server.",
  "invalid-operation-input": "The server rejected this change as invalid for the operation.",
  "body-too-large": "The change exceeds the 64 KiB request limit.",
  "invalid-product-response": "The workspace service returned an invalid response, so the outcome is unknown. Retrying reuses the same request key.",
  "job-stack-unavailable": "The workspace service is unavailable. Retrying reuses the same request key, so the change cannot apply twice.",
  "workspace-not-granted": "This grant does not cover the selected workspace. Select a current grant.",
  "job-stack-scope-not-granted": "This grant does not include this action. Select a current grant.",
  "job-stack-grant-inactive": "The selected grant is no longer active. Select a current grant.",
  "operation-denied": "Workspace authority ended. Select a current grant.",
};

function writeFailure(status: number, code: string | null): ApiError {
  const known = code ? WRITE_MESSAGES[code] : undefined;
  if (known) return new ApiError(known, status, code);
  if (status === 401 || status === 403)
    return new ApiError("Workspace authority ended. Select a current grant.", status, code);
  if (status === 409)
    return new ApiError("The record changed since it was loaded. Reload it and try again.", status, code);
  if (status === 413) return new ApiError(WRITE_MESSAGES["body-too-large"] ?? "", status, code);
  if (status === 415) return new ApiError("The server did not accept the request format.", status, code);
  if (status === 501) return new ApiError(WRITE_MESSAGES["operation-unavailable"] ?? "", status, code);
  if (status >= 400 && status < 500) return new ApiError("The server rejected this change.", status, code);
  return new ApiError(UNKNOWN_OUTCOME, status, code);
}

/** Control accepts at most 64 KiB of write body, below the catalog's general input limit. */
export const CONTROL_WRITE_BODY_BYTES = 65536;

/** One write attempt: a fresh one-use nonce bound to POST and the exact query-free target. */
async function postWithFreshNonce(
  target: string,
  bytes: Uint8Array<ArrayBuffer>,
  selection: { grantId: string; signal?: AbortSignal },
): Promise<Response> {
  const access = "Workspace access unavailable. Select a current grant.";
  let nonceResponse: Response;
  try {
    nonceResponse = await fetch(
      "/owner/job-stack/api/nonce?" + new URLSearchParams({ grant: selection.grantId, method: "POST", target }),
      { signal: selection.signal, cache: "no-store" },
    );
  } catch {
    selection.signal?.throwIfAborted();
    throw new ApiError(access, null, "network");
  }
  if (!nonceResponse.ok)
    throw new ApiError(access, nonceResponse.status, await errorCode(nonceResponse, selection.signal));
  let nonce: string;
  try {
    nonce = z
      .object({ nonce: z.string().min(1) })
      .strict()
      .parse(await responseJson(nonceResponse, 4096, selection.signal)).nonce;
  } catch {
    selection.signal?.throwIfAborted();
    throw new ApiError(access, nonceResponse.status, "invalid-response");
  }
  selection.signal?.throwIfAborted();
  try {
    return await fetch(target + "?" + new URLSearchParams({ grant: selection.grantId }), {
      method: "POST",
      headers: { "content-type": "application/json", "x-owner-nonce": nonce },
      body: bytes,
      signal: selection.signal,
      cache: "no-store",
    });
  } catch {
    selection.signal?.throwIfAborted();
    // The request may have reached the server: the outcome is ambiguous, never assumed failed.
    throw new ApiError(UNKNOWN_OUTCOME, null, "network");
  }
}

/**
 * The only write path. It accepts catalog local-write domain operations, requires a request key,
 * validates the complete input against the catalog schema (so undeclared fields are never sent),
 * enforces the operation's input byte limit before any network effect and bounds the response to
 * the operation's output limit.
 */
export async function mutate(
  name: string,
  input: WriteInput,
  selection: { grantId: string; signal?: AbortSignal },
): Promise<DomainWriteOutput> {
  const operation = writeOperation(name);
  if (!operation || !selection.grantId)
    throw new ApiError("Write operation unavailable", null, "operation-unavailable");
  if (typeof input.requestKey !== "string" || !REQUEST_KEY.test(input.requestKey))
    throw new ApiError("A request key is required for every change", null, "request-key-required");
  let validated: unknown;
  try {
    validated = validateCoreInput(operation.id as CoreOperationId, input);
  } catch {
    throw new ApiError("The change does not match the operation schema", null, "invalid-input");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(validated));
  if (bytes.byteLength > Math.min(operation.maxInputBytes, CONTROL_WRITE_BODY_BYTES))
    throw new ApiError("The change exceeds the operation size limit", null, "input-too-large");
  selection.signal?.throwIfAborted();
  const target = "/owner/job-stack/api/operations/" + name;
  let response = await postWithFreshNonce(target, bytes, selection);
  // A rejected one-use nonce is retried once with a fresh nonce and the same request key.
  if (response.status === 403) {
    const code = await errorCode(response, selection.signal);
    if (code !== "invalid-owner-request") throw writeFailure(403, code);
    response = await postWithFreshNonce(target, bytes, selection);
  }
  if (!response.ok) throw writeFailure(response.status, await errorCode(response, selection.signal));
  let result: unknown;
  try {
    result = await responseJson(response, operation.maxOutputBytes, selection.signal);
  } catch (error) {
    selection.signal?.throwIfAborted();
    throw new ApiError(
      (error instanceof Error ? error.message : "Workspace response is invalid") + ". The outcome is unknown; retrying reuses the same request key.",
      response.status,
      "invalid-response",
    );
  }
  selection.signal?.throwIfAborted();
  try {
    return validateCoreOutput(operation.id as "job-stack.opportunity.transition.v1", result, {
      grantId: selection.grantId,
    });
  } catch {
    // A 200 whose body fails the catalog output schema: the change may have been applied.
    throw new ApiError(WRITE_MESSAGES["invalid-product-response"] ?? UNKNOWN_OUTCOME, response.status, "invalid-product-response");
  }
}

export function label(value: unknown): string {
  if (value === null || value === undefined) return "Unknown";
  if (typeof value === "string") return value.replaceAll("_", " ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export type ReadProtection = OutputById["job-stack.protection.read.v1"];
export type ProtectionState =
  | { status: "available"; view: ReadProtection }
  | { status: "loading"; versionId: string };
export type ReadSession = OutputById["job-stack.session.read.v1"];
export type PipelinePage = OutputById["job-stack.pipeline.page.read.v1"];
export type PipelineSummary = Extract<
  PipelinePage,
  { status: "available" }
>["items"][number];
export type ReadRecord = NonNullable<
  Extract<
    OutputById["job-stack.records.read.v1"],
    { record: unknown }
  >["record"]
>;
export type ReadSummary = Extract<
  OutputById["job-stack.records.read.v1"],
  { items: unknown }
>["items"][number];
export type RecordPage = { items: readonly ReadSummary[]; nextCursor: string | null };
export type VersionList = OutputById["job-stack.version.list.v1"];
export type VersionSummary = VersionList["items"][number];
export type VersionManifest = OutputById["job-stack.version.read.v1"];
export type RequestResult = OutputById["job-stack.request.read.v1"];
export function objectFields(value: unknown): Record<string, unknown> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  return parsed.success ? parsed.data : {};
}
export function createReadClient(grantId: string, signal?: AbortSignal) {
  const selection = { grantId, signal };
  async function records(query: Record<string, string>) {
    return validateCoreOutput(
      "job-stack.records.read.v1",
      await request(
        "/api/operations/job_stack_records?" + new URLSearchParams(query),
        undefined,
        selection,
      ),
    );
  }
  return {
    async session() {
      return validateCoreOutput(
        "job-stack.session.read.v1",
        await request(
          "/api/operations/job_stack_session",
          undefined,
          selection,
        ),
      );
    },
    async page(kind: string, cursor: string | null): Promise<RecordPage> {
      const result = await records({ kind, ...(cursor ? { cursor } : {}) });
      if (result.items === undefined || result.nextCursor === undefined)
        throw Error("Invalid record page");
      if (result.items.some((item) => item.kind !== kind)) throw Error("Record page kind mismatch");
      return { items: result.items, nextCursor: result.nextCursor };
    },
    async profile(cursor: string | null): Promise<RecordPage> {
      return validateCoreOutput(
        "job-stack.profile.read.v1",
        await request(
          "/api/operations/job_stack_profile?" + new URLSearchParams(cursor ? { cursor } : {}),
          undefined,
          selection,
        ),
      );
    },
    async pipelinePage(view: "relationships" | "all", cursor: string | null) {
      const result = validateCoreOutput(
        "job-stack.pipeline.page.read.v1",
        await request(
          "/api/operations/job_stack_pipeline_page?" +
            new URLSearchParams({ view, ...(cursor ? { cursor } : {}) }),
          undefined,
          selection,
        ),
      );
      if (result.view !== view) throw Error("Pipeline view mismatch");
      if (result.status === "available") {
        const ids = result.items.map((row) => row.entityId);
        const total =
          view === "all"
            ? result.totalObservations
            : result.historicalRelationships;
        if (
          new Set(ids).size !== ids.length ||
          result.historicalRelationships > result.totalObservations ||
          result.range.end > total ||
          (ids.length
            ? result.range.start < 1 ||
              result.range.end - result.range.start + 1 !== ids.length
            : result.range.start !== 0 ||
              result.range.end !== 0 ||
              total !== 0) ||
          (view === "relationships" &&
            result.items.some((row) => !row.inPipeline)) ||
          (result.nextCursor !== null &&
            (!ids.length ||
              result.nextCursor === cursor ||
              result.range.end >= total)) ||
          (result.nextCursor === null && result.range.end !== total)
        )
          throw Error("Invalid pipeline page");
      }
      return result;
    },
    async detail(kind: string, entityId: string) {
      const result = await records({ kind, entityId });
      if (result.record === undefined) throw Error("Invalid record detail");
      if (result.record !== null && (result.record.kind !== kind || result.record.entityId !== entityId)) throw Error("Record detail identity mismatch");
      return result.record;
    },
    async versions(lineageId: string, cursor: string | null) {
      return validateCoreOutput(
        "job-stack.version.list.v1",
        await request(
          "/api/operations/job_stack_versions?" +
            new URLSearchParams({ lineageId, ...(cursor ? { cursor } : {}) }),
          undefined,
          selection,
        ),
      );
    },
    async protection(versionId: string) {
      const result = validateCoreOutput(
        "job-stack.protection.read.v1",
        await request(
          "/api/operations/job_stack_protection?" +
            new URLSearchParams({ versionId }),
          undefined,
          selection,
        ),
      );
      if (result.versionId !== versionId)
        throw Error("Protection identity mismatch");
      return result;
    },
    async version(versionId: string) {
      return validateCoreOutput(
        "job-stack.version.read.v1",
        await request(
          "/api/operations/job_stack_version?" +
            new URLSearchParams({ versionId }),
          undefined,
          selection,
        ),
      );
    },
    /** Raw bounded recovery-status JSON; lib/recoveryStatus validates recovery-status-v1. */
    async recoveryStatus(workspaceId: string): Promise<unknown> {
      return readRecoveryStatus(workspaceId, selection);
    },
    async requestResult(requestKey: string): Promise<RequestResult> {
      return validateCoreOutput(
        "job-stack.request.read.v1",
        await request(
          "/api/operations/job_stack_request?" + new URLSearchParams({ requestKey }),
          undefined,
          selection,
        ),
      );
    },
  };
}
export type ReadClient = ReturnType<typeof createReadClient>;
