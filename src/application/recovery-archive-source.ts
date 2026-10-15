import { demand } from "../domain/model";
import {
  canonicalizeEnvelope,
  hashEnvelope,
} from "../domain/recovery-canonical";
import type { ArchivedOriginalSource } from "../domain/recovery-domain-plan";
import type { VersionManifest } from "../domain/recovery";
import { validateCommittedOriginal } from "./recovery-domain-original";
/** Checks historical byte/identity correspondence, never current permission.4I
 * independently resolves retained upload purpose/capture and live source policy. */
export async function validateArchivedOriginalSource(
  source: ArchivedOriginalSource,
  manifest: VersionManifest,
): Promise<void> {
  demand(
    manifest.entityId === source.entityId &&
      manifest.kind === source.kind &&
      manifest.lineageId === source.lineageId &&
      manifest.versionId === source.versionId &&
      manifest.transactionId === source.capture.transactionId &&
      (await hashEnvelope("manifest", manifest)) === source.manifestDigest,
    "ARCHIVE_SOURCE_MANIFEST_MISMATCH",
  );
  validateCommittedOriginal(manifest, 0);
  const snapshot = manifest.recordSnapshot;
  demand(
    snapshot &&
      typeof snapshot === "object" &&
      !Array.isArray(snapshot) &&
      "type" in snapshot &&
      snapshot.type === "exact_original",
    "ARCHIVE_SOURCE_ORIGINAL_CAPTURE_REQUIRED",
  );
  demand(
    new TextDecoder().decode(canonicalizeEnvelope(snapshot)) ===
      source.projectionBody,
    "ARCHIVE_SOURCE_PROJECTION_MISMATCH",
  );
  const original = manifest.artifacts[0];
  demand(
    original &&
      original.digest === source.original.digest &&
      original.sizeBytes === source.original.sizeBytes &&
      original.mediaType === source.original.mediaType,
    "ARCHIVE_SOURCE_ARTIFACT_MISMATCH",
  );
}
