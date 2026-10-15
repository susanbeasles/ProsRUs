import { z } from "zod";
import {
  archiveMetadataDescriptorSchema,
  preparedEnvelopePayloadSchema,
  preparedEnvelopeSchema,
  primaryPackageBindingSchema,
  versionManifestSchema,
} from "./recovery";

/** The immutable core omits only its own later packageBinding. It includes the full
 * proposed transaction and full candidate/parent/source manifests, not just hashes. */
export const primaryPackageSchema = z
  .object({
    formatVersion: z.literal(1),
    type: z.literal("recovery_package"),
    commitStatus: z.literal("unknown"),
    proposed: preparedEnvelopePayloadSchema.refine(
      (value) =>
        value.packageBinding === undefined &&
        value.packageObject.versionId === null,
      "CIRCULAR_PACKAGE_BINDING",
    ),
    parents: z.array(versionManifestSchema).readonly(),
    sources: z.array(versionManifestSchema).readonly(),
    manifests: z
      .array(
        z
          .object({
            versionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
            descriptor: archiveMetadataDescriptorSchema,
          })
          .strict()
          .readonly(),
      )
      .readonly(),
  })
  .strict()
  .readonly();
export type PrimaryPackage = z.infer<typeof primaryPackageSchema>;
export const preparedWrapperSchema = z
  .object({
    formatVersion: z.literal(1),
    type: z.literal("prepared_wrapper"),
    commitStatus: z.literal("unknown"),
    packageBinding: primaryPackageBindingSchema,
    prepared: preparedEnvelopeSchema.refine(
      (value) => value.packageBinding !== undefined,
      "PACKAGE_BINDING_REQUIRED",
    ),
  })
  .strict()
  .readonly();
export type PreparedWrapper = z.infer<typeof preparedWrapperSchema>;

export function unboundPayload(
  payload: import("./recovery").PreparedEnvelopePayload,
): import("./recovery").PreparedEnvelopePayload {
  const { packageBinding, ...core } = payload;
  void packageBinding;
  return core;
}
