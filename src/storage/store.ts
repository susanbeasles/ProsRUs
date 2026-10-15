import { z } from "zod";
import { demand } from "../domain/model";
export const kinds = [
  "claim",
  "opportunity",
  "packet",
  "thread",
  "interview",
  "offer",
  "artifact",
  "connection",
  "reminder",
  "settings",
  "attempt",
  "prep",
  "question",
] as const;
export type Kind = (typeof kinds)[number];
const rowSchema = z.object({
  id: z.string(),
  body: z.string(),
  revision: z.number(),
  updated_at: z.number(),
});
export type RecordValue = {
  id: string;
  body: unknown;
  revision: number;
  updatedAt: number;
};
export type Intent = {
  id: string;
  kind: string;
  digest: string;
  payload: string;
  state: string;
  receipt: string | null;
  failure: string | null;
  attempts: number;
  updated_at: number;
};
export function createStore(db: D1Database, owner: string) {
  function query(sql: string, ...values: unknown[]) {
    return db.prepare(sql).bind(...values);
  }
  function recordStatement(kind: Kind, id: string, body: unknown, now: number) {
    return query(
      "INSERT INTO records(owner,kind,id,body,revision,updated_at) VALUES(?,?,?,?,1,?)",
      owner,
      kind,
      id,
      JSON.stringify(body),
      now,
    );
  }
  async function get(kind: Kind, id: string): Promise<RecordValue | null> {
    const raw = await query(
      "SELECT id,body,revision,updated_at FROM records WHERE owner=? AND kind=? AND id=?",
      owner,
      kind,
      id,
    ).first();
    if (!raw) return null;
    const row = rowSchema.parse(raw);
    return {
      id: row.id,
      body: JSON.parse(row.body),
      revision: row.revision,
      updatedAt: row.updated_at,
    };
  }
  async function list(kind: Kind): Promise<RecordValue[]> {
    const { results } = await query(
      "SELECT id,body,revision,updated_at FROM records WHERE owner=? AND kind=? ORDER BY updated_at DESC LIMIT 500",
      owner,
      kind,
    ).all();
    return results.map((raw) => {
      const row = rowSchema.parse(raw);
      return {
        id: row.id,
        body: JSON.parse(row.body),
        revision: row.revision,
        updatedAt: row.updated_at,
      };
    });
  }
  function auditStatement(
    actor: string,
    operation: string,
    objectId: string,
    decision: string,
    now: number,
  ) {
    return query(
      "INSERT INTO audit(id,owner,actor,operation,object_id,decision,created_at) VALUES(?,?,?,?,?,?,?)",
      crypto.randomUUID(),
      owner,
      actor,
      operation,
      objectId,
      decision,
      now,
    );
  }
  async function add(
    kind: Kind,
    id: string,
    body: unknown,
    actor: string,
    now: number,
  ) {
    await db.batch([
      recordStatement(kind, id, body, now),
      auditStatement(actor, `${kind}.created`, id, "allow", now),
    ]);
    return get(kind, id);
  }
  async function update(
    kind: Kind,
    id: string,
    body: unknown,
    revision: number,
    actor: string,
    now: number,
  ) {
    const r = await query(
      "UPDATE records SET body=?,revision=revision+1,updated_at=? WHERE owner=? AND kind=? AND id=? AND revision=?",
      JSON.stringify(body),
      now,
      owner,
      kind,
      id,
      revision,
    ).run();
    demand(r.meta.changes === 1, "REVISION_CONFLICT", 409);
    await audit(actor, `${kind}.updated`, id, "allow", now);
    return get(kind, id);
  }
  async function audit(
    actor: string,
    operation: string,
    objectId: string,
    decision: string,
    now: number,
  ) {
    await auditStatement(actor, operation, objectId, decision, now).run();
  }
  async function ingest(
    key: string,
    id: string,
    body: unknown,
    actor: string,
    now: number,
  ) {
    await db.batch([
      query(
        "INSERT OR IGNORE INTO source_keys(owner,source_key,opportunity_id) VALUES(?,?,?)",
        owner,
        key,
        id,
      ),
      query(
        "INSERT OR IGNORE INTO records(owner,kind,id,body,revision,updated_at) SELECT ?,'opportunity',?,?,1,? WHERE EXISTS(SELECT 1 FROM source_keys WHERE owner=? AND source_key=? AND opportunity_id=?)",
        owner,
        id,
        JSON.stringify(body),
        now,
        owner,
        key,
        id,
      ),
    ]);
    const saved = await query(
      "SELECT opportunity_id FROM source_keys WHERE owner=? AND source_key=?",
      owner,
      key,
    ).first<{ opportunity_id: string }>();
    demand(saved, "PERSISTENCE_FAILURE", 500);
    await audit(
      actor,
      "opportunity.ingested",
      saved.opportunity_id,
      "allow",
      now,
    );
    return get("opportunity", saved.opportunity_id);
  }
  async function intent(id: string): Promise<Intent | null> {
    return query(
      "SELECT id,kind,digest,payload,state,receipt,failure,attempts,updated_at FROM intents WHERE owner=? AND id=?",
      owner,
      id,
    ).first<Intent>();
  }
  async function reserveIntent(input: {
    id: string;
    kind: string;
    digest: string;
    payload: unknown;
    now: number;
  }) {
    if (input.kind === "send") {
      const payload = z.object({ threadId: z.string() }).parse(input.payload);
      const unresolved = await query(
        "SELECT id FROM intents WHERE owner=? AND kind='send' AND json_extract(payload,'$.threadId')=? AND state IN ('pending','running','ambiguous') AND digest<>? LIMIT 1",
        owner,
        payload.threadId,
        input.digest,
      ).first();
      demand(!unresolved, "UNRESOLVED_PRIOR_SEND", 409);
    }
    await query(
      "INSERT OR IGNORE INTO intents(owner,id,kind,digest,payload,state,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)",
      owner,
      input.id,
      input.kind,
      input.digest,
      JSON.stringify(input.payload),
      input.now,
      input.now,
    ).run();
    const saved =
      (await intent(input.id)) ??
      (await query(
        "SELECT id,kind,digest,payload,state,receipt,failure,attempts,updated_at FROM intents WHERE owner=? AND kind=? AND digest=?",
        owner,
        input.kind,
        input.digest,
      ).first<Intent>());
    demand(
      saved?.digest === input.digest && saved.kind === input.kind,
      "IDEMPOTENCY_CONFLICT",
      409,
    );
    return saved;
  }
  async function claimIntent(id: string, now: number) {
    const r = await query(
      "UPDATE intents SET state='running',attempts=attempts+1,updated_at=? WHERE owner=? AND id=? AND (state='pending' OR (receipt IS NOT NULL AND state<>'succeeded'))",
      now,
      owner,
      id,
    ).run();
    return r.meta.changes === 1;
  }
  async function finishIntent(
    id: string,
    state: "succeeded" | "ambiguous" | "blocked" | "failed",
    now: number,
    receipt: string | null = null,
    failure: string | null = null,
  ) {
    await query(
      "UPDATE intents SET state=?,receipt=COALESCE(?,receipt),failure=?,updated_at=? WHERE owner=? AND id=? AND state='running'",
      state,
      receipt,
      failure,
      now,
      owner,
      id,
    ).run();
  }
  return {
    get,
    list,
    add,
    update,
    ingest,
    audit,
    intent,
    reserveIntent,
    claimIntent,
    finishIntent,
    async saveReceipt(id: string, receipt: string, now: number) {
      await query(
        "UPDATE intents SET receipt=?,updated_at=? WHERE owner=? AND id=?",
        receipt,
        now,
        owner,
        id,
      ).run();
    },
    async retryIntent(id: string, now: number) {
      await query(
        "UPDATE intents SET state='pending',updated_at=? WHERE owner=? AND id=? AND state='running'",
        now,
        owner,
        id,
      ).run();
    },
    async auditLog() {
      return (
        await query(
          "SELECT actor,operation,object_id,decision,created_at FROM audit WHERE owner=? ORDER BY created_at DESC LIMIT 200",
          owner,
        ).all()
      ).results;
    },
    async intents() {
      return (
        await query(
          "SELECT id,kind,state,receipt,failure,attempts,updated_at FROM intents WHERE owner=? ORDER BY created_at DESC LIMIT 200",
          owner,
        ).all()
      ).results;
    },
    async pending() {
      return (
        await query(
          "SELECT id FROM intents WHERE owner=? AND state='pending' ORDER BY created_at LIMIT 50",
          owner,
        ).all<{ id: string }>()
      ).results;
    },
    async markStale(now: number) {
      await query(
        "UPDATE intents SET state='ambiguous',failure='Interrupted action; reconcile before retry',updated_at=? WHERE owner=? AND state='running' AND updated_at<?",
        now,
        owner,
        now - 600000,
      ).run();
    },
    async reserveRun(key: string, now: number) {
      const r = await query(
        "INSERT OR IGNORE INTO runs(owner,run_key,status,updated_at) VALUES(?,?,'queued',?)",
        owner,
        key,
        now,
      ).run();
      return r.meta.changes === 1;
    },
    async finishRun(key: string, status: string, now: number) {
      await query(
        "UPDATE runs SET status=?,updated_at=? WHERE owner=? AND run_key=?",
        status,
        now,
        owner,
        key,
      ).run();
    },
  };
}
export type Store = ReturnType<typeof createStore>;
