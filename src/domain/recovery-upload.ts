import { z } from "zod";
import {
  archiveMetadataDescriptorSchema,
  blobDescriptorSchema,
  principalIdentitySchema,
  canonicalIdentitySchema,
  workspaceRefSchema,
} from "./recovery";
import { MAX_ARCHIVE_BYTES, MAX_ORIGINAL_BYTES } from "./recovery-limits";

export const MAX_UPLOAD_PARTS = 128;
export const UPLOAD_CHUNK_BYTES = MAX_ARCHIVE_BYTES;
export const originalFileSchema = z
  .object({
    sizeBytes: z.number().int().min(1).max(MAX_ORIGINAL_BYTES),
    fileName: z.string().min(1).max(1024),
    mediaType: z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/),
    format: z.string().max(128).nullable(),
    lastModified: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
  })
  .strict()
  .readonly();
export type OriginalFile = z.infer<typeof originalFileSchema>;
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const uploadSessionSchema = z
  .object({
    formatVersion: z.literal(1),
    type: z.literal("upload_session"),
    sessionId: identifier,
    workspace: workspaceRefSchema,
    actorId: principalIdentitySchema,
    namespace: identifier,
    grantId: canonicalIdentitySchema,
    grantRevision: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .max(100),
    issuer: z.string().min(1).max(2048),
    audience: z.string().min(1).max(2048),
    original: originalFileSchema,
    createdAt: timestamp,
    expiresAt: timestamp,
    chunkBytes: z.literal(UPLOAD_CHUNK_BYTES),
    partCount: z.number().int().min(1).max(MAX_UPLOAD_PARTS),
  })
  .strict()
  .refine(
    (value) =>
      value.expiresAt > value.createdAt &&
      value.partCount ===
        Math.ceil(value.original.sizeBytes / UPLOAD_CHUNK_BYTES),
    "INVALID_UPLOAD_SESSION",
  )
  .readonly();
export type UploadSession = z.infer<typeof uploadSessionSchema>;
export const uploadPartReceiptSchema = z
  .object({
    formatVersion: z.literal(1),
    type: z.literal("upload_part"),
    sessionId: identifier,
    workspace: workspaceRefSchema,
    actorId: principalIdentitySchema,
    session: archiveMetadataDescriptorSchema,
    ordinal: z
      .number()
      .int()
      .min(0)
      .max(MAX_UPLOAD_PARTS - 1),
    requestKey: identifier,
    artifact: blobDescriptorSchema,
  })
  .strict()
  .readonly();
export type UploadPartReceipt = z.infer<typeof uploadPartReceiptSchema>;
export const uploadSelectionSchema = z
  .object({
    formatVersion: z.literal(1),
    type: z.literal("upload_selection"),
    session: archiveMetadataDescriptorSchema,
    parts: z
      .array(archiveMetadataDescriptorSchema)
      .min(1)
      .max(MAX_UPLOAD_PARTS)
      .readonly(),
  })
  .strict()
  .readonly();
export const preparedUploadSchema = z
  .object({
    formatVersion: z.literal(1),
    type: z.literal("upload_ready"),
    uploadHandle: identifier,
    workspace: workspaceRefSchema,
    actorId: principalIdentitySchema,
    artifact: blobDescriptorSchema,
    complete: z.literal(true),
    expiresAt: timestamp,
    original: originalFileSchema,
    session: archiveMetadataDescriptorSchema,
    selection: archiveMetadataDescriptorSchema,
  })
  .strict()
  .readonly();
export type PreparedUpload = z.infer<typeof preparedUploadSchema>;
export function uploadPrefix(
  session: Pick<UploadSession, "workspace" | "sessionId">,
): string {
  return `uploads/${session.workspace.ownerId}/${session.workspace.workspaceId}/${session.sessionId}`;
}

export const uploadRequestSchema = z
  .object({
    formatVersion: z.literal(1),
    type: z.literal("upload_request"),
    requestKey: identifier,
    original: originalFileSchema,
    session: archiveMetadataDescriptorSchema,
  })
  .strict()
  .readonly();
