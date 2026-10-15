import { exportJWK, generateKeyPair } from "jose";
import { CONTRACT } from "../../integration/shared-contract.mjs";
import { parseCoreRequest } from "../../src/application/shared-read-authority";
import {
  executeCommand,
  type CommandDependencies,
} from "../../src/application/commands/execute";
import { createRecoveryIntakeBudget } from "../../src/application/recovery-admission";
import { createRecordReads } from "../../src/application/record-reads";
import { memoryArchive } from "./primary-memory";
import { sqliteD1 } from "./sqlite-d1";
import {
  SYNTHETIC_WORKSPACE,
  syntheticControl,
  trustRootFor,
} from "./command-control";
import { opportunityBody } from "./domain-preparation";

/** Synthetic end-to-end command harness: real SQLite with every migration, the
 * memory archive seam, a synthetic Control and a runtime-generated key. */
export async function commandHarness() {
  const sqlite = sqliteD1(),
    memory = memoryArchive(),
    keys = await generateKeyPair("ES256", { extractable: true });
  const control = syntheticControl({
    privateJwk: await exportJWK(keys.privateKey),
  });
  const deps: CommandDependencies = {
    db: sqlite.db,
    archive: memory.archive,
    authority: control.authority,
    trustRoot: trustRootFor(await exportJWK(keys.publicKey)),
    budget: createRecoveryIntakeBudget(),
  };
  let serial = 0;
  async function invoke(
    operationId: string,
    input: Record<string, unknown>,
    options: {
      invocationId?: string;
      deps?: Partial<CommandDependencies>;
      body?: ReadableStream<Uint8Array>;
    } = {},
  ) {
    const request = parseCoreRequest({
      contract: CONTRACT,
      invocationId: options.invocationId ?? `inv_${++serial}`,
      operationId,
      input: { workspaceId: SYNTHETIC_WORKSPACE.workspaceId, ...input },
    });
    return executeCommand(request, { ...deps, ...options.deps }, options.body);
  }
  const reads = () =>
    createRecordReads(
      sqlite.db,
      SYNTHETIC_WORKSPACE.ownerId,
      SYNTHETIC_WORKSPACE.workspaceId,
    );
  function rows(sql: string, ...values: (string | number)[]) {
    return sqlite.raw.prepare(sql).all(...values) as Record<string, unknown>[];
  }
  function seed(kind: string, id: string, body: unknown, revision = 1) {
    sqlite.raw
      .prepare(
        "INSERT INTO records(owner,kind,id,body,revision,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(SYNTHETIC_WORKSPACE.ownerId, kind, id, JSON.stringify(body), revision, 500);
  }
  return { sqlite, memory, control, deps, invoke, reads, rows, seed };
}
export const captureBody = Object.freeze({
  company: "Example",
  role: "Staff Engineer",
  sourceUrl: "https://example.com/jobs/1?utm_source=feed",
  description: "Build reliable systems",
  terms: {
    employment: "full_time",
    baseUsd: 240000,
    hourlyUsd: null,
    remote: true,
    match401k: null,
    zeroPremium: null,
    affordableCare: null,
  },
});
export const settingsBody = Object.freeze({
  discoveryEnabled: false,
  correspondenceEnabled: false,
  remindersEnabled: true,
  sendingEnabled: false,
  profileResolved: false,
  integrationVerified: false,
  sender: null,
  notificationEmail: null,
  calendarId: null,
  interviewWindows: [],
  approvedRecipients: [],
  boards: [],
});
export const legacyOpportunity = (id: string, state: string) => ({
  ...opportunityBody,
  id,
  state,
  sourceUrl: `https://example.com/legacy/${id}`,
});
