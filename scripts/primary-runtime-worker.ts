import { authorityFailures } from "./primary-authority-fixture";
import { streamFaults } from "./primary-stream-faults";
import { packageFixture } from "./primary-package-fixture";
import { largeUpload, uploadFailures } from "./primary-upload-fixture";
import { createPrimaryArchive } from "../src/storage/primary-archive";
import {
  artifactDigest,
  inspectArtifactStream,
  openVerifiedArtifact,
  readBoundedBytes,
} from "../src/storage/recovery-streams";

function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`CHECK_FAILED:${label}`);
}
async function rejects(run: () => Promise<unknown>, label: string) {
  try {
    await run();
  } catch {
    return;
  }
  throw new Error(`EXPECTED_REJECTION:${label}`);
}
function body(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function streams(bucket: R2Bucket, namespace: string) {
  const archive = createPrimaryArchive(bucket);
  const bytes = new Uint8Array([0, 255, 13, 10, 23, 17, 0]);
  const inspected = await inspectArtifactStream(body(bytes), bytes.length);
  const object = {
    provider: "primary" as const,
    namespace,
    key: `blobs/${inspected.digest}`,
    versionId: null,
  };
  const input = {
    object,
    digest: inspected.digest,
    hashPurpose: "blob" as const,
    sizeBytes: bytes.length,
    transportSha256: inspected.rawSha256,
  };
  const first = await archive.putImmutableStream({
    ...input,
    body: body(bytes),
  });
  check(first.outcome === "created", "created");
  const retry = await archive.putImmutableStream({
    ...input,
    body: body(bytes),
  });
  check(
    retry.outcome === "matched_existing" &&
      retry.object.versionId === first.object.versionId,
    "matching_retry",
  );
  const descriptor = {
    schemaVersion: 1 as const,
    hashAlgorithm: "sha256-domain-v1" as const,
    mediaType: "application/octet-stream",
    sizeBytes: bytes.length,
    digest: inspected.digest,
    object: first.object,
  };
  const verified = await openVerifiedArtifact(archive, descriptor);
  check(
    artifactDigest(await readBoundedBytes(verified.body, bytes.length)) ===
      inspected.digest,
    "verified_download",
  );
  for (const length of [bytes.length - 1, bytes.length + 1]) {
    const candidate = { ...object, key: `partial/${length}` };
    await rejects(
      () =>
        archive.putImmutableStream({
          ...input,
          object: candidate,
          body: body(new Uint8Array(length)),
        }),
      `length_${length}`,
    );
    check((await archive.get(candidate)) === null, `no_partial_${length}`);
  }
  const broken = { ...object, key: "partial/error" };
  await rejects(
    () =>
      archive.putImmutableStream({
        ...input,
        object: broken,
        body: new ReadableStream({
          start(controller) {
            controller.error(new Error("synthetic interrupted source"));
          },
        }),
      }),
    "source_interruption",
  );
  check((await archive.get(broken)) === null, "no_interrupted_object");
  const wrongChecksum = { ...object, key: "partial/checksum" };
  await rejects(
    () =>
      archive.putImmutableStream({
        ...input,
        object: wrongChecksum,
        transportSha256: "0".repeat(64),
        body: body(bytes),
      }),
    "transport_checksum",
  );
  check((await archive.get(wrongChecksum)) === null, "no_checksum_object");
  return { checks: 10, digest: inspected.digest, sizeBytes: bytes.length };
}
export default {
  async fetch(request: Request, env: { BUCKET: R2Bucket; DB: D1Database }) {
    try {
      const url = new URL(request.url);
      const namespace = url.searchParams.get("namespace") ?? "local-primary";
      if (url.pathname === "/authority-failures")
        return Response.json(await authorityFailures(env.BUCKET, namespace));
      if (url.pathname === "/stream-faults")
        return Response.json(await streamFaults(env.BUCKET, namespace));
      if (url.pathname === "/streams")
        return Response.json(await streams(env.BUCKET, namespace));
      if (url.pathname === "/packages")
        return Response.json(
          await packageFixture(env.BUCKET, env.DB, namespace),
        );
      if (url.pathname === "/uploads")
        return Response.json(await uploadFailures(env.BUCKET, namespace));
      if (url.pathname === "/large")
        return Response.json(
          await largeUpload(
            env.BUCKET,
            namespace,
            Number(url.searchParams.get("length") ?? 1073741824),
          ),
        );
      return new Response("unknown fixture", { status: 404 });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
