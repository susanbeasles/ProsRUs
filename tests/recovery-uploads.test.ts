import { describe, expect, it } from "vitest";
import {
  createRecoveryIntakeBudget,
  createUploadIntake,
} from "../src/application/recovery-uploads";
import { memoryArchive } from "./fixtures/primary-memory";
import { hashArtifact } from "../src/domain/recovery-canonical";
import type { AuthenticatedRecoveryContext } from "../src/application/recovery-ports";
import { DomainError } from "../src/domain/model";
const context: AuthenticatedRecoveryContext = {
  workspace: { ownerId: "owner", workspaceId: "workspace" },
  actor: {
    id: "access-owner:owner@example.com",
    kind: "user",
    scopes: ["write"],
    expiresAt: 100000,
  },
  issuer: "trusted-host",
  audience: "job-stack",
  grant: {
    id: "grant",
    revision: "1",
    scopes: ["write"],
    resourceBounds: [{ kind: "workspace", id: "workspace" }],
    expiresAt: 100000,
  },
  chain: { epochId: "epoch", sequence: "0", previousTransactionDigest: null },
  serverTime: 1000,
};
const original = {
  sizeBytes: 5,
  fileName: "  Café voice memo.m4a",
  mediaType: "audio/mp4",
  format: "M4A",
  lastModified: 999,
};
function fixture() {
  const memory = memoryArchive();
  let now = 1000;
  let revoked = false;
  const authority = {
    async authorize(supplied: AuthenticatedRecoveryContext) {
      if (
        revoked ||
        supplied.issuer !== context.issuer ||
        supplied.audience !== context.audience ||
        supplied.actor.id !== context.actor.id ||
        supplied.workspace.ownerId !== context.workspace.ownerId ||
        supplied.workspace.workspaceId !== context.workspace.workspaceId
      )
        throw new DomainError("RECOVERY_AUTHORITY_DENIED");
      return {
        context: supplied,
        now,
        namespace: "recovery",
        // Fresh host lease may outlive the immutable session's original deadline.
        expiresAt: now + 49000,
      };
    },
  };
  const intake = createUploadIntake({
    archive: memory.archive,
    authority,
    budget: createRecoveryIntakeBudget(),
  });
  return {
    ...memory,
    intake,
    revoke() {
      revoked = true;
    },
    setNow(value: number) {
      now = value;
    },
  };
}
const body = (bytes = new Uint8Array([0, 255, 13, 10, 37])) =>
  new Blob([new Uint8Array(bytes)]).stream();

describe("exact-original staged upload", () => {
  it("persists a server-issued session and exact original metadata before returning a handle", async () => {
    const f = fixture();
    const session = await f.intake.begin(
      { requestKey: "start", original },
      context,
    );
    expect(session.uploadHandle).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(session.original).toEqual(original);
    expect(session.status).toBe("upload_started");
    expect([...f.objects.keys()].some((key) => key.endsWith("/session"))).toBe(
      true,
    );
    expect(
      await f.intake.begin({ requestKey: "start", original }, context),
    ).toEqual(session);
    await expect(
      f.intake.begin(
        { requestKey: "start", original: { ...original, fileName: "changed" } },
        context,
      ),
    ).rejects.toThrow("UPLOAD_REQUEST_CONFLICT");
  });
  it("keeps immutable ordinal receipts and a reconstructible verified original", async () => {
    const f = fixture();
    const session = await f.intake.begin(
      { requestKey: "start", original },
      context,
    );
    const chunk = () =>
      f.intake.putChunk(
        {
          uploadHandle: session.uploadHandle,
          ordinal: 0,
          requestKey: "part",
          body: body(),
        },
        context,
      );
    const first = await chunk();
    expect(first.status).toBe("chunk_stored");
    expect(await chunk()).toEqual(first);
    const ready = await f.intake.complete(session.uploadHandle, context);
    expect(ready.complete).toBe(true);
    expect(ready.original).toEqual(original);
    expect(ready.artifact.digest).toBe(
      await hashArtifact(new Uint8Array([0, 255, 13, 10, 37])),
    );
    expect((await f.archive.get(ready.artifact.object))?.bytes).toEqual(
      new Uint8Array([0, 255, 13, 10, 37]),
    );
    expect(await f.intake.resolve(session.uploadHandle, context)).toEqual(
      ready,
    );
    expect(await f.intake.complete(session.uploadHandle, context)).toEqual(
      ready,
    );
    expect(JSON.stringify(ready)).not.toContain("saved_primary");
  });
  it("rejects incomplete uploads and changed or mis-sized chunks without selecting them", async () => {
    const f = fixture();
    const session = await f.intake.begin(
      { requestKey: "start", original },
      context,
    );
    await expect(
      f.intake.complete(session.uploadHandle, context),
    ).rejects.toThrow("UPLOAD_INCOMPLETE");
    for (const size of [4, 6])
      await expect(
        f.intake.putChunk(
          {
            uploadHandle: session.uploadHandle,
            ordinal: 0,
            requestKey: "part",
            body: body(new Uint8Array(size)),
          },
          context,
        ),
      ).rejects.toThrow();
    await expect(
      f.intake.putChunk(
        {
          uploadHandle: session.uploadHandle,
          ordinal: 1,
          requestKey: "part",
          body: body(),
        },
        context,
      ),
    ).rejects.toThrow("INVALID_CHUNK_ORDINAL");
    await f.intake.putChunk(
      {
        uploadHandle: session.uploadHandle,
        ordinal: 0,
        requestKey: "part",
        body: body(),
      },
      context,
    );
    await expect(
      f.intake.putChunk(
        {
          uploadHandle: session.uploadHandle,
          ordinal: 0,
          requestKey: "part",
          body: body(new Uint8Array(5)),
        },
        context,
      ),
    ).rejects.toThrow("UPLOAD_PART_CONFLICT");
    const ready = await f.intake.complete(session.uploadHandle, context);
    expect(ready.artifact.digest).toBe(
      await hashArtifact(new Uint8Array([0, 255, 13, 10, 37])),
    );
  });
  it.each([0, -1, 1.5, 1073741825, Number.MAX_SAFE_INTEGER])(
    "rejects unsupported original size %s without storing a session",
    async (sizeBytes) => {
      const f = fixture();
      await expect(
        f.intake.begin(
          { requestKey: "start", original: { ...original, sizeBytes } },
          context,
        ),
      ).rejects.toThrow("INVALID_ORIGINAL_METADATA");
      expect(f.objects.size).toBe(0);
    },
  );
  it.each([1, 1073741823, 1073741824])(
    "accepts declared boundary %s without pretending bytes arrived",
    async (sizeBytes) => {
      const f = fixture();
      const session = await f.intake.begin(
        { requestKey: "start", original: { ...original, sizeBytes } },
        context,
      );
      expect(session.original.sizeBytes).toBe(sizeBytes);
      await expect(
        f.intake.resolve(session.uploadHandle, context),
      ).rejects.toThrow("UPLOAD_INCOMPLETE");
    },
  );
  it("checks owner, workspace, current grant and expiry before every continuation", async () => {
    const f = fixture();
    const session = await f.intake.begin(
      { requestKey: "start", original },
      context,
    );
    await expect(
      f.intake.putChunk(
        {
          uploadHandle: session.uploadHandle,
          ordinal: 0,
          requestKey: "part",
          body: body(),
        },
        { ...context, workspace: { ...context.workspace, ownerId: "other" } },
      ),
    ).rejects.toThrow("RECOVERY_AUTHORITY_DENIED");
    f.setNow(50000);
    await expect(
      f.intake.complete(session.uploadHandle, context),
    ).rejects.toThrow("UPLOAD_EXPIRED");
    f.setNow(1000);
    f.revoke();
    await expect(
      f.intake.resolve(session.uploadHandle, context),
    ).rejects.toThrow("RECOVERY_AUTHORITY_DENIED");
  });
  it("a lost receipt response is safely reconciled without replacement", async () => {
    const f = fixture();
    const session = await f.intake.begin(
      { requestKey: "start", original },
      context,
    );
    f.failNextAfter("/parts/000");
    const input = () => ({
      uploadHandle: session.uploadHandle,
      ordinal: 0,
      requestKey: "part",
      body: body(),
    });
    await expect(f.intake.putChunk(input(), context)).rejects.toThrow(
      "SYNTHETIC_LOST_RESPONSE",
    );
    const retained = [...f.objects.values()].find((value) =>
      value.object.key.endsWith("/parts/000"),
    );
    const retry = await f.intake.putChunk(input(), context);
    expect(retry.receiptObject.object).toEqual(retained?.object);
    expect(
      (await f.intake.complete(session.uploadHandle, context)).complete,
    ).toBe(true);
  });
  it("corrupt final bytes cannot resolve a completed handle", async () => {
    const f = fixture();
    const session = await f.intake.begin(
      { requestKey: "start", original },
      context,
    );
    await f.intake.putChunk(
      {
        uploadHandle: session.uploadHandle,
        ordinal: 0,
        requestKey: "part",
        body: body(),
      },
      context,
    );
    const ready = await f.intake.complete(session.uploadHandle, context);
    f.corrupt(ready.artifact.object);
    await expect(
      f.intake.resolve(session.uploadHandle, context),
    ).rejects.toThrow("INTEGRITY_MISMATCH");
  });
});

describe("shared intake admission", () => {
  it("bounds simultaneous chunk allocations and releases capacity after failures", async () => {
    const budget = createRecoveryIntakeBudget();
    let release: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = budget.run("chunk", async () => wait);
    const second = budget.run("chunk", async () => wait);
    await expect(budget.run("chunk", async () => undefined)).rejects.toThrow(
      "INTAKE_CAPACITY_EXCEEDED",
    );
    release();
    await Promise.all([first, second]);
    await expect(
      budget.run("chunk", async () => {
        throw new Error("cancelled");
      }),
    ).rejects.toThrow("cancelled");
    expect(await budget.run("chunk", async () => 42)).toBe(42);
  });
  it("requires authority and shared admission explicitly", () => {
    const f = memoryArchive();
    expect(() => createUploadIntake({ archive: f.archive })).toThrow(
      "UPLOAD_AUTHORITY_UNAVAILABLE",
    );
  });
});

it("preserves declared original MIME separately from stable byte-object metadata", async () => {
  const f = fixture();
  const session = await f.intake.begin(
    { requestKey: "mime", original },
    context,
  );
  await f.intake.putChunk(
    {
      uploadHandle: session.uploadHandle,
      ordinal: 0,
      requestKey: "part",
      body: body(),
    },
    context,
  );
  const ready = await f.intake.complete(session.uploadHandle, context);
  expect(ready.original.mediaType).toBe("audio/mp4");
  expect(ready.artifact.mediaType).toBe("application/octet-stream");
});
