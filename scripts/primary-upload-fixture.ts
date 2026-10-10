import {
  createRecoveryIntakeBudget,
  createUploadIntake,
} from "../src/application/recovery-uploads";
import type {
  AuthenticatedRecoveryContext,
  PrimaryArchive,
  UploadAuthority,
} from "../src/application/recovery-ports";
import { demand } from "../src/domain/model";
import { MAX_ORIGINAL_BYTES } from "../src/domain/recovery-limits";
import { UPLOAD_CHUNK_BYTES } from "../src/domain/recovery-upload";
import { createPrimaryArchive } from "../src/storage/primary-archive";
import {
  createArtifactHash,
  inspectArtifactStream,
  openVerifiedArtifact,
  readBoundedBytes,
} from "../src/storage/recovery-streams";
import { equalMetadata } from "../src/storage/recovery-metadata";

export function uploadFixture(archive: PrimaryArchive, namespace: string) {
  const context: AuthenticatedRecoveryContext = {
    workspace: {
      ownerId: "synthetic-owner",
      workspaceId: "synthetic-workspace",
    },
    actor: {
      id: "client:synthetic-upload",
      kind: "service",
      scopes: ["write"],
      expiresAt: 2000000000,
    },
    issuer: "synthetic-host",
    audience: "job-stack",
    grant: {
      id: "synthetic-grant",
      revision: "1",
      scopes: ["write"],
      resourceBounds: [{ kind: "workspace", id: "synthetic-workspace" }],
      expiresAt: 2000000000,
    },
    chain: {
      epochId: "synthetic-epoch",
      sequence: "0",
      previousTransactionDigest: null,
    },
    serverTime: 1000,
  };
  let revoked = false;
  let now = 1000;
  const authority: UploadAuthority = {
    async authorize(supplied) {
      demand(
        !revoked && equalMetadata(supplied, context),
        "SYNTHETIC_AUTHORITY_DENIED",
      );
      return { context, namespace, now, expiresAt: 1000000000 };
    },
  };
  const budget = createRecoveryIntakeBudget();
  const intake = createUploadIntake({ archive, authority, budget });
  return {
    context,
    authority,
    budget,
    intake,
    revoke() {
      revoked = true;
    },
    setNow(value: number) {
      now = value;
    },
  };
}
function original(sizeBytes: number) {
  return {
    sizeBytes,
    fileName: "Exact synthetic Voice Memo.M4A",
    mediaType: "audio/mp4",
    format: "M4A",
    lastModified: 999,
  };
}
async function reject(run: () => Promise<unknown>, label: string) {
  try {
    await run();
  } catch {
    return;
  }
  throw new Error(`EXPECTED_REJECTION:${label}`);
}

export async function largeUpload(
  bucket: R2Bucket,
  namespace: string,
  sizeBytes: number,
) {
  const started = Date.now();
  const archive = createPrimaryArchive(bucket);
  const f = uploadFixture(archive, namespace);
  await reject(
    () =>
      f.intake.begin(
        {
          requestKey: "over-limit",
          original: original(MAX_ORIGINAL_BYTES + 1),
        },
        f.context,
      ),
    "over_limit",
  );
  const session = await f.intake.begin(
    { requestKey: "large-start", original: original(sizeBytes) },
    f.context,
  );
  const expected = createArtifactHash();
  let written = 0;
  let maxBuffer = 0;
  for (let ordinal = 0; ordinal < session.partCount; ordinal++) {
    const length = Math.min(UPLOAD_CHUNK_BYTES, sizeBytes - written);
    const bytes = new Uint8Array(length);
    bytes.fill(ordinal % 251);
    for (let offset = 0; offset < length; offset += 65536)
      bytes[offset] = (ordinal + offset / 65536) % 251;
    expected.update(bytes);
    maxBuffer = Math.max(maxBuffer, bytes.length);
    const result = await f.intake.putChunk(
      {
        uploadHandle: session.uploadHandle,
        ordinal,
        requestKey: `part-${ordinal}`,
        body: new Blob([bytes]).stream(),
      },
      f.context,
    );
    demand(
      result.receipt.ordinal === ordinal &&
        result.receipt.artifact.sizeBytes === length,
      "CHUNK_RECEIPT_MISMATCH",
    );
    written += length;
  }
  const expectedDigest = expected.digest("hex");
  const ready = await f.intake.complete(session.uploadHandle, f.context);
  demand(
    ready.artifact.digest === expectedDigest &&
      ready.artifact.sizeBytes === sizeBytes,
    "WHOLE_ORIGINAL_MISMATCH",
  );
  // New service instance, same lifecycle-owned authority/budget; no D1 exists here.
  const reconstructed = await createUploadIntake({
    archive,
    authority: f.authority,
    budget: f.budget,
  }).resolve(session.uploadHandle, f.context);
  demand(
    equalMetadata(ready, reconstructed),
    "R2_ONLY_RECONSTRUCTION_MISMATCH",
  );
  const download = await openVerifiedArtifact(archive, ready.artifact);
  const read = await inspectArtifactStream(download.body, sizeBytes);
  demand(read.digest === expectedDigest, "STREAM_DOWNLOAD_MISMATCH");
  await reject(() => archive.get(ready.artifact.object), "large_byte_api");
  const selected = await archive.get(ready.selection.object);
  demand(selected && selected.bytes.length <= 131072, "SELECTION_TOO_LARGE");
  return {
    sizeBytes,
    partCount: session.partCount,
    expectedDigest,
    digest: ready.artifact.digest,
    maxInputBufferBytes: maxBuffer,
    selectionBytes: selected.bytes.length,
    reconstructed: true,
    verifiedDownload: true,
    complete: true,
    elapsedMs: Date.now() - started,
    original: ready.original,
    artifact: ready.artifact,
  };
}

export async function uploadFailures(bucket: R2Bucket, namespace: string) {
  const archive = createPrimaryArchive(bucket);
  const f = uploadFixture(archive, namespace);
  const bytes = new Uint8Array([0, 255, 13, 10, 23]);
  const session = await f.intake.begin(
    { requestKey: "failure-start", original: original(5) },
    f.context,
  );
  const chunk = (data = bytes) => ({
    uploadHandle: session.uploadHandle,
    ordinal: 0,
    requestKey: "part",
    body: new Blob([new Uint8Array(data)]).stream(),
  });
  await reject(
    () => f.intake.complete(session.uploadHandle, f.context),
    "incomplete",
  );
  await reject(
    () => f.intake.putChunk(chunk(new Uint8Array(6)), f.context),
    "oversize_chunk",
  );
  await reject(
    () => f.intake.putChunk(chunk(new Uint8Array(4)), f.context),
    "partial_chunk",
  );
  await reject(
    () => f.intake.putChunk({ ...chunk(), ordinal: 1 }, f.context),
    "invalid_ordinal",
  );
  const results = await Promise.all([
    f.intake.putChunk(chunk(), f.context),
    f.intake.putChunk(chunk(), f.context),
  ]);
  demand(equalMetadata(results[0], results[1]), "IMMUTABLE_RECEIPT_RACE");
  await reject(
    () => f.intake.putChunk(chunk(new Uint8Array(5)), f.context),
    "changed_body",
  );
  const ready = await f.intake.complete(session.uploadHandle, f.context);
  demand(ready.complete, "NOT_READY");
  const exact = await archive.getStream(ready.artifact.object);
  demand(exact, "MISSING");
  const restored = await readBoundedBytes(exact.body, 5, 5);
  demand(
    restored.every((b, i) => b === bytes[i]),
    "EXACT_BYTES_LOST",
  );
  f.setNow(1000000000);
  await reject(
    () => f.intake.resolve(session.uploadHandle, f.context),
    "expired",
  );
  f.setNow(1000);
  f.revoke();
  await reject(
    () => f.intake.resolve(session.uploadHandle, f.context),
    "revoked",
  );
  return { checks: 10, readyDigest: ready.artifact.digest, exactBytes: true };
}
