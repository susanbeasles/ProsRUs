import { createHash } from "node:crypto";
import { demand } from "../../domain/model";
import { createUploadIntake } from "../recovery-uploads";
import type {
  PrimaryArchive,
  RecoveryIntakeBudget,
  RecoveryUploadResolver,
  UploadAuthority,
} from "../recovery-ports";
import { readBoundedBytes } from "../../storage/recovery-streams";
import { createRecoveryStore } from "../../storage/recovery-store";
import type { CommandSession } from "./session";
import { currentChain, recoveryContext } from "./recovery-host";

export type UploadCommandPorts = Readonly<{
  db: D1Database;
  archive: PrimaryArchive;
  budget: RecoveryIntakeBudget;
}>;
/** Upload authority backed by the live invocation: every intake check is a
 * fresh Control `read` decision (Control's owner flow supports only read+ then
 * one before-ack, which the pipeline takes before release). Namespace and
 * deadline come from the current capability/invocation, never the caller. */
function sessionUploadAuthority(session: CommandSession): UploadAuthority {
  return {
    async authorize(context) {
      await session.authorize("read");
      return {
        context,
        now: session.now(),
        namespace: session.invocation.capability.namespace,
        expiresAt: session.invocation.expiresAtMs,
      };
    },
  };
}
async function intakeFor(session: CommandSession, ports: UploadCommandPorts) {
  const store = createRecoveryStore(ports.db, session.workspace.ownerId);
  const context = recoveryContext(
    session.invocation,
    await currentChain(ports.db, store, session.invocation),
  );
  const intake = createUploadIntake({
    archive: ports.archive,
    budget: ports.budget,
    authority: sessionUploadAuthority(session),
  });
  return { intake, context };
}
/** Resolver used by version saves that reference a completed upload handle. */
export function uploadResolver(
  session: CommandSession,
  ports: UploadCommandPorts,
): RecoveryUploadResolver {
  const intake = createUploadIntake({
    archive: ports.archive,
    budget: ports.budget,
    authority: sessionUploadAuthority(session),
  });
  return { resolve: (handle, context) => intake.resolve(handle, context) };
}
function uploadPath(handle: string, grantId: string) {
  return `/owner/job-stack/api/uploads/${handle}/chunks/{ordinal}?grant=${encodeURIComponent(grantId)}`;
}

export async function runUploadBegin(
  session: CommandSession,
  ports: UploadCommandPorts,
) {
  const request = session.request;
  demand(request.operationId === "job-stack.upload.begin.v1", "operation-unavailable");
  // A meeting purpose would need its authorizationRef bound to the session;
  // the maintained session format has no such field, so only profile sources.
  demand(request.input.purpose.kind === "profile-source", "UPLOAD_PURPOSE_UNAVAILABLE", 403);
  const { intake, context } = await intakeFor(session, ports);
  const started = await intake.begin(
    { requestKey: request.input.requestKey, original: request.input.original },
    context,
  );
  return {
    ...started,
    uploadPath: uploadPath(started.uploadHandle, session.invocation.grant.id),
  };
}

export async function runUploadChunk(
  session: CommandSession,
  ports: UploadCommandPorts,
  body: ReadableStream<Uint8Array> | undefined,
) {
  const request = session.request;
  demand(request.operationId === "job-stack.upload.chunk.v1", "operation-unavailable");
  demand(body, "UPLOAD_BODY_REQUIRED");
  const input = request.input;
  // Verify the declared transport bytes before any immutable write.
  const bytes = await readBoundedBytes(body, input.sizeBytes, input.sizeBytes);
  demand(
    createHash("sha256").update(bytes).digest("hex") === input.transportSha256,
    "UPLOAD_TRANSPORT_MISMATCH",
  );
  const { intake, context } = await intakeFor(session, ports);
  const stored = await intake.putChunk(
    {
      uploadHandle: input.uploadHandle,
      ordinal: input.ordinal,
      requestKey: input.requestKey,
      body: new Blob([new Uint8Array(bytes)]).stream(),
    },
    context,
  );
  return {
    status: stored.status,
    uploadHandle: input.uploadHandle,
    ordinal: input.ordinal,
    digest: stored.receipt.artifact.digest,
    sizeBytes: stored.receipt.artifact.sizeBytes,
  };
}

export async function runUploadComplete(
  session: CommandSession,
  ports: UploadCommandPorts,
) {
  const request = session.request;
  demand(request.operationId === "job-stack.upload.complete.v1", "operation-unavailable");
  const { intake, context } = await intakeFor(session, ports);
  const ready = await intake.complete(request.input.uploadHandle, context);
  return {
    status: "upload_ready" as const,
    uploadHandle: ready.uploadHandle,
    original: ready.original,
    digest: ready.artifact.digest,
    sizeBytes: ready.artifact.sizeBytes,
    expiresAt: ready.expiresAt,
    complete: true as const,
  };
}
