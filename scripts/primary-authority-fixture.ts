import {
  createRecoveryIntakeBudget,
  createUploadIntake,
} from "../src/application/recovery-uploads";
import type {
  PrimaryArchive,
  UploadAuthority,
} from "../src/application/recovery-ports";
import { demand, DomainError } from "../src/domain/model";
import { createPrimaryArchive } from "../src/storage/primary-archive";
import { uploadFixture } from "./primary-upload-fixture";

async function rejects(operation: () => Promise<unknown>, expected: string) {
  try {
    await operation();
  } catch (error) {
    demand(
      error instanceof Error && error.message.includes(expected),
      `WRONG_REJECTION:${expected}`,
    );
    return;
  }
  throw new Error(`EXPECTED_REJECTION:${expected}`);
}

/** Real local R2, synthetic current authority; no provider credentials or remote calls. */
export async function authorityFailures(bucket: R2Bucket, namespace: string) {
  const primary = createPrimaryArchive(bucket);
  const original = {
    sizeBytes: 3,
    fileName: "memo.M4A",
    mediaType: "audio/mp4",
    format: "M4A",
    lastModified: null,
  };
  let lostAt = "";
  let revokeAt = "";
  let revoked = false;
  let expiresAt = 50000;
  const base = uploadFixture(primary, namespace);
  const { context } = base;
  const authority: UploadAuthority = {
    async authorize(supplied) {
      if (revoked) throw new DomainError("CURRENT_GRANT_REVOKED", 403);
      return { context: supplied, now: 1000, namespace, expiresAt };
    },
  };
  const archive: PrimaryArchive = {
    ...primary,
    async putImmutable(input) {
      const result = await primary.putImmutable(input);
      if (revokeAt && input.object.key.endsWith(revokeAt)) revoked = true;
      if (lostAt && input.object.key.endsWith(lostAt)) {
        lostAt = "";
        throw new DomainError("LOST_STAGE_RESPONSE");
      }
      return result;
    },
  };
  const budget = createRecoveryIntakeBudget();
  const intake = createUploadIntake({ archive, authority, budget });
  const begin = () => intake.begin({ requestKey: "start", original }, context);
  const bytes = new Uint8Array([0, 255, 17]);
  lostAt = "/requests/start";
  await rejects(begin, "LOST_STAGE_RESPONSE");
  const session = await begin();
  demand(
    (await begin()).uploadHandle === session.uploadHandle,
    "START_RETRY_IDENTITY",
  );
  const chunk = () => ({
    uploadHandle: session.uploadHandle,
    ordinal: 0,
    requestKey: "part",
    body: new Blob([bytes]).stream(),
  });
  expiresAt = 1000;
  await rejects(
    () => intake.putChunk(chunk(), context),
    "EXPIRED_RECOVERY_AUTHORITY",
  );
  expiresAt = 50000;
  await rejects(
    () =>
      intake.putChunk(chunk(), {
        ...context,
        workspace: { ...context.workspace, ownerId: "other" },
      }),
    "UPLOAD_NOT_FOUND",
  );
  await rejects(
    () =>
      intake.putChunk(chunk(), {
        ...context,
        workspace: { ...context.workspace, workspaceId: "other" },
      }),
    "UPLOAD_NOT_FOUND",
  );
  await rejects(
    () =>
      intake.putChunk(chunk(), {
        ...context,
        grant: { ...context.grant, revision: "2" },
      }),
    "UPLOAD_AUTHORITY_MISMATCH",
  );
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = [
    budget.run("chunk", () => wait),
    budget.run("chunk", () => wait),
  ];
  let cancelled = false;
  let reads = 0;
  const unread = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads++;
        controller.enqueue(bytes);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  try {
    await rejects(
      () => intake.putChunk({ ...chunk(), body: unread }, context),
      "INTAKE_CAPACITY_EXCEEDED",
    );
    demand(cancelled && reads === 0, "DENIED_BODY_NOT_CANCELLED");
  } finally {
    release();
    await Promise.all(active);
  }
  lostAt = "/parts/000";
  await rejects(() => intake.putChunk(chunk(), context), "LOST_STAGE_RESPONSE");
  const receipt = await intake.putChunk(chunk(), context);
  demand(
    (await intake.putChunk(chunk(), context)).receiptObject.object.versionId ===
      receipt.receiptObject.object.versionId,
    "RECEIPT_RETRY_IDENTITY",
  );
  await rejects(
    () => intake.putChunk({ ...chunk(), requestKey: "changed" }, context),
    "UPLOAD_PART_CONFLICT",
  );
  lostAt = "/selection";
  await rejects(
    () => intake.complete(session.uploadHandle, context),
    "LOST_STAGE_RESPONSE",
  );
  lostAt = "/ready";
  await rejects(
    () => intake.complete(session.uploadHandle, context),
    "LOST_STAGE_RESPONSE",
  );
  const ready = await intake.complete(session.uploadHandle, context);
  demand(
    ready.complete && !JSON.stringify(ready).includes("saved_primary"),
    "FALSE_SAVE_ACKNOWLEDGMENT",
  );
  expiresAt = 1000;
  await rejects(
    () => intake.resolve(session.uploadHandle, context),
    "EXPIRED_RECOVERY_AUTHORITY",
  );
  expiresAt = 50000;
  const second = await intake.begin(
    { requestKey: "second", original },
    context,
  );
  revokeAt = "/parts/000";
  await rejects(
    () =>
      intake.putChunk(
        { ...chunk(), uploadHandle: second.uploadHandle },
        context,
      ),
    "CURRENT_GRANT_REVOKED",
  );
  revokeAt = "";
  revoked = false;
  demand(
    (await intake.complete(second.uploadHandle, context)).complete,
    "RETAINED_REVOKED_STAGE_MISSING",
  );
  return {
    checks: 14,
    admissionCancellation: true,
    currentDeadline: true,
    ownerWorkspaceGrantDenials: true,
    lostResponsesReconciled: true,
    postPersistenceRevocation: true,
    noSaveAcknowledgment: true,
  };
}
