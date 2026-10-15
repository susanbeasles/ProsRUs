import { id, demand, DomainError } from "../domain/model";
import {
  authenticatedRecoveryContextSchema,
  type ArchiveMetadataDescriptor,
} from "../domain/recovery";
import { canonicalizeEnvelope } from "../domain/recovery-canonical";
import {
  originalFileSchema,
  preparedUploadSchema,
  uploadPartReceiptSchema,
  uploadPrefix,
  uploadRequestSchema,
  uploadSelectionSchema,
  uploadSessionSchema,
  UPLOAD_CHUNK_BYTES,
  type OriginalFile,
  type PreparedUpload,
  type UploadSession,
} from "../domain/recovery-upload";
import type {
  AuthenticatedRecoveryContext,
  PrimaryArchive,
  RecoveryIntakeBudget,
  UploadAuthority,
} from "./recovery-ports";
import {
  artifactDigest,
  inspectArtifactStream,
  readBoundedBytes,
  verifyArtifact,
} from "../storage/recovery-streams";
import {
  equalMetadata,
  logicalObject,
  readMetadata,
  writeMetadata,
} from "../storage/recovery-metadata";
import {
  expectedChunkBytes,
  loadSelectedParts,
  selectedOriginalStream,
  validatePart,
  type ResolvedUploadSession,
} from "../storage/recovery-upload-inventory";
export { createRecoveryIntakeBudget } from "./recovery-admission";

type BeginUploadInput = Readonly<{
  requestKey: string;
  original: OriginalFile;
}>;
type UploadChunkInput = Readonly<{
  uploadHandle: string;
  ordinal: number;
  requestKey: string;
  body: ReadableStream<Uint8Array>;
}>;
type UploadPorts = Readonly<{
  archive: PrimaryArchive;
  authority?: UploadAuthority;
  budget?: RecoveryIntakeBudget;
}>;

export function createUploadIntake(ports: UploadPorts) {
  demand(ports.authority, "UPLOAD_AUTHORITY_UNAVAILABLE", 503);
  demand(ports.budget, "UPLOAD_ADMISSION_UNAVAILABLE", 503);
  const { archive, authority, budget } = ports;
  async function current(
    context: AuthenticatedRecoveryContext,
    stage: "start" | "chunk" | "complete" | "resolve",
    session: UploadSession | null,
  ) {
    authenticatedRecoveryContextSchema.parse(context);
    const authorized = await authority.authorize(context, stage, session);
    authenticatedRecoveryContextSchema.parse(authorized.context);
    demand(
      equalMetadata(context, authorized.context),
      "RECOVERY_AUTHORITY_MISMATCH",
      403,
    );
    demand(
      Number.isSafeInteger(authorized.now) &&
        authorized.now >= context.serverTime &&
        Number.isSafeInteger(authorized.expiresAt) &&
        authorized.expiresAt > authorized.now &&
        context.actor.expiresAt > authorized.now &&
        context.grant.expiresAt > authorized.now,
      "EXPIRED_RECOVERY_AUTHORITY",
      403,
    );
    id.parse(authorized.namespace);
    if (session) {
      demand(
        equalMetadata(session.workspace, context.workspace) &&
          session.actorId === context.actor.id &&
          session.namespace === authorized.namespace &&
          session.issuer === context.issuer &&
          session.audience === context.audience &&
          session.grantId === context.grant.id &&
          session.grantRevision === context.grant.revision,
        "UPLOAD_AUTHORITY_MISMATCH",
        403,
      );
      demand(session.expiresAt > authorized.now, "UPLOAD_EXPIRED", 403);
    }
    return authorized;
  }
  async function loadSession(
    handle: string,
    context: AuthenticatedRecoveryContext,
    stage: "chunk" | "complete" | "resolve",
  ): Promise<ResolvedUploadSession> {
    id.parse(handle);
    const authorized = await current(context, stage, null);
    const prefix = uploadPrefix({
      workspace: context.workspace,
      sessionId: handle,
    });
    const stored = await readMetadata(
      archive,
      logicalObject(authorized.namespace, `${prefix}/session`),
      "inventory",
    );
    demand(stored, "UPLOAD_NOT_FOUND", 404);
    const session = uploadSessionSchema.parse(stored.value);
    demand(session.sessionId === handle, "UPLOAD_AUTHORITY_MISMATCH", 403);
    await current(context, stage, session);
    return { session, descriptor: stored.descriptor };
  }
  function started(session: UploadSession) {
    return {
      status: "upload_started" as const,
      uploadHandle: session.sessionId,
      original: session.original,
      expiresAt: session.expiresAt,
      chunkBytes: session.chunkBytes,
      partCount: session.partCount,
    };
  }
  async function begin(
    input: BeginUploadInput,
    context: AuthenticatedRecoveryContext,
  ) {
    return budget.run("metadata", async () => {
      const parsed = originalFileSchema.safeParse(input.original);
      demand(parsed.success, "INVALID_ORIGINAL_METADATA");
      id.parse(input.requestKey);
      canonicalizeEnvelope(input);
      const authorized = await current(context, "start", null);
      const requestObject = logicalObject(
        authorized.namespace,
        `uploads/${context.workspace.ownerId}/${context.workspace.workspaceId}/requests/${input.requestKey}`,
      );
      async function prior() {
        const stored = await readMetadata(archive, requestObject, "inventory");
        if (!stored) return null;
        const request = uploadRequestSchema.parse(stored.value);
        demand(
          request.requestKey === input.requestKey &&
            equalMetadata(request.original, parsed.data),
          "UPLOAD_REQUEST_CONFLICT",
          409,
        );
        const read = await readMetadata(
          archive,
          request.session.object,
          "inventory",
          request.session,
        );
        demand(read, "UPLOAD_INCOMPLETE");
        const session = uploadSessionSchema.parse(read.value);
        await current(context, "start", session);
        return started(session);
      }
      const existing = await prior();
      if (existing) return existing;
      const session = uploadSessionSchema.parse({
        formatVersion: 1,
        type: "upload_session",
        sessionId: crypto.randomUUID(),
        workspace: context.workspace,
        actorId: context.actor.id,
        namespace: authorized.namespace,
        grantId: context.grant.id,
        grantRevision: context.grant.revision,
        issuer: context.issuer,
        audience: context.audience,
        original: parsed.data,
        createdAt: authorized.now,
        expiresAt: Math.min(
          authorized.expiresAt,
          context.actor.expiresAt,
          context.grant.expiresAt,
        ),
        chunkBytes: UPLOAD_CHUNK_BYTES,
        partCount: Math.ceil(parsed.data.sizeBytes / UPLOAD_CHUNK_BYTES),
      });
      const sessionDescriptor = await writeMetadata(
        archive,
        logicalObject(session.namespace, `${uploadPrefix(session)}/session`),
        "inventory",
        session,
      );
      const request = uploadRequestSchema.parse({
        formatVersion: 1,
        type: "upload_request",
        requestKey: input.requestKey,
        original: session.original,
        session: sessionDescriptor,
      });
      try {
        await writeMetadata(archive, requestObject, "inventory", request);
      } catch (error) {
        if (
          !(error instanceof DomainError) ||
          error.code !== "INTEGRITY_MISMATCH"
        )
          throw error;
        const chosen = await prior();
        demand(chosen, "UPLOAD_REQUEST_CONFLICT");
        return chosen;
      }
      await current(context, "start", session);
      return started(session);
    });
  }
  async function putChunk(
    input: UploadChunkInput,
    context: AuthenticatedRecoveryContext,
  ) {
    try {
      return await budget.run("chunk", async () => {
        const resolved = await loadSession(
          input.uploadHandle,
          context,
          "chunk",
        );
        const { session } = resolved;
        id.parse(input.requestKey);
        const sizeBytes = expectedChunkBytes(session, input.ordinal);
        const bytes = await readBoundedBytes(input.body, sizeBytes, sizeBytes);
        const digest = artifactDigest(bytes);
        await current(context, "chunk", session);
        const stored = await archive.putImmutable({
          // Chunks are temporary: they stay under the session prefix in UPLOADS.
          object: logicalObject(session.namespace, `${uploadPrefix(session)}/chunks/${digest}`),
          bytes,
          digest,
          hashPurpose: "blob",
        });
        const receipt = uploadPartReceiptSchema.parse({
          formatVersion: 1,
          type: "upload_part",
          sessionId: session.sessionId,
          workspace: session.workspace,
          actorId: session.actorId,
          session: resolved.descriptor,
          ordinal: input.ordinal,
          requestKey: input.requestKey,
          artifact: {
            schemaVersion: 1,
            hashAlgorithm: "sha256-domain-v1",
            digest,
            sizeBytes,
            mediaType: "application/octet-stream",
            object: stored.object,
          },
        });
        const receiptKey = logicalObject(
          session.namespace,
          `${uploadPrefix(session)}/parts/${String(input.ordinal).padStart(3, "0")}`,
        );
        let receiptObject: ArchiveMetadataDescriptor;
        try {
          receiptObject = await writeMetadata(
            archive,
            receiptKey,
            "inventory",
            receipt,
          );
        } catch (error) {
          if (
            error instanceof DomainError &&
            error.code === "INTEGRITY_MISMATCH"
          )
            throw new DomainError("UPLOAD_PART_CONFLICT", 409);
          throw error;
        }
        validatePart(receipt, resolved, input.ordinal);
        await current(context, "chunk", session);
        return { status: "chunk_stored" as const, receipt, receiptObject };
      });
    } catch (error) {
      if (!input.body.locked) await input.body.cancel().catch(() => undefined);
      throw error;
    }
  }
  async function verifyReady(
    resolved: ResolvedUploadSession,
    ready: PreparedUpload,
  ): Promise<void> {
    const { session } = resolved;
    demand(
      ready.uploadHandle === session.sessionId &&
        ready.actorId === session.actorId &&
        equalMetadata(ready.workspace, session.workspace) &&
        equalMetadata(ready.original, session.original) &&
        equalMetadata(ready.session, resolved.descriptor) &&
        ready.expiresAt === session.expiresAt,
      "UPLOAD_READY_MISMATCH",
    );
    demand(
      ready.artifact.sizeBytes === session.original.sizeBytes &&
        ready.artifact.mediaType === "application/octet-stream" &&
        ready.artifact.object.provider === "primary" &&
        ready.artifact.object.namespace === session.namespace &&
        ready.artifact.object.key === `blobs/${ready.artifact.digest}` &&
        ready.artifact.object.versionId !== null,
      "UPLOAD_READY_MISMATCH",
    );
    const selected = await readMetadata(
      archive,
      ready.selection.object,
      "inventory",
      ready.selection,
    );
    demand(selected, "UPLOAD_INCOMPLETE");
    demand(
      ready.selection.object.key === `${uploadPrefix(session)}/selection` &&
        ready.selection.object.namespace === session.namespace,
      "UPLOAD_READY_MISMATCH",
    );
    const selection = uploadSelectionSchema.parse(selected.value);
    const inventory = await loadSelectedParts(archive, resolved);
    demand(
      equalMetadata(selection.session, resolved.descriptor) &&
        equalMetadata(selection.parts, inventory.descriptors),
      "UPLOAD_SELECTION_CONFLICT",
      409,
    );
    // Validate both selected source bytes and the promoted original on every resolution.
    const source = await inspectArtifactStream(
      selectedOriginalStream(archive, inventory.parts),
      session.original.sizeBytes,
    );
    demand(source.digest === ready.artifact.digest, "INTEGRITY_MISMATCH");
    await verifyArtifact(archive, ready.artifact);
  }
  async function resolveReady(
    resolved: ResolvedUploadSession,
  ): Promise<PreparedUpload | null> {
    const stored = await readMetadata(
      archive,
      logicalObject(
        resolved.session.namespace,
        `${uploadPrefix(resolved.session)}/ready`,
      ),
      "inventory",
    );
    if (!stored) return null;
    const ready = preparedUploadSchema.parse(stored.value);
    await verifyReady(resolved, ready);
    return ready;
  }
  async function complete(
    handle: string,
    context: AuthenticatedRecoveryContext,
  ) {
    return budget.run("finalize", async () => {
      const resolved = await loadSession(handle, context, "complete");
      const { session } = resolved;
      const prior = await resolveReady(resolved);
      if (prior) {
        await current(context, "complete", session);
        return prior;
      }
      const inventory = await loadSelectedParts(archive, resolved);
      const selection = uploadSelectionSchema.parse({
        formatVersion: 1,
        type: "upload_selection",
        session: resolved.descriptor,
        parts: inventory.descriptors,
      });
      await current(context, "complete", session);
      const selected = await writeMetadata(
        archive,
        logicalObject(session.namespace, `${uploadPrefix(session)}/selection`),
        "inventory",
        selection,
      );
      const inspected = await inspectArtifactStream(
        selectedOriginalStream(archive, inventory.parts),
        session.original.sizeBytes,
      );
      await current(context, "complete", session);
      const stored = await archive.putImmutableStream({
        object: logicalObject(session.namespace, `blobs/${inspected.digest}`),
        hashPurpose: "blob",
        digest: inspected.digest,
        sizeBytes: session.original.sizeBytes,
        transportSha256: inspected.rawSha256,
        body: selectedOriginalStream(archive, inventory.parts),
      });
      const ready = preparedUploadSchema.parse({
        formatVersion: 1,
        type: "upload_ready",
        uploadHandle: handle,
        workspace: session.workspace,
        actorId: session.actorId,
        artifact: {
          schemaVersion: 1,
          hashAlgorithm: "sha256-domain-v1",
          digest: inspected.digest,
          sizeBytes: session.original.sizeBytes,
          mediaType: "application/octet-stream",
          object: stored.object,
        },
        complete: true,
        expiresAt: session.expiresAt,
        original: session.original,
        session: resolved.descriptor,
        selection: selected,
      });
      await verifyArtifact(archive, ready.artifact);
      await current(context, "complete", session);
      await writeMetadata(
        archive,
        logicalObject(session.namespace, `${uploadPrefix(session)}/ready`),
        "inventory",
        ready,
      );
      await current(context, "complete", session);
      return ready;
    });
  }
  async function resolve(
    handle: string,
    context: AuthenticatedRecoveryContext,
  ) {
    return budget.run("finalize", async () => {
      const resolved = await loadSession(handle, context, "resolve");
      const ready = await resolveReady(resolved);
      demand(ready, "UPLOAD_INCOMPLETE", 409);
      await current(context, "resolve", resolved.session);
      return ready;
    });
  }
  return { begin, putChunk, complete, resolve };
}
