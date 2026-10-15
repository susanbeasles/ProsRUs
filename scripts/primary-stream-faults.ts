import { selectedOriginalStream } from "../src/storage/recovery-upload-inventory";
import { createPrimaryArchive } from "../src/storage/primary-archive";
import { inspectArtifactStream } from "../src/storage/recovery-streams";
import { demand } from "../src/domain/model";

function body(bytes: Uint8Array) {
  return new Blob([new Uint8Array(bytes)]).stream();
}
export async function streamFaults(bucket: R2Bucket, namespace: string) {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const inspected = await inspectArtifactStream(body(bytes), 5);
  const object = {
    provider: "primary" as const,
    namespace,
    key: `blobs/${inspected.digest}`,
    versionId: null,
  };
  const input = {
    object,
    hashPurpose: "blob" as const,
    digest: inspected.digest,
    transportSha256: inspected.rawSha256,
    sizeBytes: 5,
  };
  const sinkFailure = new Proxy(bucket, {
    get(target, property) {
      if (property === "put")
        return async () => {
          throw new Error("synthetic provider sink failure");
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let cancelled = false;
  let stop: () => void = () => undefined;
  const stalled = new ReadableStream<Uint8Array>({
    start(controller) {
      stop = () => controller.error(new Error("fixture cancellation cleanup"));
    },
    pull() {
      return new Promise<void>(() => undefined);
    },
    cancel() {
      cancelled = true;
    },
  });
  const pending = createPrimaryArchive(sinkFailure)
    .putImmutableStream({ ...input, body: stalled })
    .then(
      () => "accepted",
      () => "rejected",
    );
  const outcome = await Promise.race([
    pending,
    new Promise<string>((resolve) =>
      setTimeout(() => resolve("timeout"), 1000),
    ),
  ]);
  if (outcome === "timeout") {
    stop();
    await pending;
  }
  demand(
    outcome === "rejected" && cancelled,
    "SINK_FAILURE_DID_NOT_CANCEL_SOURCE",
  );
  const archive = createPrimaryArchive(bucket);
  const saved = await archive.putImmutableStream({
    ...input,
    body: body(bytes),
  });
  const conditionalNull = new Proxy(bucket, {
    get(target, property) {
      if (property === "head") return async () => null;
      if (property === "put") return async () => null;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let rejected = false;
  try {
    await createPrimaryArchive(conditionalNull).putImmutableStream({
      ...input,
      body: body(new Uint8Array(5)),
    });
  } catch {
    rejected = true;
  }
  demand(rejected, "CONDITIONAL_SKIP_ACCEPTED_CHANGED_BODY");
  const retry = await createPrimaryArchive(conditionalNull).putImmutableStream({
    ...input,
    body: body(bytes),
  });
  demand(
    retry.object.versionId === saved.object.versionId,
    "CONDITIONAL_SKIP_LOST_IDENTITY",
  );
  const lostResponse = new Proxy(bucket, {
    get(target, property) {
      if (property === "put")
        return async (
          key: string,
          value:
            | ReadableStream
            | ArrayBuffer
            | ArrayBufferView
            | string
            | null
            | Blob,
          options?: R2PutOptions,
        ) => {
          await target.put(key, value, options);
          throw new Error("synthetic lost response");
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const lostInput = {
    ...input,
    object: { ...object, key: "lost-response/blob" },
  };
  const reconciled = await createPrimaryArchive(
    lostResponse,
  ).putImmutableStream({ ...lostInput, body: body(bytes) });
  demand(
    reconciled.outcome === "matched_existing",
    "LOST_RESPONSE_NOT_RECONCILED",
  );
  let selectedCancelled = false;
  let sourceOpened: () => void = () => undefined;
  let unblock: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    sourceOpened = resolve;
  });
  const pinned = await archive.getStream(saved.object);
  demand(pinned, "PINNED_SOURCE_MISSING");
  const delayed = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        unblock = () => controller.close();
      },
      pull() {
        sourceOpened();
      },
      async cancel() {
        selectedCancelled = true;
        await pinned.body.cancel();
      },
    },
    { highWaterMark: 0 },
  );
  const selected = selectedOriginalStream(
    {
      ...archive,
      async getStream() {
        return { ...pinned, body: delayed };
      },
    },
    [
      {
        formatVersion: 1,
        type: "upload_part",
        sessionId: "session",
        workspace: { ownerId: "owner", workspaceId: "workspace" },
        actorId: "actor",
        session: {
          formatVersion: 1,
          hashPurpose: "inventory",
          digest: "0".repeat(64),
          sizeBytes: 1,
          mediaType: "application/json",
          object: saved.object,
        },
        ordinal: 0,
        requestKey: "part",
        artifact: {
          schemaVersion: 1,
          hashAlgorithm: "sha256-domain-v1",
          digest: inspected.digest,
          sizeBytes: 5,
          mediaType: "application/octet-stream",
          object: saved.object,
        },
      },
    ],
  );
  const selectedReader = selected.getReader();
  const pendingRead = selectedReader.read();
  await opened;
  const cancelledRead = selectedReader.cancel();
  const cancellationOutcome = await Promise.race([
    cancelledRead.then(() => "cancelled"),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve("timeout"), 1000),
    ),
  ]);
  if (cancellationOutcome === "timeout") unblock();
  await Promise.allSettled([pendingRead, cancelledRead]);
  selectedReader.releaseLock();
  demand(
    cancellationOutcome === "cancelled" && selectedCancelled,
    "SELECTED_SOURCE_CANCELLATION_STALLED",
  );
  return {
    checks: 5,
    sinkCancellation: true,
    selectedSourceCancellation: true,
    changedBodyRejected: true,
    conditionalNullSettled: true,
    lostResponseReconciled: true,
  };
}
