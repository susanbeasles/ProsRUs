import { z } from "zod";
const row = z.object({
  id: z.string(),
  body: z.unknown(),
  revision: z.number(),
  updatedAt: z.number(),
});
export type Row = z.infer<typeof row>;
export const snapshotSchema = z.object({
  claim: z.array(row),
  opportunity: z.array(row),
  packet: z.array(row),
  thread: z.array(row),
  interview: z.array(row),
  offer: z.array(row),
  artifact: z.array(row),
  connection: z.array(row),
  reminder: z.array(row),
  prep: z.array(row),
  question: z.array(row),
  settings: z.object({
    value: z.record(z.string(), z.unknown()),
    revision: z.number(),
  }),
  activity: z.array(z.record(z.string(), z.unknown())),
  intents: z.array(z.record(z.string(), z.unknown())),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export async function request(
  path: string,
  body?: unknown,
  selection?: { grantId: string; signal?: AbortSignal },
) {
  if (
    body !== undefined ||
    !selection?.grantId ||
    !/^\/api\/operations\/job_stack_(session|records|version|versions|request|protection)(?:\?|$)/.test(
      path,
    )
  )
    throw Error("Read-only workspace selection required");
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
    throw Error("Workspace access unavailable. Select a current grant.");
  const { nonce } = z
    .object({ nonce: z.string().min(1) })
    .strict()
    .parse(await nonceResponse.json());
  selection.signal?.throwIfAborted();
  target.searchParams.set("grant", selection.grantId);
  const response = await fetch(target.pathname + target.search, {
    headers: { "x-owner-nonce": nonce },
    signal: selection.signal,
    cache: "no-store",
  });
  if (!response.ok)
    throw Error(
      "Workspace read denied or unavailable. Refresh your selection.",
    );
  const result: unknown = await response.json();
  selection.signal?.throwIfAborted();
  return result;
}
export function fields(row: Row): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(row.body);
}
export function label(value: unknown): string {
  if (value === null || value === undefined) return "Unknown";
  if (typeof value === "string") return value.replaceAll("_", " ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export { validateCoreOutput } from "../integration/shared-contract.mjs";
import {
  validateCoreOutput,
  type OutputById,
} from "../integration/shared-contract.mjs";
export type ReadProtection = OutputById["job-stack.protection.read.v1"];
export type ProtectionState =
  | { status: "available"; view: ReadProtection }
  | { status: "loading"; versionId: string };
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
    async page(kind: string, cursor: string | null) {
      const result = await records({ kind, ...(cursor ? { cursor } : {}) });
      if (result.items === undefined || result.nextCursor === undefined)
        throw Error("Invalid record page");
      return { items: result.items, nextCursor: result.nextCursor };
    },
    async detail(kind: string, entityId: string) {
      const result = await records({ kind, entityId });
      if (result.record === undefined) throw Error("Invalid record detail");
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
  };
}
