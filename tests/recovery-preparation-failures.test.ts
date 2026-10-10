import { expect, it } from "vitest";
import { prepareRecoveryPackage } from "../src/application/recovery-preparation";
import { createRecoverySigner } from "../src/identity/recovery-signing";
import {
  primaryContext as context,
  primaryInput as input,
  preparationFixture,
} from "./fixtures/primary-preparation";
import { unsignedPreparation } from "../src/storage/recovery-package-archive";
import { hashArtifact } from "../src/domain/recovery-canonical";

it("does not sign a host-accepted request whose content differs from the caller's exact snapshot", async () => {
  const f = await preparationFixture();
  const authority = {
    ...f.authority,
    async accept() {
      return f.authority.accept(
        { ...input, content: { changed: true } },
        context,
      );
    },
  };
  await expect(
    prepareRecoveryPackage(input, context, { ...f, authority }),
  ).rejects.toThrow("PREPARATION_CONTENT_MISMATCH");
  expect(f.objects.size).toBe(0);
});

it("snapshots exact direct bytes before the caller can mutate them during authority resolution", async () => {
  const f = await preparationFixture();
  const content = new Uint8Array([0, 255, 17]);
  const expected = content.slice();
  const authority = {
    ...f.authority,
    async accept(
      request: Parameters<typeof f.authority.accept>[0],
      supplied: typeof context,
    ) {
      content.fill(1);
      return f.authority.accept(request, supplied);
    },
  };
  const prepared = await prepareRecoveryPackage(
    { ...input, content },
    context,
    { ...f, authority },
  );
  expect(prepared.versions[0]?.artifacts[0]?.digest).toBe(
    await hashArtifact(expected),
  );
});

it.each(["/packages/", "/preparations/"])(
  "retains and safely reuses matching accepted evidence after a lost %s response",
  async (stage) => {
    const f = await preparationFixture();
    const accepted = await f.authority.accept(input, context);
    const authority = {
      ...f.authority,
      async accept() {
        return accepted;
      },
    };
    // Metadata keys have no leading slash at the archive seam.
    f.failNextAfter(stage.slice(1));
    const run = () =>
      prepareRecoveryPackage(input, context, { ...f, authority });
    if (stage === "/packages/")
      await expect(run()).rejects.toThrow("SYNTHETIC_LOST_RESPONSE");
    const prepared = await run();
    const count = f.objects.size;
    expect(await run()).toEqual(prepared);
    expect(f.objects.size).toBe(count);
    expect(prepared.transactionId).toBe(accepted.transactionId);
    expect(
      [...f.objects.keys()].some((key) => key.includes("/preparations/")),
    ).toBe(true);
  },
);

it("refuses corrupted signed-wrapper readback without returning a preparation", async () => {
  const f = await preparationFixture();
  const archive = {
    ...f.archive,
    async putImmutable(value: Parameters<typeof f.archive.putImmutable>[0]) {
      const stored = await f.archive.putImmutable(value);
      if (value.object.key.startsWith("preparations/"))
        f.corrupt(stored.object);
      return stored;
    },
  };
  await expect(
    prepareRecoveryPackage(input, context, { ...f, archive }),
  ).rejects.toThrow(/INTEGRITY_MISMATCH|INVALID_JSON/);
  expect([...f.objects.keys()].some((key) => key.includes("/packages/"))).toBe(
    true,
  );
});

it.each(["expired", "changed-grant", "changed-chain"])(
  "independently denies preparation signing after %s authority changes",
  async (change) => {
    const f = await preparationFixture();
    const prepared = await prepareRecoveryPackage(input, context, f);
    let supplied = context;
    if (change === "expired") f.setNow(context.grant.expiresAt);
    if (change === "changed-grant")
      supplied = { ...context, grant: { ...context.grant, revision: "2" } };
    if (change === "changed-chain")
      supplied = { ...context, chain: { ...context.chain, epochId: "other" } };
    await expect(
      f.signer.signPreparation(unsignedPreparation(prepared), supplied),
    ).rejects.toThrow(/EXPIRED_RECOVERY_AUTHORITY|RECOVERY_AUTHORITY_MISMATCH/);
  },
);

it("denies commit certificates when durable evidence differs or has an impossible time", async () => {
  const f = await preparationFixture();
  const prepared = await prepareRecoveryPackage(input, context, f);
  f.setNow(2000);
  for (const durable of [
    {
      prepared: { ...prepared, requestKey: "changed" },
      context,
      now: 2000,
      committedAt: 2000,
    },
    { prepared, context, now: 2000, committedAt: 999 },
    { prepared, context, now: 2000, committedAt: 2001 },
    {
      prepared,
      context: {
        ...context,
        workspace: { ...context.workspace, ownerId: "other" },
      },
      now: 2000,
      committedAt: 2000,
    },
  ]) {
    const signer = createRecoverySigner({
      ...f,
      commitAuthority: {
        async resolveCommitted() {
          return durable;
        },
      },
    });
    await expect(signer.signCommit(prepared, context)).rejects.toThrow(
      /RECOVERY_COMMIT_MISMATCH|RECOVERY_COMMIT_TIME_MISMATCH|RECOVERY_AUTHORITY_MISMATCH/,
    );
  }
});

it("exposes only public signer capability identifiers and never private custody", async () => {
  const f = await preparationFixture();
  expect(Object.keys(f.signer).sort()).toEqual([
    "capabilities",
    "signCommit",
    "signPreparation",
    "verifyPreparation",
  ]);
  expect(JSON.stringify(f.signer)).not.toMatch(
    /privateKey|private_key|access_token|refresh_token|credential|secret/i,
  );
  const absent = createRecoverySigner();
  const prepared = await prepareRecoveryPackage(input, context, f);
  await expect(absent.signCommit(prepared, context)).rejects.toThrow(
    "RECOVERY_SIGNING_AUTHORITY_UNAVAILABLE",
  );
});
