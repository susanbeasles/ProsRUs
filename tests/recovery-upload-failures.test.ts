import { describe, expect, it } from "vitest";
import {
  createRecoveryIntakeBudget,
  createUploadIntake,
} from "../src/application/recovery-uploads";
import type {
  PrimaryArchive,
  UploadAuthority,
} from "../src/application/recovery-ports";
import { DomainError } from "../src/domain/model";
import { primaryContext as context } from "./fixtures/primary-preparation";
import { memoryArchive } from "./fixtures/primary-memory";

const original = {
  sizeBytes: 3,
  fileName: "memo.m4a",
  mediaType: "audio/mp4",
  format: "M4A",
  lastModified: null,
};
const bytes = new Uint8Array([0, 255, 17]);
function fixture() {
  const memory = memoryArchive();
  let revoked = false;
  let expiresAt = 50000;
  let afterWrite: (key: string) => void = () => undefined;
  const authority: UploadAuthority = {
    async authorize(supplied) {
      if (revoked) throw new DomainError("CURRENT_GRANT_REVOKED", 403);
      return { context: supplied, now: 1000, namespace: "recovery", expiresAt };
    },
  };
  const archive: PrimaryArchive = {
    ...memory.archive,
    async putImmutable(input) {
      const result = await memory.archive.putImmutable(input);
      afterWrite(input.object.key);
      return result;
    },
  };
  const budget = createRecoveryIntakeBudget();
  const intake = createUploadIntake({ archive, authority, budget });
  return {
    ...memory,
    archive,
    intake,
    budget,
    authority,
    revoke() {
      revoked = true;
    },
    restore() {
      revoked = false;
    },
    expire() {
      expiresAt = 1000;
    },
    afterWrite(action: typeof afterWrite) {
      afterWrite = action;
    },
  };
}
function chunk(uploadHandle: string, requestKey = "part") {
  return {
    uploadHandle,
    ordinal: 0,
    requestKey,
    body: new Blob([bytes]).stream(),
  };
}
async function started(f: ReturnType<typeof fixture>) {
  return f.intake.begin({ requestKey: "start", original }, context);
}

// Removing the current host deadline check would accept these operations despite
// a newly expired authorization lease, even while the archived session is valid.
describe("current upload authority deadline", () => {
  it("rejects a newly expired host lease before chunk persistence", async () => {
    const f = fixture();
    const session = await started(f);
    f.expire();
    await expect(
      f.intake.putChunk(chunk(session.uploadHandle), context),
    ).rejects.toThrow("EXPIRED_RECOVERY_AUTHORITY");
    expect([...f.objects.keys()].some((key) => key.includes("/parts/"))).toBe(
      false,
    );
  });
  it("rejects a newly expired host lease before returning a ready handle", async () => {
    const f = fixture();
    const session = await started(f);
    await f.intake.putChunk(chunk(session.uploadHandle), context);
    await f.intake.complete(session.uploadHandle, context);
    f.expire();
    await expect(
      f.intake.resolve(session.uploadHandle, context),
    ).rejects.toThrow("EXPIRED_RECOVERY_AUTHORITY");
  });
});

describe("upload failure reconciliation", () => {
  it.each(["/requests/start", "/parts/000", "/selection", "/ready"])(
    "keeps durable evidence after a lost %s response and reconciles a matching retry",
    async (stage) => {
      const f = fixture();
      if (stage === "/requests/start") {
        f.failNextAfter(stage);
        await expect(started(f)).rejects.toThrow("SYNTHETIC_LOST_RESPONSE");
        const count = f.objects.size;
        const session = await started(f);
        expect(f.objects.size).toBe(count);
        expect((await started(f)).uploadHandle).toBe(session.uploadHandle);
        return;
      }
      const session = await started(f);
      const upload = () =>
        f.intake.putChunk(chunk(session.uploadHandle), context);
      const complete = () => f.intake.complete(session.uploadHandle, context);
      const operation = stage === "/parts/000" ? upload : complete;
      if (stage !== "/parts/000") await upload();
      f.failNextAfter(stage);
      await expect(operation()).rejects.toThrow("SYNTHETIC_LOST_RESPONSE");
      const retained = [...f.objects.values()].find((value) =>
        value.object.key.endsWith(stage),
      );
      expect(retained).toBeDefined();
      await operation();
      expect(
        [...f.objects.values()].find((value) =>
          value.object.key.endsWith(stage),
        )?.object,
      ).toEqual(retained?.object);
      const ready = await complete();
      expect(
        await createUploadIntake({
          archive: f.archive,
          authority: f.authority,
          budget: f.budget,
        }).resolve(session.uploadHandle, context),
      ).toEqual(ready);
      expect(JSON.stringify(ready)).not.toContain("saved_primary");
    },
  );
  it("rejects a different chunk request identity without changing selected bytes", async () => {
    const f = fixture();
    const session = await started(f);
    const first = await f.intake.putChunk(chunk(session.uploadHandle), context);
    await expect(
      f.intake.putChunk(chunk(session.uploadHandle, "other"), context),
    ).rejects.toThrow("UPLOAD_PART_CONFLICT");
    expect(
      await f.intake.putChunk(chunk(session.uploadHandle), context),
    ).toEqual(first);
  });
  it("does not select an interrupted source and releases its admission", async () => {
    const f = fixture();
    const session = await started(f);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 1));
        controller.error(new Error("INTERRUPTED_SOURCE"));
      },
    });
    await expect(
      f.intake.putChunk({ ...chunk(session.uploadHandle), body }, context),
    ).rejects.toThrow("INTERRUPTED_SOURCE");
    expect([...f.objects.keys()].some((key) => key.includes("/parts/"))).toBe(
      false,
    );
    expect(
      (await f.intake.putChunk(chunk(session.uploadHandle), context)).status,
    ).toBe("chunk_stored");
  });
  it.each(["/session", "/parts/000", "/selection", "/ready"])(
    "never acknowledges after current authority is revoked during %s persistence",
    async (stage) => {
      const f = fixture();
      if (stage === "/session") {
        f.afterWrite((key) => {
          if (key.endsWith(stage)) f.revoke();
        });
        await expect(started(f)).rejects.toThrow("CURRENT_GRANT_REVOKED");
        expect(f.objects.size).toBeGreaterThan(0);
        return;
      }
      const session = await started(f);
      if (stage !== "/parts/000")
        await f.intake.putChunk(chunk(session.uploadHandle), context);
      f.afterWrite((key) => {
        if (key.endsWith(stage)) f.revoke();
      });
      await expect(
        stage === "/parts/000"
          ? f.intake.putChunk(chunk(session.uploadHandle), context)
          : f.intake.complete(session.uploadHandle, context),
      ).rejects.toThrow("CURRENT_GRANT_REVOKED");
      expect([...f.objects.keys()].some((key) => key.endsWith(stage))).toBe(
        true,
      );
      f.afterWrite(() => undefined);
      f.restore();
      expect(
        (await f.intake.complete(session.uploadHandle, context)).complete,
      ).toBe(true);
    },
  );
  it.each([
    { ...context, workspace: { ...context.workspace, ownerId: "other" } },
    { ...context, workspace: { ...context.workspace, workspaceId: "other" } },
    { ...context, actor: { ...context.actor, id: "other" } },
    { ...context, grant: { ...context.grant, id: "other" } },
    { ...context, grant: { ...context.grant, revision: "2" } },
    { ...context, issuer: "other" },
    { ...context, audience: "other" },
  ])(
    "does not accept another owner/workspace/actor/grant/issuer/audience's handle",
    async (supplied) => {
      const f = fixture();
      const session = await started(f);
      const count = f.objects.size;
      await expect(
        f.intake.putChunk(chunk(session.uploadHandle), supplied),
      ).rejects.toThrow(/UPLOAD_NOT_FOUND|UPLOAD_AUTHORITY_MISMATCH/);
      expect(f.objects.size).toBe(count);
    },
  );
});

describe("admission owns upload body cancellation", () => {
  it("denies without reading the body and cancels it; another factory shares the same capacity", async () => {
    const f = fixture();
    const session = await started(f);
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = [
      f.budget.run("chunk", () => waiting),
      f.budget.run("chunk", () => waiting),
    ];
    let reads = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
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
    const other = createUploadIntake({
      archive: f.archive,
      authority: f.authority,
      budget: f.budget,
    });
    try {
      await expect(
        other.putChunk({ ...chunk(session.uploadHandle), body }, context),
      ).rejects.toThrow("INTAKE_CAPACITY_EXCEEDED");
      expect(reads).toBe(0);
      expect(cancelled).toBe(true);
    } finally {
      release();
      await Promise.all(active);
    }
    expect(
      (await other.putChunk(chunk(session.uploadHandle), context)).status,
    ).toBe("chunk_stored");
  });
  it("requires admission even when an authority is provided", () => {
    const f = fixture();
    expect(() =>
      createUploadIntake({ archive: f.archive, authority: f.authority }),
    ).toThrow("UPLOAD_ADMISSION_UNAVAILABLE");
  });
});
