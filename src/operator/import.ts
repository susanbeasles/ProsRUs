import {
  planAuditedImport,
  type AuditedImportPlan,
} from "../application/audited-legacy-import";
import {
  parseAuditedSourceProfile,
  type CheckedAuditedSourceProfile,
} from "../application/audited-source-profile";
import {
  pendingChunks,
  pendingHeaderStatement,
  pendingSourcesStatement,
  pendingRecordsStatement,
  pendingClockStatement,
  pendingWriteStatements,
  observeOperatorPending,
  type PendingSql,
  type PendingDatabase,
  type PendingStatement,
} from "../storage/audited-pending-observation";
import {
  OPERATOR_LIMITS as L,
  PROTOCOL,
  demandOperator as demand,
  stable,
  sha256,
  utf8,
  parseRequest,
  checkedResponse,
  requestFrame,
  type Effect,
} from "./protocol";
type Original = {
  name: string;
  key: string;
  sha256: string;
  sizeBytes: number;
};
export type OperatorApproval = {
  format: "job-stack.operator-approval.v1";
  mode: "import" | "reconcile";
  actionId: string;
  accountId: string;
  databaseId: string;
  bucket: string;
  namespace: string;
  namespaceExclusive: true;
  window: Readonly<{ nowMs: number; expiresAtMs: number }>;
  sourceClosureSha256: string;
  profileSha256: string;
  planSha256: string;
  sources: Original[];
};
function required<T>(value: T | undefined | null): T {
  demand(value !== undefined && value !== null);
  return value;
}
function at<T>(items: readonly T[], index: number): T {
  return required(items[index]);
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const shape = (v: unknown, fields: string): v is Record<string, unknown> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(",") === fields;
// Exact private keys use bounded unambiguous path segments; never normalize or rename.
function safeKey(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8(value) <= 1024 &&
    value
      .split("/")
      .every(
        (part) =>
          /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..",
      )
  );
}
function frozen<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) frozen(x);
    Object.freeze(v);
  }
  return v;
}
function b64(source: AuditedImportPlan["sources"][number]) {
  return Buffer.from(source.rawUtf8, "utf8").toString("base64");
}
const queries = (
  kind: Effect["kind"],
  databaseId: string,
  statements: PendingSql[],
): Effect => ({ kind, payload: { databaseId, statements } });
/** Static parent-owned connector template. Binary/atomic/API compatibility is UNQUALIFIED until separately probed. */
export function connectorEnvelope(approval: OperatorApproval, effect: Effect) {
  demand(effect.kind !== "current" && effect.kind !== "done");
  const p = effect.payload as {
    key: string;
    base64: string;
    statements: PendingSql[];
  };
  let request: Record<string, unknown>;
  if (effect.kind.startsWith("d1."))
    request = {
      method: "POST",
      path: `/accounts/${approval.accountId}/d1/database/${approval.databaseId}/query`,
      body: { batch: p.statements },
    };
  else
    request = {
      method: effect.kind === "r2.put" ? "PUT" : "GET",
      path: `/accounts/${approval.accountId}/r2/buckets/${approval.bucket}/objects/${p.key.split("/").map(encodeURIComponent).join("/")}`,
      ...(effect.kind === "r2.put"
        ? {
            bodyBase64: p.base64,
            rawBody: true,
            contentType: "application/json",
          }
        : {}),
    };
  const code = `async () => { const request=${stable(request)}; const kind=${JSON.stringify(effect.kind)}; const count=${p.statements?.length ?? 0}; if(kind==='r2.put'){request.body=Uint8Array.from(atob(request.bodyBase64),c=>c.charCodeAt(0));delete request.bodyBase64;} const response=await cloudflare.request(request); if(kind==='r2.get'&&response.status===404)return null; if(!response.success)throw Error('operator-provider-failed'); let result; if(kind.startsWith('d1.')){if(!Array.isArray(response.result)||response.result.length!==count||response.result.some(r=>r.success!==true||!Array.isArray(r.results)))throw Error('operator-result-order');result=kind==='d1.batch'?{statements:count}:{rows:response.result[0].results};}else if(kind==='r2.put')result={written:true};else{const r=response.result;if(!r||Object.keys(r).sort().join(',')!=='base64'||typeof r.base64!=='string')throw Error('operator-binary-unqualified');result={base64:r.base64};} if(new TextEncoder().encode(JSON.stringify(result)).length>${L.response})throw Error('operator-result-bound');return result; }`;
  const args = { account_id: approval.accountId, code };
  return {
    args,
    codeBytes: utf8(code),
    argumentBytes: utf8(JSON.stringify(args)),
  };
}
export function prepareOperatorInput({
  plan: input,
  profile: supplied,
  approval: source,
}: {
  plan: AuditedImportPlan;
  profile: CheckedAuditedSourceProfile;
  approval: OperatorApproval;
}) {
  demand(
    source &&
      Object.isFrozen(source.window) &&
      shape(
        source,
        "accountId,actionId,bucket,databaseId,format,mode,namespace,namespaceExclusive,planSha256,profileSha256,sourceClosureSha256,sources,window",
      ),
    "operator-approval",
  );
  demand(
    source.format === "job-stack.operator-approval.v1" &&
      ["import", "reconcile"].includes(source.mode) &&
      /^[A-Za-z0-9_-]{1,100}$/.test(source.actionId) &&
      /^[a-f0-9]{32}$/.test(source.accountId) &&
      /^[a-f0-9-]{36}$/.test(source.databaseId) &&
      /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(source.bucket) &&
      typeof source.namespace === "string" &&
      source.namespace.endsWith("/") &&
      safeKey(source.namespace.slice(0, -1)) &&
      source.namespaceExclusive === true,
    "operator-approval",
  );
  demand(
    shape(source.window, "expiresAtMs,nowMs") &&
      Number.isSafeInteger(source.window.nowMs) &&
      source.window.nowMs >= 0 &&
      Number.isSafeInteger(source.window.expiresAtMs) &&
      source.window.expiresAtMs > source.window.nowMs,
    "operator-window",
  );
  demand(
    [source.sourceClosureSha256, source.profileSha256, source.planSha256].every(
      (h) => /^[a-f0-9]{64}$/.test(h),
    ),
    "operator-identity",
  );
  demand(
    utf8(JSON.stringify(input)) <= L.plan &&
      utf8(JSON.stringify(supplied)) <= L.profile,
    "operator-input-bound",
  );
  demand(
    sha256(JSON.stringify(input)) === source.planSha256 &&
      sha256(JSON.stringify(supplied)) === source.profileSha256,
    "operator-input-identity",
  );
  const profile = parseAuditedSourceProfile(supplied),
    plan = planAuditedImport(
      {
        sources: input.sources.map((s) => ({
          name: s.name,
          bytes: Buffer.from(s.rawUtf8, "utf8"),
          receipt: s.sourceReceipt,
        })),
        workspace: input.workspace,
        seriesId: input.seriesId,
        observedAt: input.receipt.importObservedAt,
      },
      profile,
    );
  demand(
    JSON.stringify(plan) === JSON.stringify(input),
    "operator-plan-mismatch",
  );
  const chunks = pendingChunks(plan);
  demand(
    plan.sources.length <= L.sources &&
      plan.records.length <= L.roles &&
      chunks.chunks.length <= L.chunks &&
      chunks.budget <= L.sql &&
      source.sources.length === plan.sources.length,
    "operator-plan-bound",
  );
  let total = 0;
  const keys = new Set<string>();
  for (let i = 0; i < source.sources.length; i++) {
    const selected = at(source.sources, i),
      original = at(plan.sources, i);
    demand(
      shape(selected, "key,name,sha256,sizeBytes") &&
        selected.name === original.name &&
        selected.sha256 === original.rawSha256 &&
        selected.sizeBytes === original.sizeBytes &&
        selected.sizeBytes <= L.original &&
        safeKey(selected.key) &&
        selected.key.startsWith(source.namespace) &&
        !keys.has(selected.key),
      "operator-source-identity",
    );
    keys.add(selected.key);
    total += selected.sizeBytes;
  }
  demand(total <= L.sourceTotal);
  const approval = frozen(copy(source)),
    actionDigest = sha256(stable(approval)),
    databaseId = approval.databaseId;
  const originals = plan.sources.map((original, i) => ({
    get: {
      kind: "r2.get",
      payload: { bucket: approval.bucket, key: at(approval.sources, i).key },
    } as Effect,
    put: {
      kind: "r2.put",
      payload: {
        bucket: approval.bucket,
        key: at(approval.sources, i).key,
        base64: b64(original),
      },
    } as Effect,
  }));
  const effects = {
    custody: originals,
    header: queries("d1.first", databaseId, [pendingHeaderStatement(plan)]),
    batch: queries(
      "d1.batch",
      databaseId,
      pendingWriteStatements(plan, approval.window, true),
    ),
    sources: queries("d1.all", databaseId, [pendingSourcesStatement(plan)]),
    records: chunks.chunks.map((chunk) =>
      queries("d1.all", databaseId, [pendingRecordsStatement(plan, chunk.ids)]),
    ),
    clock: queries("d1.first", databaseId, [pendingClockStatement()]),
  };
  const batchBytes = utf8(
    JSON.stringify({
      batch: (effects.batch.payload as { statements: PendingSql[] }).statements,
    }),
  );
  demand(batchBytes <= L.batch, "operator-batch-bound");
  // All possible escaped requests/templates/tool arguments are measured before the first original upload.
  const possible = [
    ...originals.flatMap((o) => [o.get, o.put]),
    effects.header,
    effects.batch,
    effects.sources,
    ...effects.records,
    effects.clock,
  ];
  const envelopes = possible.map((effect) => {
    const envelope = connectorEnvelope(approval, effect),
      requestBytes = utf8(stable(requestFrame(effect, 128, actionDigest)));
    demand(
      requestBytes <= L.request &&
        envelope.codeBytes <= L.code &&
        envelope.argumentBytes <= L.toolArgs &&
        requestBytes +
          envelope.codeBytes +
          envelope.argumentBytes +
          L.response +
          L.original <=
          L.aggregate,
      "operator-envelope-bound",
    );
    return {
      requestBytes,
      codeBytes: envelope.codeBytes,
      argumentBytes: envelope.argumentBytes,
    };
  });
  return frozen({
    approval,
    plan,
    profile,
    effects,
    actionDigest,
    envelopes,
    batchBytes,
  });
}
export type PreparedOperator = ReturnType<typeof prepareOperatorInput>;
function originalResult(value: unknown, source: Original, allowAbsent = false) {
  if (value === null) {
    demand(allowAbsent, "operator-original-absent");
    return null;
  }
  demand(
    shape(value, "base64") &&
      typeof value.base64 === "string" &&
      utf8(value.base64) <= Math.ceil(L.original / 3) * 4,
    "operator-original-shape",
  );
  const bytes = Buffer.from(value.base64, "base64");
  demand(
    bytes.toString("base64") === value.base64 &&
      bytes.length === source.sizeBytes &&
      sha256(bytes) === source.sha256,
    "operator-original-conflict",
  );
  return bytes;
}
/** Trusted parent validator/dispatcher. Ports are injected by the parent; no credential or tool acquisition. */
export function createParentBroker(
  prepared: PreparedOperator,
  {
    current,
    dispatch,
    now = () => Date.now(),
  }: {
    current: () => Promise<void>;
    dispatch: (
      args: { account_id: string; code: string },
      effect: Effect,
    ) => Promise<unknown>;
    now?: () => number;
  },
) {
  demand(typeof current === "function" && typeof dispatch === "function");
  const { approval, effects, actionDigest } = prepared;
  let sequence = 0,
    requests = 0,
    r2 = 0,
    d1 = 0,
    sql = 0,
    stopped = false,
    inFlight = false,
    admitting = false,
    completed = false,
    batchOutcome = "not-dispatched",
    settlement = "not-dispatched",
    phase = approval.mode === "import" ? "custody-get" : "kernel-original",
    ordinal = 0,
    chunk = 0,
    retainedPlan = prepared.plan,
    retained = false;
  const stop = () => {
    stopped = true;
  };
  function guard() {
    const clock = now();
    demand(
      !stopped &&
        Number.isSafeInteger(clock) &&
        clock >= approval.window.nowMs &&
        clock < approval.window.expiresAtMs,
      "operator-stopped-or-expired",
    );
  }
  async function active() {
    guard();
    try {
      await current();
      guard();
    } catch (error) {
      stop();
      throw error;
    }
  }
  function expected(): Effect {
    if (
      phase === "custody-get" ||
      phase === "custody-verify" ||
      phase === "kernel-original" ||
      phase === "final-original"
    )
      return at(effects.custody, ordinal).get;
    if (phase === "custody-put") return at(effects.custody, ordinal).put;
    if (phase === "header" || phase === "saved-header") return effects.header;
    if (phase === "batch") return effects.batch;
    if (phase === "sources") return effects.sources;
    if (phase === "records") return at(effects.records, chunk);
    if (phase === "clock") return effects.clock;
    demand(phase === "done");
    return {
      kind: "done",
      payload: { receipt: retained ? retainedPlan.receipt : null },
    };
  }
  function rows(result: unknown) {
    demand(
      shape(result, "rows") &&
        Array.isArray(result.rows) &&
        result.rows.length <= 155,
      "operator-result-shape",
    );
    return result.rows as Record<string, unknown>[];
  }
  function advance(result: unknown) {
    if (
      [
        "custody-get",
        "custody-verify",
        "kernel-original",
        "final-original",
      ].includes(phase)
    ) {
      const original = originalResult(
        result,
        at(approval.sources, ordinal),
        phase === "custody-get",
      );
      if (phase === "custody-get" && original === null) {
        phase = "custody-put";
        return;
      }
      if (++ordinal === approval.sources.length) {
        ordinal = 0;
        phase = phase.startsWith("custody")
          ? "kernel-original"
          : phase === "kernel-original"
            ? "header"
            : "done";
      } else if (phase === "custody-verify") phase = "custody-get";
      return;
    }
    if (phase === "custody-put") {
      demand(shape(result, "written") && result.written === true);
      phase = "custody-verify";
      return;
    }
    if (phase === "header" || phase === "saved-header") {
      const values = rows(result);
      demand(values.length === 1);
      const row = at(values, 0);
      if (row.source_snapshot === null) {
        demand(
          phase === "header" &&
            row.record_count === 0 &&
            row.baseline_count === 0 &&
            row.source_count === 0 &&
            row.stage_count === 0 &&
            row.canonical_count === 0 &&
            row.p_snapshot === null,
          "operator-import-conflict",
        );
        phase = approval.mode === "reconcile" ? "done" : "batch";
        return;
      }
      demand(
        typeof row.source_snapshot === "string" &&
          utf8(row.source_snapshot) <= L.response,
        "operator-receipt",
      );
      const receipt = JSON.parse(row.source_snapshot);
      demand(
        Number.isSafeInteger(receipt.importObservedAt) &&
          receipt.importObservedAt >= 0,
      );
      retainedPlan = planAuditedImport(
        {
          sources: prepared.plan.sources.map((s) => ({
            name: s.name,
            bytes: Buffer.from(s.rawUtf8),
            receipt: s.sourceReceipt,
          })),
          workspace: prepared.plan.workspace,
          seriesId: prepared.plan.seriesId,
          observedAt: receipt.importObservedAt,
        },
        prepared.profile,
      );
      demand(
        row.source_snapshot === JSON.stringify(retainedPlan.receipt) &&
          row.owner === retainedPlan.workspace.ownerId &&
          row.source_table === "audited_json" &&
          row.source_kind === "import_receipt" &&
          row.source_id === retainedPlan.seriesId &&
          row.source_revision === null &&
          row.provenance === "imported_legacy_baseline" &&
          row.artifact_availability === "not_applicable" &&
          row.archive_state === "pending" &&
          row.schema_version === 1 &&
          row.record_count === retainedPlan.records.length &&
          row.baseline_count === retainedPlan.records.length &&
          row.source_count === retainedPlan.sources.length &&
          row.stage_count === 0 &&
          row.canonical_count === 0 &&
          row.p_snapshot === null,
        "operator-retained-mismatch",
      );
      retained = true;
      phase = "sources";
      return;
    }
    if (phase === "batch") {
      demand(
        shape(result, "statements") &&
          result.statements ===
            (effects.batch.payload as { statements: unknown[] }).statements
              .length,
      );
      settlement = "batch-committed";
      batchOutcome = "committed";
      phase = "saved-header";
      return;
    }
    if (phase === "sources") {
      const values = rows(result);
      demand(values.length === retainedPlan.sources.length);
      for (const source of retainedPlan.sources) {
        const row = values.find((r) => r.source_id === source.rawSha256);
        demand(
          row &&
            row.source_snapshot === JSON.stringify(source) &&
            row.owner === retainedPlan.workspace.ownerId &&
            row.source_kind === "raw_input" &&
            row.source_table === "audited_json" &&
            row.source_revision === null &&
            row.provenance === "imported_legacy_baseline" &&
            row.artifact_availability === "not_applicable" &&
            row.archive_state === "pending" &&
            row.schema_version === 1,
          "operator-source-readback",
        );
      }
      phase = effects.records.length ? "records" : "clock";
      return;
    }
    if (phase === "records") {
      const ids = at(pendingChunks(retainedPlan).chunks, chunk).ids,
        values = rows(result);
      demand(
        values.length === ids.length &&
          new Set(values.map((r) => r.id)).size === ids.length,
      );
      for (const id of ids) {
        const expected = required(
            retainedPlan.records.find((r) => r.id === id),
          ),
          row = values.find((r) => r.id === id);
        demand(
          row &&
            row.owner === retainedPlan.workspace.ownerId &&
            row.kind === "opportunity" &&
            row.body === JSON.stringify(expected.body) &&
            row.revision === 1 &&
            row.updated_at === expected.updatedAt &&
            row.b_owner === retainedPlan.workspace.ownerId &&
            row.source_table === "records" &&
            row.source_kind === "opportunity" &&
            row.source_id === id &&
            row.source_revision === "1" &&
            row.source_snapshot ===
              JSON.stringify({
                body: expected.body,
                revision: "1",
                updatedAt: expected.updatedAt,
              }) &&
            row.provenance === "imported_legacy_baseline" &&
            row.artifact_availability === "not_applicable" &&
            row.archive_state === "pending" &&
            row.schema_version === 1,
          "operator-record-readback",
        );
      }
      phase = ++chunk === effects.records.length ? "clock" : "records";
      return;
    }
    if (phase === "clock") {
      const values = rows(result);
      demand(
        values.length === 1 &&
          shape(values[0], "observed") &&
          Number.isSafeInteger(values[0].observed) &&
          Number(values[0].observed) >= 0,
      );
      phase = "final-original";
      ordinal = 0;
      return;
    }
    demand(false);
  }
  async function accept(text: string): Promise<string> {
    let ownsAdmission = false;
    try {
      demand(
        !admitting && !inFlight && !completed && !stopped,
        "operator-sticky-stop",
      );
      admitting = true;
      ownsAdmission = true;
      const frame = parseRequest(text);
      demand(
        frame.sequence === sequence + 1 && frame.actionDigest === actionDigest,
        "operator-sequence",
      );
      sequence++;
      await active();
      guard();
      if (frame.kind === "current") {
        demand(shape(frame.payload, ""));
        return stable({
          protocol: PROTOCOL,
          sequence,
          actionDigest,
          requestDigest: frame.requestDigest,
          ok: true,
          result: null,
        });
      }
      const effect = expected();
      demand(
        stable({ kind: frame.kind, payload: frame.payload }) === stable(effect),
        "operator-effect-mismatch",
      );
      if (frame.kind === "done") {
        await active();
        guard();
        completed = true;
        return stable({
          protocol: PROTOCOL,
          sequence,
          actionDigest,
          requestDigest: frame.requestDigest,
          ok: true,
          result: null,
        });
      }
      const envelope = connectorEnvelope(approval, effect);
      demand(
        utf8(text) +
          envelope.codeBytes +
          envelope.argumentBytes +
          L.response +
          L.original <=
          L.aggregate,
        "operator-aggregate-bound",
      );
      const isR2 = effect.kind.startsWith("r2.");
      requests++;
      if (isR2) r2++;
      else {
        d1++;
        sql += (effect.payload as { statements: unknown[] }).statements.length;
      }
      demand(
        requests <= L.requests && r2 <= L.r2 && d1 <= L.d1 && sql <= L.sql,
        "operator-call-bound",
      );
      await active();
      guard();
      inFlight = true;
      if (effect.kind === "d1.batch") batchOutcome = "unknown";
      settlement =
        effect.kind === "d1.batch" || effect.kind === "r2.put"
          ? "effect-outcome-unknown"
          : "read-in-flight";
      let result;
      try {
        try {
          result = await dispatch(envelope.args, effect);
        } catch {
          throw Error("operator-provider-settlement-unknown");
        }
      } finally {
        inFlight = false;
      }
      if (effect.kind === "d1.batch") batchOutcome = "settled-unverified";
      await active();
      guard();
      demand(utf8(stable(result)) <= L.response, "operator-response-bound");
      advance(result);
      await active();
      guard();
      const response = stable({
        protocol: PROTOCOL,
        sequence,
        actionDigest,
        requestDigest: frame.requestDigest,
        ok: true,
        result,
      });
      checkedResponse(response, frame);
      return response;
    } catch (e) {
      stop();
      throw e;
    } finally {
      if (ownsAdmission) admitting = false;
    }
  }
  return Object.freeze({
    accept,
    stop,
    async finish() {
      try {
        await active();
        guard();
        demand(completed && !inFlight, "operator-missing-frames");
      } catch (error) {
        stop();
        throw error;
      }
    },
    state: () => ({
      sequence,
      requests,
      r2,
      d1,
      sql,
      stopped,
      inFlight,
      completed,
      settlement,
      batchOutcome,
    }),
  });
}
/** Credential-free child uses only this explicitly supplied frame exchange. */
export async function runOperatorImport(
  prepared: PreparedOperator,
  exchange: (text: string) => Promise<string>,
) {
  let sequence = 0,
    stopped = false;
  let failure: unknown;
  const { approval, actionDigest, effects } = prepared;
  async function request(effect: Effect) {
    if (stopped) throw failure;
    const frame = requestFrame(effect, ++sequence, actionDigest);
    try {
      const response = checkedResponse(await exchange(stable(frame)), frame);
      demand(response.ok, "operator-parent-denied");
      return response.result;
    } catch (e) {
      stopped = true;
      failure = e;
      throw e;
    }
  }
  const current = async () => {
    await request({ kind: "current", payload: {} });
  };
  await current();
  if (approval.mode === "import")
    for (let i = 0; i < effects.custody.length; i++) {
      const source = at(effects.custody, i),
        result = await request(source.get);
      if (result === null) {
        await request(source.put);
        originalResult(await request(source.get), at(approval.sources, i));
      } else originalResult(result, at(approval.sources, i));
    }
  const statements = new WeakMap<PendingStatement, PendingSql>();
  const db: PendingDatabase = {
    prepare(sql: string) {
      const make = (params: (string | number | null)[]): PendingStatement => {
        const statement: PendingStatement = {
          bind: (...next) => make(next),
          async first<T>() {
            const value = (await request(
              queries("d1.first", approval.databaseId, [{ sql, params }]),
            )) as { rows: T[] };
            return value.rows[0] ?? null;
          },
          async all<T>() {
            const value = (await request(
              queries("d1.all", approval.databaseId, [{ sql, params }]),
            )) as { rows: T[] };
            return { results: value.rows };
          },
        };
        statements.set(statement, { sql, params });
        return statement;
      };
      return make([]);
    },
    async batch(values) {
      await request(
        queries(
          "d1.batch",
          approval.databaseId,
          values.map((value) => required(statements.get(value))),
        ),
      );
      return [];
    },
  };
  const result = await observeOperatorPending(
    {
      db,
      currentWorkspace: async () => prepared.plan.workspace,
      window: approval.window,
      current,
      resultOnly: approval.mode === "reconcile",
      readOriginalCopy: async (name) => {
        const index = approval.sources.findIndex((s) => s.name === name);
        demand(index >= 0);
        return required(
          originalResult(
            await request(at(effects.custody, index).get),
            at(approval.sources, index),
          ),
        );
      },
    },
    prepared.plan,
    prepared.profile,
  );
  await current();
  await request({
    kind: "done",
    payload: { receipt: result?.receipt ?? null },
  });
  return result;
}
