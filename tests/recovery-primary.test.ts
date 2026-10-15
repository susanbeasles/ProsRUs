import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createPrimaryArchive } from "../src/storage/primary-archive";
import {
  hashArtifact,
  hashEnvelope,
  canonicalizeEnvelope,
} from "../src/domain/recovery-canonical";
import { readBoundedBytes } from "../src/storage/recovery-streams";
import type { PrimaryArchive } from "../src/application/recovery-ports";

process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
let runtime: Miniflare;
let bucket: R2Bucket;
let archive: PrimaryArchive;
const ref = (key: string) => ({
  provider: "primary" as const,
  namespace: "unit-primary",
  key,
  versionId: null,
});
beforeAll(async () => {
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script:
        'export default {fetch(){return new Response("local synthetic fixture")}}',
      compatibilityDate: "2026-10-08",
      cf: false,
      r2Buckets: ["BUCKET"],
    }),
  );
  // Miniflare's Node proxy uses Undici Headers types. Validate its native binding
  // surface at this test-only bridge; the assertions exercise actual Workerd R2.
  const proxy: unknown = await runtime.getR2Bucket("BUCKET");
  function isBucket(value: unknown): value is R2Bucket {
    return (
      value !== null &&
      typeof value === "object" &&
      [
        "head",
        "get",
        "put",
        "list",
        "delete",
        "createMultipartUpload",
        "resumeMultipartUpload",
      ].every((name) => typeof Reflect.get(value, name) === "function")
    );
  }
  if (!isBucket(proxy)) throw new Error("INVALID_TEST_R2_PROXY");
  bucket = proxy;
  archive = createPrimaryArchive(bucket);
});
afterAll(async () => {
  await runtime?.dispose();
});

describe("immutable primary archive", () => {
  it("preserves full exact bytes and physical identity before acknowledging", async () => {
    const bytes = new Uint8Array([0, 255, 13, 10, 128]);
    const digest = await hashArtifact(bytes);
    const put = await archive.putImmutable({
      object: ref(`blobs/${digest}`),
      bytes,
      digest,
      hashPurpose: "blob",
    });
    expect(put.outcome).toBe("created");
    expect(put.object.versionId).not.toBeNull();
    const read = await archive.get(put.object);
    expect(read?.object).toEqual(put.object);
    expect(read?.bytes).toEqual(bytes);
    const streamed = await archive.getStream(put.object);
    expect(streamed?.sizeBytes).toBe(bytes.length);
    expect(
      streamed && (await readBoundedBytes(streamed.body, bytes.length)),
    ).toEqual(bytes);
  });
  it("one concurrent create wins and all matching retries keep that identity", async () => {
    const bytes = canonicalizeEnvelope({ exact: "first\r\n" });
    const digest = await hashEnvelope("manifest", { exact: "first\r\n" });
    const input = {
      object: ref(`manifests/${digest}`),
      bytes,
      digest,
      hashPurpose: "manifest" as const,
    };
    const results = await Promise.all([
      archive.putImmutable(input),
      archive.putImmutable(input),
    ]);
    expect(
      results.filter((result) => result.outcome === "created"),
    ).toHaveLength(1);
    expect(results[0]?.object).toEqual(results[1]?.object);
  });
  it("refuses different bytes at an existing immutable key without replacement", async () => {
    const bytes = new Uint8Array([1]);
    const object = ref("candidates/frozen");
    const initial = await archive.putImmutable({
      object,
      bytes,
      digest: await hashArtifact(bytes),
      hashPurpose: "blob",
    });
    const changed = new Uint8Array([2]);
    await expect(
      archive.putImmutable({
        object,
        bytes: changed,
        digest: await hashArtifact(changed),
        hashPurpose: "blob",
      }),
    ).rejects.toThrow("INTEGRITY_MISMATCH");
    expect((await archive.get(initial.object))?.bytes).toEqual(bytes);
  });
  it("rejects wrong declared digest before any object is written", async () => {
    const object = ref("candidates/incorrect-digest");
    await expect(
      archive.putImmutable({
        object,
        bytes: new Uint8Array([1]),
        digest: "0".repeat(64),
        hashPurpose: "blob",
      }),
    ).rejects.toThrow("INTEGRITY_MISMATCH");
    expect(await archive.get(object)).toBeNull();
  });
  it("rejects a stale pinned version even when bytes still match", async () => {
    const bytes = new Uint8Array([7]);
    const object = ref("candidates/replaced");
    const result = await archive.putImmutable({
      object,
      bytes,
      digest: await hashArtifact(bytes),
      hashPurpose: "blob",
    });
    await bucket.put(`${object.namespace}/${object.key}`, bytes);
    await expect(archive.get(result.object)).rejects.toThrow(
      "ARCHIVE_IDENTITY_MISMATCH",
    );
  });
  it("bounds byte APIs independently from stream APIs", async () => {
    const object = ref("candidates/too-large");
    await expect(
      archive.putImmutable({
        object,
        bytes: new Uint8Array(8 * 1024 * 1024 + 1),
        digest: "0".repeat(64),
        hashPurpose: "blob",
      }),
    ).rejects.toThrow("BYTE_API_LIMIT_EXCEEDED");
    await bucket.put(
      `${object.namespace}/${object.key}`,
      new Uint8Array(8 * 1024 * 1024 + 1),
    );
    await expect(archive.get(object)).rejects.toThrow(
      "BYTE_API_LIMIT_EXCEEDED",
    );
  });
  it("never treats noncanonical metadata as exact canonical evidence", async () => {
    const value = { a: 1 };
    await expect(
      archive.putImmutable({
        object: ref("candidates/noncanonical"),
        bytes: new TextEncoder().encode('{ "a": 1 }'),
        digest: await hashEnvelope("manifest", value),
        hashPurpose: "manifest",
      }),
    ).rejects.toThrow("NONCANONICAL_ARCHIVE_METADATA");
  });
  it("lists only one validated namespace with actual physical identities", async () => {
    const page = await archive.list({
      namespace: "unit-primary",
      prefix: "manifests/",
      cursor: null,
    });
    expect(page.items.length).toBeGreaterThan(0);
    expect(
      page.items.every(
        (item) =>
          item.namespace === "unit-primary" &&
          item.versionId !== null &&
          item.key.startsWith("manifests/"),
      ),
    ).toBe(true);
  });
});

import { prepareRecoveryPackage } from "../src/application/recovery-preparation";
import { createRecoverySigner } from "../src/identity/recovery-signing";
import {
  primaryContext,
  primaryInput,
  preparationFixture,
} from "./fixtures/primary-preparation";
import {
  parseEnvelopeJson,
  verifyRecoverySignature,
} from "../src/domain/recovery-canonical";
import {
  preparedEnvelopeSchema,
  commitCertificateSchema,
  type PreparedEnvelope,
} from "../src/domain/recovery";

function unsigned(prepared: PreparedEnvelope) {
  const { signature, ...payload } = prepared;
  void signature;
  return payload;
}

describe("complete bound primary preparations", () => {
  it("preserves full manifests, transaction, exact original and bound package before success", async () => {
    const f = await preparationFixture();
    const prepared = await prepareRecoveryPackage(
      primaryInput,
      primaryContext,
      f,
    );
    expect(preparedEnvelopeSchema.safeParse(prepared).success).toBe(true);
    expect(prepared.packageObject.versionId).toBeNull();
    expect(prepared.packageBinding?.formatVersion).toBe(1);
    const binding = prepared.packageBinding;
    expect(binding).toBeDefined();
    if (!binding) throw new Error("binding absent");
    const stored = await f.archive.get(binding.descriptor.object);
    expect(stored).not.toBeNull();
    const value =
      stored && parseEnvelopeJson(new TextDecoder().decode(stored.bytes));
    expect(value).toMatchObject({
      formatVersion: 1,
      type: "recovery_package",
      commitStatus: "unknown",
      proposed: { versions: prepared.versions },
    });
    expect(await hashEnvelope("inventory", value)).toBe(
      binding.descriptor.digest,
    );
    expect(prepared.result.digest).toBe(
      await hashEnvelope("manifest", prepared.versions[0]),
    );
    expect(prepared.versions[0]?.recordSnapshot).toEqual(primaryInput.content);
    expect(
      [...f.objects.keys()].some((key) => key.includes("/preparations/")),
    ).toBe(true);
    expect(commitCertificateSchema.safeParse(prepared).success).toBe(false);
    await verifyRecoverySignature(
      prepared.signature,
      "preparation",
      unsigned(prepared),
      f.custody.verificationKey,
    );
    await expect(
      verifyRecoverySignature(
        prepared.signature,
        "commit",
        unsigned(prepared),
        f.custody.verificationKey,
      ),
    ).rejects.toThrow("SIGNATURE_PURPOSE_MISMATCH");
    expect(JSON.stringify(prepared)).not.toMatch(
      /privateKey|BEGIN PRIVATE|access_token|refresh_token/,
    );
  });
  it("request identity survives server IDs/time/chain reprepare and binds owner/workspace/content", async () => {
    const f = await preparationFixture();
    const first = await prepareRecoveryPackage(primaryInput, primaryContext, f);
    const second = await prepareRecoveryPackage(
      primaryInput,
      primaryContext,
      f,
    );
    expect(first.transactionId).not.toBe(second.transactionId);
    expect(first.requestDigest).toBe(second.requestDigest);
    const changed = await prepareRecoveryPackage(
      { ...primaryInput, content: { text: "changed" } },
      primaryContext,
      f,
    );
    expect(changed.requestDigest).not.toBe(first.requestDigest);
  });
  it("rejects corrupt readback through the requested preparation boundary", async () => {
    const f = await preparationFixture();
    const corruptPorts = {
      ...f,
      archive: {
        ...f.archive,
        async putImmutable(
          input: Parameters<typeof f.archive.putImmutable>[0],
        ) {
          const result = await f.archive.putImmutable(input);
          if (input.object.key.startsWith("packages/"))
            f.corrupt(result.object);
          return result;
        },
      },
    };
    await expect(
      prepareRecoveryPackage(primaryInput, primaryContext, corruptPorts),
    ).rejects.toThrow("INTEGRITY_MISMATCH");
  });
  it("rejects untrusted actor/time and independently rejects unaccepted or edited signing payloads", async () => {
    const f = await preparationFixture();
    await expect(
      prepareRecoveryPackage(
        primaryInput,
        { ...primaryContext, serverTime: 1 },
        f,
      ),
    ).rejects.toThrow("RECOVERY_AUTHORITY_DENIED");
    await expect(
      prepareRecoveryPackage(
        primaryInput,
        {
          ...primaryContext,
          actor: { ...primaryContext.actor, id: "attacker" },
        },
        f,
      ),
    ).rejects.toThrow("RECOVERY_AUTHORITY_DENIED");
    const prepared = await prepareRecoveryPackage(
      primaryInput,
      primaryContext,
      f,
    );
    await expect(
      f.signer.signPreparation(
        { ...unsigned(prepared), transactionId: "caller-issued" },
        primaryContext,
      ),
    ).rejects.toThrow();
    await expect(
      f.signer.signPreparation(
        { ...unsigned(prepared), createdAt: 999 },
        primaryContext,
      ),
    ).rejects.toThrow();
    await expect(
      f.signer.signPreparation(
        { ...unsigned(prepared), requestKey: "arbitrary-bytes" },
        primaryContext,
      ),
    ).rejects.toThrow("PREPARATION_CONTENT_MISMATCH");
    f.revoke();
    await expect(
      f.signer.signPreparation(unsigned(prepared), primaryContext),
    ).rejects.toThrow("RECOVERY_AUTHORITY_DENIED");
  });
  it("rejects nonempty parent/source references without trusted committed closure", async () => {
    const f = await preparationFixture();
    await expect(
      prepareRecoveryPackage(
        { ...primaryInput, expectedParentIds: ["uncommitted"] },
        primaryContext,
        f,
      ),
    ).rejects.toThrow("RECOVERY_PARENT_CONFLICT");
    await expect(
      prepareRecoveryPackage(
        { ...primaryInput, sourceVersionIds: ["uncommitted"] },
        primaryContext,
        f,
      ),
    ).rejects.toThrow("RECOVERY_SOURCE_CONFLICT");
  });
  it("preserves full trusted parent/source manifests and their exact digests", async () => {
    const f = await preparationFixture();
    const prior = await prepareRecoveryPackage(primaryInput, primaryContext, f);
    const parent = prior.versions[0];
    if (!parent) throw new Error("missing fixture");
    f.setClosure([parent], [parent], [parent.versionId]);
    const prepared = await prepareRecoveryPackage(
      {
        ...primaryInput,
        expectedParentIds: [parent.versionId],
        sourceVersionIds: [parent.versionId],
      },
      primaryContext,
      f,
    );
    expect(prepared.sourceDescriptors[0]?.manifestDigest).toBe(
      await hashEnvelope("manifest", parent),
    );
    const binding = prepared.packageBinding;
    if (!binding) throw new Error("missing binding");
    const stored = await f.archive.get(binding.descriptor.object);
    const value =
      stored && parseEnvelopeJson(new TextDecoder().decode(stored.bytes));
    expect(value).toMatchObject({ parents: [parent], sources: [parent] });
  });
  it("rejects incomplete/wrong-owner handles and preserves completed exact file metadata", async () => {
    const f = await preparationFixture();
    const original = {
      sizeBytes: 5,
      fileName: "Voice memo.M4A",
      format: "M4A",
      mediaType: "audio/mp4",
      lastModified: 999,
    };
    const start = await f.uploads.begin(
      { requestKey: "begin", original },
      primaryContext,
    );
    const { content, ...input } = primaryInput;
    void content;
    await expect(
      prepareRecoveryPackage(
        { ...input, kind: "recording", uploadHandle: start.uploadHandle },
        primaryContext,
        f,
      ),
    ).rejects.toThrow("UPLOAD_INCOMPLETE");
    await f.uploads.putChunk(
      {
        uploadHandle: start.uploadHandle,
        ordinal: 0,
        requestKey: "part",
        body: new Blob([new Uint8Array([0, 255, 13, 10, 1])]).stream(),
      },
      primaryContext,
    );
    await f.uploads.complete(start.uploadHandle, primaryContext);
    const prepared = await prepareRecoveryPackage(
      { ...input, kind: "recording", uploadHandle: start.uploadHandle },
      primaryContext,
      f,
    );
    expect(prepared.versions[0]?.recordSnapshot).toMatchObject({ original });
    expect(prepared.versions[0]?.artifacts[0]?.digest).toBe(
      await hashArtifact(new Uint8Array([0, 255, 13, 10, 1])),
    );
  });
  it("rejects direct content exceeding the complete 128 KiB envelope budget", async () => {
    const f = await preparationFixture();
    await expect(
      prepareRecoveryPackage(
        { ...primaryInput, content: new Uint8Array(128 * 1024 + 1) },
        primaryContext,
        f,
      ),
    ).rejects.toThrow("ENVELOPE_TOO_LARGE");
    await expect(
      prepareRecoveryPackage(
        { ...primaryInput, content: { text: "x".repeat(128 * 1024) } },
        primaryContext,
        f,
      ),
    ).rejects.toThrow();
  });
  it("never supplies a test signer when production authority is unavailable", async () => {
    const f = await preparationFixture();
    const prepared = await prepareRecoveryPackage(
      primaryInput,
      primaryContext,
      f,
    );
    const signer = createRecoverySigner();
    await expect(
      signer.signPreparation(unsigned(prepared), primaryContext),
    ).rejects.toThrow("RECOVERY_SIGNING_AUTHORITY_UNAVAILABLE");
  });
  it("issues commit evidence only from an exact durable commit under current background authority", async () => {
    const f = await preparationFixture();
    const prepared = await prepareRecoveryPackage(
      primaryInput,
      primaryContext,
      f,
    );
    await expect(f.signer.signCommit(prepared, primaryContext)).rejects.toThrow(
      "RECOVERY_COMMIT_NOT_FOUND",
    );
    f.commit(prepared);
    f.setNow(150000);
    const background = {
      ...primaryContext,
      actor: {
        id: "client:recovery-worker",
        kind: "service" as const,
        scopes: ["recovery:commit"],
        expiresAt: 200000,
      },
      grant: { ...primaryContext.grant, id: "worker-grant", expiresAt: 200000 },
      chain: {
        ...primaryContext.chain,
        sequence: "1",
        previousTransactionDigest: await hashEnvelope(
          "transaction",
          unsigned(prepared),
        ),
      },
      serverTime: 150000,
    };
    const certificate = await f.signer.signCommit(prepared, background);
    expect(commitCertificateSchema.safeParse(certificate).success).toBe(true);
    expect(certificate.transactionDigest).toBe(
      await hashEnvelope("transaction", unsigned(prepared)),
    );
    expect(prepared.actorId).toBe(primaryContext.actor.id);
  });
});

it("keeps request identity stable across trusted time/chain changes and scopes it to owner/workspace", async () => {
  const f = await preparationFixture();
  const first = await prepareRecoveryPackage(primaryInput, primaryContext, f);
  const advanced = {
    ...primaryContext,
    serverTime: 2000,
    chain: {
      epochId: "epoch",
      sequence: "3",
      previousTransactionDigest: "1".repeat(64),
    },
  };
  f.setContext(advanced);
  f.setNow(2000);
  const second = await prepareRecoveryPackage(primaryInput, advanced, f);
  expect(second.requestDigest).toBe(first.requestDigest);
  expect(second.createdAt).not.toBe(first.createdAt);
  expect(second.sequence).toBe("4");
  const other = {
    ...advanced,
    workspace: { ownerId: "other-owner", workspaceId: "other-workspace" },
  };
  f.setContext(other);
  const third = await prepareRecoveryPackage(primaryInput, other, f);
  expect(third.requestDigest).not.toBe(first.requestDigest);
});

it("checks current commit authority again after custody returns", async () => {
  const f = await preparationFixture();
  const prepared = await prepareRecoveryPackage(
    primaryInput,
    primaryContext,
    f,
  );
  f.commit(prepared);
  f.setNow(2000);
  const signer = createRecoverySigner({
    ...f,
    custody: {
      ...f.custody,
      async signCommit(binding) {
        const result = await f.custody.signCommit(binding);
        f.revoke();
        return result;
      },
    },
  });
  await expect(signer.signCommit(prepared, primaryContext)).rejects.toThrow(
    "RECOVERY_AUTHORITY_DENIED",
  );
});

it("checks current preparation authority again after custody returns", async () => {
  const f = await preparationFixture();
  const signer = createRecoverySigner({
    ...f,
    custody: {
      ...f.custody,
      async signPreparation(binding) {
        const result = await f.custody.signPreparation(binding);
        f.revoke();
        return result;
      },
    },
  });
  await expect(
    prepareRecoveryPackage(primaryInput, primaryContext, { ...f, signer }),
  ).rejects.toThrow("RECOVERY_AUTHORITY_DENIED");
  expect(
    [...f.objects.keys()].filter((key) => key.includes("/preparations/")),
  ).toHaveLength(0);
});
