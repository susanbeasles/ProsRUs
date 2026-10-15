import { z } from "zod";
import { demand } from "../domain/model";
import type { DomainPlan } from "../domain/recovery-domain-plan";
import type { BlobDescriptor, VersionManifest } from "../domain/recovery";
import { originalFileSchema } from "../domain/recovery-upload";

type Candidate = DomainPlan["candidates"][number];
const committedFileSnapshot = z.union([
  z
    .object({
      type: z.literal("exact_bytes"),
      sizeBytes: z.number().int().positive().max(1073741824),
    })
    .strict(),
  z
    .object({ type: z.literal("exact_original"), original: originalFileSchema })
    .strict(),
]);
export function isOriginalRole(candidate: Candidate, role: string): boolean {
  return (
    candidate.observation?.originalArtifact === "observed" &&
    candidate.observation.original.artifactRole === role
  );
}
/** A committed raw-row/snapshot artifact is not a full file merely because a new
 * plan gives it an original-file role. Only existing exact-file captures qualify. */
export function validateCommittedOriginal(
  manifest: VersionManifest,
  index: number,
): void {
  const parsed = committedFileSnapshot.safeParse(manifest.recordSnapshot);
  const descriptor = manifest.artifacts[index];
  demand(
    parsed.success &&
      descriptor &&
      index === 0 &&
      manifest.artifacts.length === 1,
    "DOMAIN_COMMITTED_ORIGINAL_REQUIRED",
  );
  const expectedSize =
    parsed.data.type === "exact_bytes"
      ? parsed.data.sizeBytes
      : parsed.data.original.sizeBytes;
  demand(
    descriptor.sizeBytes === expectedSize,
    "DOMAIN_COMMITTED_ORIGINAL_REQUIRED",
  );
}
/** The role maps to this candidate's actual signed descriptor. Verification of
 * its complete bytes is performed by the common archive builder/reconstructor. */
export function validateOriginalDescriptor(
  candidate: Candidate,
  artifacts: readonly BlobDescriptor[],
): void {
  const observation = candidate.observation;
  if (observation?.originalArtifact !== "observed") return;
  const index = candidate.artifacts.findIndex(
    (a) => a.role === observation.original.artifactRole,
  );
  const descriptor = artifacts[index + 1];
  demand(index >= 0 && descriptor, "DOMAIN_ORIGINAL_SOURCE_REQUIRED");
  demand(
    descriptor.digest === observation.original.digest &&
      descriptor.sizeBytes === observation.original.sizeBytes &&
      descriptor.mediaType === observation.original.mediaType,
    "DOMAIN_ORIGINAL_DESCRIPTOR_MISMATCH",
  );
}
