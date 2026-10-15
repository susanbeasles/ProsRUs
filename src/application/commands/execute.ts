import { ZodError } from "zod";
import {
  validateCoreOutput,
  type CoreInvokeRequest,
} from "../../../integration/shared-contract.mjs";
import { DomainError } from "../../domain/model";
import {
  assertPublicRequestKey,
  decideRequestKey,
  requireOwnerInteraction,
} from "../../domain/command-policy";
import {
  createCommandLedger,
  type CommandAuditEvent,
  type CommandLedger,
} from "../../storage/command-ledger";
import type { PrimaryArchive, RecoveryIntakeBudget } from "../recovery-ports";
import type { RecoveryVerificationKey } from "../../domain/recovery-canonical";
import type { ControlAuthority } from "../shared-read-authority";
import { commandFor, type CommandDefinition } from "./registry";
import { openCommandSession, type CommandSession } from "./session";
import { createControlSigner, parseTrustRoot } from "./control-signer";
import { runDomainCommand } from "./domain";
import { runVersionSave } from "./version-save";
import {
  runUploadBegin,
  runUploadChunk,
  runUploadComplete,
  uploadResolver,
} from "./uploads";

export type CommandDependencies = Readonly<{
  db: D1Database;
  archive: PrimaryArchive;
  authority: ControlAuthority;
  /** Public verification material for Control's signing key (optional). */
  trustRoot: string | undefined;
  budget: RecoveryIntakeBudget;
  ids?: () => string;
}>;
const PUBLIC_DENIALS = new Set(["operation-denied", "operation-unavailable"]);
const KEY_CONFLICTS = new Set([
  "REQUEST_KEY_CONFLICT",
  "DOMAIN_REQUEST_KEY_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
]);
/** Fixed public failure codes only: no storage text, values or bodies. Codes
 * are lowercase kebab-case, the only form Control's owner proxy passes on. */
export function publicFailure(error: unknown): string {
  if (error instanceof Error && PUBLIC_DENIALS.has(error.message))
    return error.message;
  if (error instanceof DomainError) {
    if (KEY_CONFLICTS.has(error.code)) return "request-key-conflict";
    if (/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(error.code))
      return error.code.toLowerCase().replaceAll("_", "-");
  }
  if (
    error instanceof ZodError ||
    (error instanceof Error && error.message === "invalid-shared-value")
  )
    return "operation-invalid";
  return "operation-failed";
}
async function discard(body: ReadableStream<Uint8Array> | undefined) {
  if (body && !body.locked) await body.cancel().catch(() => undefined);
}
async function run(
  definition: CommandDefinition,
  session: CommandSession,
  deps: CommandDependencies,
  ledger: CommandLedger,
  ids: () => string,
  body: ReadableStream<Uint8Array> | undefined,
  trust: RecoveryVerificationKey | null,
): Promise<unknown> {
  const uploads = {
    db: deps.db,
    archive: deps.archive,
    budget: deps.budget,
  };
  switch (definition.kind) {
    case "domain":
    case "version-save": {
      const signer = createControlSigner(
        deps.authority,
        session.invocation.invocationId,
        trust,
      );
      return definition.kind === "domain"
        ? runDomainCommand(session, {
            db: deps.db,
            archive: deps.archive,
            signer,
            ledger,
            ids,
          })
        : runVersionSave(session, {
            db: deps.db,
            archive: deps.archive,
            signer,
            uploads: uploadResolver(session, uploads),
            ids,
          });
    }
    case "upload-begin":
      return runUploadBegin(session, uploads);
    case "upload-chunk":
      return runUploadChunk(session, uploads, body);
    case "upload-complete":
      return runUploadComplete(session, uploads);
  }
}

/** The single command pipeline: registry availability -> current authority ->
 * owner-only -> request ledger decision -> command (which revalidates before
 * its durable commit) -> output validation -> release + allow audit. Every
 * decision after the first trusted authority read writes one audit row. */
export async function executeCommand(
  request: CoreInvokeRequest,
  deps: CommandDependencies,
  body?: ReadableStream<Uint8Array>,
): Promise<unknown> {
  let definition: CommandDefinition, session: CommandSession;
  try {
    definition = commandFor(request.operationId);
    if (body !== undefined && definition.kind !== "upload-chunk")
      throw Error("operation-denied");
    session = await openCommandSession(
      request,
      deps.authority,
      definition.effect,
    );
  } catch (error) {
    await discard(body);
    throw Error(publicFailure(error));
  }
  const ids = deps.ids ?? (() => crypto.randomUUID()),
    invocation = session.invocation,
    { ownerId, workspaceId } = session.workspace,
    ledger = createCommandLedger(deps.db, ownerId, workspaceId),
    requestKey = (request.input as { requestKey: string }).requestKey,
    inputDigest = invocation.operation.inputDigest,
    grantId = invocation.grant.id;
  const audit = (
    decision: CommandAuditEvent["decision"],
    reason: string,
  ): CommandAuditEvent => ({
    eventId: ids(),
    invocationId: invocation.invocationId,
    operationId: request.operationId,
    requestKey,
    inputDigest,
    entrypoint: invocation.entrypoint === "owner" ? "owner" : "mcp",
    principalId: invocation.grant.principalId,
    grantId,
    grantRevision: invocation.grant.revision,
    stage: session.stage(),
    decision,
    reason,
    createdAt: session.now(),
  });
  let consumed = false;
  try {
    if (definition.ownerOnly)
      requireOwnerInteraction({
        entrypoint: invocation.entrypoint,
        verifiedOwnerPrincipalId: invocation.verifiedOwnerPrincipalId,
        issuerPrincipalId: invocation.grant.issuerPrincipalId,
        grantId,
        grantRevision: invocation.grant.revision,
      });
    assertPublicRequestKey(requestKey);
    // Versioned saves need Control-custody signing; without verifiable trust
    // material they fail closed before any ledger, archive or D1 state.
    const trust = ["domain", "version-save"].includes(definition.kind)
      ? await parseTrustRoot(deps.trustRoot)
      : null;
    if (["domain", "version-save"].includes(definition.kind) && !trust)
      throw new DomainError("RECOVERY_SIGNING_AUTHORITY_UNAVAILABLE", 503);
    const prior = await ledger.find(requestKey);
    const decision = decideRequestKey(prior, request.operationId, inputDigest);
    if (decision.kind === "conflict")
      throw new DomainError("REQUEST_KEY_CONFLICT", 409);
    if (decision.kind === "replay" && prior) {
      await session.authorize("before-ack");
      const output = validateCoreOutput(request.operationId, prior.result, {
        grantId,
      });
      await ledger.audit(audit("replay", "stored-result"));
      return output;
    }
    if (decision.kind === "new")
      await ledger.begin({
        requestKey,
        operationId: request.operationId,
        inputDigest,
        now: session.now(),
      });
    consumed = definition.kind === "upload-chunk";
    const result = await run(
      definition,
      session,
      deps,
      ledger,
      ids,
      body,
      trust,
    );
    const output = validateCoreOutput(request.operationId, result, {
      grantId,
    });
    if (!session.acknowledged()) await session.authorize("before-ack");
    await ledger.commit({
      requestKey,
      inputDigest,
      result: output,
      now: session.now(),
      audit: audit("allow", "released"),
    });
    return output;
  } catch (error) {
    const code = publicFailure(error);
    try {
      await ledger.audit(
        audit(code === "request-key-conflict" ? "conflict" : "deny", code),
      );
    } catch {
      // The decision stands even if its audit row cannot be written.
    }
    throw Error(code);
  } finally {
    if (!consumed) await discard(body);
  }
}
