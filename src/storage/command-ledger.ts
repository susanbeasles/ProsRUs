import { z } from "zod";
import { DomainError, demand, id } from "../domain/model";
import type { LedgerEntry } from "../domain/command-policy";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const MAX_ROOT_BYTES = 1_900_000;
const MAX_RESULT_BYTES = 131_072;
const encoder = new TextEncoder();
const rowSchema = z.object({
  operation_id: z.string().min(1).max(100),
  input_digest: digest,
  state: z.enum(["pending", "committed"]),
  root_revision: z.number().int().nonnegative(),
  result: z.string().nullable(),
});
export type LedgerRow = LedgerEntry &
  Readonly<{ rootRevision: number; result: unknown }>;
export type RetainedRoot = Readonly<{ root: unknown; revision: number }>;
export const commandAuditDecisions = [
  "allow",
  "replay",
  "deny",
  "conflict",
] as const;
export type CommandAuditEvent = Readonly<{
  eventId: string;
  invocationId: string;
  operationId: string;
  requestKey: string | null;
  inputDigest: string;
  entrypoint: "owner" | "mcp";
  principalId: string;
  grantId: string;
  grantRevision: number;
  stage: string;
  decision: (typeof commandAuditDecisions)[number];
  reason: string;
  createdAt: number;
}>;
function encode(value: unknown, limit: number, code: string): string {
  const text = JSON.stringify(value);
  demand(
    typeof text === "string" && encoder.encode(text).byteLength <= limit,
    code,
    413,
  );
  return text;
}
function changes(result: D1Result): number {
  return Number(result.meta?.changes ?? 0);
}

/** One owner/workspace's durable request ledger and decision audit. Every
 * statement is scoped by the trusted owner/workspace from current authority. */
export function createCommandLedger(
  db: D1Database,
  owner: string,
  workspaceId: string,
) {
  id.parse(owner);
  id.parse(workspaceId);
  const scope = "owner=? AND workspace_id=? AND request_key=?";
  async function find(requestKey: string): Promise<LedgerRow | null> {
    id.parse(requestKey);
    const raw = await db
      .prepare(
        `SELECT operation_id,input_digest,state,root_revision,result FROM command_requests WHERE ${scope}`,
      )
      .bind(owner, workspaceId, requestKey)
      .first();
    if (raw === null) return null;
    const row = rowSchema.parse(raw);
    return {
      operationId: row.operation_id,
      inputDigest: row.input_digest,
      state: row.state,
      rootRevision: row.root_revision,
      result: row.result === null ? null : JSON.parse(row.result),
    };
  }
  /** Insert a pending row unless one exists, then return the stored identity. */
  async function begin(
    input: Readonly<{
      requestKey: string;
      operationId: string;
      inputDigest: string;
      now: number;
    }>,
  ): Promise<LedgerRow> {
    id.parse(input.requestKey);
    digest.parse(input.inputDigest);
    time.parse(input.now);
    const insert = db
      .prepare(
        `INSERT INTO command_requests(owner,workspace_id,request_key,operation_id,input_digest,state,root,root_revision,result,created_at,updated_at) SELECT ?,?,?,?,?,'pending',NULL,0,NULL,?,? WHERE NOT EXISTS(SELECT 1 FROM command_requests WHERE ${scope})`,
      )
      .bind(
        owner,
        workspaceId,
        input.requestKey,
        input.operationId,
        input.inputDigest,
        input.now,
        input.now,
        owner,
        workspaceId,
        input.requestKey,
      );
    try {
      await insert.run();
    } catch (error) {
      // A concurrent first insert wins; its stored identity is decided below.
      if ((await find(input.requestKey)) === null) throw error;
    }
    const row = await find(input.requestKey);
    demand(row, "COMMAND_LEDGER_UNAVAILABLE", 503);
    return row;
  }
  async function loadRoot(
    requestKey: string,
    inputDigest: string,
  ): Promise<RetainedRoot | null> {
    const raw = await db
      .prepare(
        `SELECT root,root_revision FROM command_requests WHERE ${scope} AND input_digest=? AND state='pending'`,
      )
      .bind(owner, workspaceId, requestKey, inputDigest)
      .first();
    if (raw === null) return null;
    const row = z
      .object({
        root: z.string().nullable(),
        root_revision: z.number().int().nonnegative(),
      })
      .parse(raw);
    return row.root === null
      ? null
      : { root: JSON.parse(row.root), revision: row.root_revision };
  }
  /** Compare-and-set of the retained lifecycle root on a pending row. */
  async function retainRoot(
    input: Readonly<{
      requestKey: string;
      inputDigest: string;
      expectedRevision: number;
      root: unknown;
      now: number;
    }>,
  ): Promise<number> {
    const text = encode(input.root, MAX_ROOT_BYTES, "COMMAND_ROOT_TOO_LARGE");
    const outcome = await db
      .prepare(
        `UPDATE command_requests SET root=?,root_revision=root_revision+1,updated_at=max(updated_at,?) WHERE ${scope} AND input_digest=? AND state='pending' AND root_revision=?`,
      )
      .bind(
        text,
        input.now,
        owner,
        workspaceId,
        input.requestKey,
        input.inputDigest,
        input.expectedRevision,
      )
      .run();
    if (changes(outcome) !== 1)
      throw new DomainError("COMMAND_ROOT_CONFLICT", 409);
    return input.expectedRevision + 1;
  }
  /** With `released`, the row is written only if the ledger row holds exactly
   * that committed result (checked inside the same batch). */
  function auditStatement(
    event: CommandAuditEvent,
    released?: Readonly<{ requestKey: string; inputDigest: string; text: string }>,
  ) {
    const guard = released
      ? ` WHERE EXISTS(SELECT 1 FROM command_requests WHERE ${scope} AND input_digest=? AND state='committed' AND result=?)`
      : "";
    return db
      .prepare(
        `INSERT INTO command_audit(owner,workspace_id,event_id,invocation_id,operation_id,request_key,input_digest,entrypoint,principal_id,grant_id,grant_revision,stage,decision,reason,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?${guard}`,
      )
      .bind(
        owner,
        workspaceId,
        id.parse(event.eventId),
        id.parse(event.invocationId),
        event.operationId,
        event.requestKey,
        digest.parse(event.inputDigest),
        z.enum(["owner", "mcp"]).parse(event.entrypoint),
        event.principalId,
        event.grantId,
        event.grantRevision,
        event.stage,
        z.enum(commandAuditDecisions).parse(event.decision),
        z
          .string()
          .regex(/^[A-Za-z0-9_.-]{1,80}$/)
          .parse(event.reason),
        time.parse(event.createdAt),
        ...(released
          ? [
              owner,
              workspaceId,
              released.requestKey,
              released.inputDigest,
              released.text,
            ]
          : []),
      );
  }
  /** Record the released result and its allow decision in one D1 batch.
   * Pending -> committed only; a committed row is never rewound. */
  async function commit(
    input: Readonly<{
      requestKey: string;
      inputDigest: string;
      result: unknown;
      now: number;
      audit: CommandAuditEvent;
    }>,
  ): Promise<void> {
    const text = encode(
      input.result,
      MAX_RESULT_BYTES,
      "COMMAND_RESULT_TOO_LARGE",
    );
    const [outcome] = await db.batch([
      db
        .prepare(
          `UPDATE command_requests SET state='committed',root=NULL,result=?,updated_at=max(updated_at,?) WHERE ${scope} AND input_digest=? AND state='pending'`,
        )
        .bind(
          text,
          input.now,
          owner,
          workspaceId,
          input.requestKey,
          input.inputDigest,
        ),
      auditStatement(input.audit, {
        requestKey: input.requestKey,
        inputDigest: input.inputDigest,
        text,
      }),
    ]);
    if (outcome && changes(outcome) === 1) return;
    const row = await find(input.requestKey);
    demand(
      row?.state === "committed" &&
        row.inputDigest === input.inputDigest &&
        JSON.stringify(row.result) === text,
      "COMMAND_LEDGER_CONFLICT",
      409,
    );
  }
  async function audit(event: CommandAuditEvent): Promise<void> {
    await auditStatement(event).run();
  }
  return { find, begin, loadRoot, retainRoot, commit, audit };
}
export type CommandLedger = ReturnType<typeof createCommandLedger>;
