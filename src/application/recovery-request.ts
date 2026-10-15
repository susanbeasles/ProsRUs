import type { RecoveryUploadResolver } from "./recovery-ports";
import { demand } from "../domain/model";
import {
  saveVersionInputSchema,
  type AuthenticatedRecoveryContext,
  type SaveVersionInput,
  type WorkspaceRef,
} from "../domain/recovery";
import {
  canonicalizeEnvelope,
  hashEnvelope,
  MAX_ENVELOPE_BYTES,
  parseEnvelopeJson,
} from "../domain/recovery-canonical";
import { artifactDigest } from "../storage/recovery-streams";
import {
  preparedUploadSchema,
  type PreparedUpload,
} from "../domain/recovery-upload";

export function snapshotSaveInput(input: SaveVersionInput): SaveVersionInput {
  if (input.content instanceof Uint8Array)
    demand(input.content.length <= MAX_ENVELOPE_BYTES, "ENVELOPE_TOO_LARGE");
  const parsed = saveVersionInputSchema.parse(input);
  if (parsed.content === undefined || parsed.content instanceof Uint8Array)
    return parsed;
  return {
    ...parsed,
    content: parseEnvelopeJson(
      new TextDecoder().decode(canonicalizeEnvelope(parsed.content)),
    ),
  };
}
export function directContentBytes(input: SaveVersionInput): Uint8Array {
  demand(input.content !== undefined, "CONTENT_OR_UPLOAD_REQUIRED");
  return input.content instanceof Uint8Array
    ? new Uint8Array(input.content)
    : canonicalizeEnvelope(input.content);
}
/** Stable meaning excludes server-assigned version/transaction/time/chain. An upload
 * binds its handle, original metadata, selected inventory and final byte identity. */
export async function recoveryRequestDigest(
  input: SaveVersionInput,
  workspace: WorkspaceRef,
  upload: PreparedUpload | null,
): Promise<string> {
  const meaning =
    input.uploadHandle !== undefined
      ? {
          kind: "upload",
          handle: input.uploadHandle,
          original: upload?.original,
          artifact: upload
            ? {
                digest: upload.artifact.digest,
                sizeBytes: upload.artifact.sizeBytes,
                mediaType: upload.artifact.mediaType,
              }
            : null,
          selectionDigest: upload?.selection.digest,
        }
      : {
          kind: input.content instanceof Uint8Array ? "bytes" : "structured",
          digest: artifactDigest(directContentBytes(input)),
        };
  demand(
    input.uploadHandle === undefined ||
      upload?.uploadHandle === input.uploadHandle,
    "UPLOAD_INCOMPLETE",
  );
  return hashEnvelope("request", {
    workspace,
    requestKey: input.requestKey,
    lineageId: input.lineageId,
    entityId: input.entityId,
    kind: input.kind,
    expectedParentIds: input.expectedParentIds,
    branchRequested: input.branchRequested,
    sourceVersionIds: input.sourceVersionIds,
    content: meaning,
  });
}
export async function resolveRequestUpload(
  input: SaveVersionInput,
  context: AuthenticatedRecoveryContext,
  uploads?: RecoveryUploadResolver,
): Promise<PreparedUpload | null> {
  if (input.uploadHandle === undefined) return null;
  demand(uploads, "UPLOAD_AUTHORITY_UNAVAILABLE", 503);
  const upload = preparedUploadSchema.parse(
    await uploads.resolve(input.uploadHandle, context),
  );
  demand(
    upload.uploadHandle === input.uploadHandle &&
      upload.workspace.ownerId === context.workspace.ownerId &&
      upload.workspace.workspaceId === context.workspace.workspaceId &&
      upload.actorId === context.actor.id &&
      upload.expiresAt > context.serverTime,
    "UPLOAD_AUTHORITY_MISMATCH",
    403,
  );
  return upload;
}

export function sameSaveInput(
  left: SaveVersionInput,
  right: SaveVersionInput,
): boolean {
  function value(input: SaveVersionInput) {
    return {
      requestKey: input.requestKey,
      lineageId: input.lineageId,
      entityId: input.entityId,
      kind: input.kind,
      expectedParentIds: input.expectedParentIds,
      branchRequested: input.branchRequested,
      sourceVersionIds: input.sourceVersionIds,
      content:
        input.uploadHandle !== undefined
          ? { type: "upload", handle: input.uploadHandle }
          : input.content instanceof Uint8Array
            ? {
                type: "bytes",
                digest: artifactDigest(input.content),
                sizeBytes: input.content.length,
              }
            : { type: "structured", value: input.content },
    };
  }
  const a = canonicalizeEnvelope(value(left)),
    b = canonicalizeEnvelope(value(right));
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
