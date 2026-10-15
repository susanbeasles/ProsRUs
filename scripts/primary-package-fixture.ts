import { CompactSign, generateKeyPair } from "jose";
import type {
  AcceptedPreparation,
  AuthenticatedRecoveryContext,
  PrimaryArchive,
  RecoveryPreparationAuthority,
  RecoverySigningCustody,
} from "../src/application/recovery-ports";
import { prepareRecoveryPackage } from "../src/application/recovery-preparation";
import {
  canonicalizeEnvelope,
  hashEnvelope,
} from "../src/domain/recovery-canonical";
import { demand, DomainError } from "../src/domain/model";
import type { SaveVersionInput, VersionManifest } from "../src/domain/recovery";
import { createRecoverySigner } from "../src/identity/recovery-signing";
import { createPrimaryArchive } from "../src/storage/primary-archive";
import { createRecoveryStore } from "../src/storage/recovery-store";
import { equalMetadata } from "../src/storage/recovery-metadata";
import {
  readPreparationArtifacts,
  unsignedPreparation,
} from "../src/storage/recovery-package-archive";

async function reject(run: () => Promise<unknown>, label: string) {
  try {
    await run();
  } catch {
    return;
  }
  throw new Error(`EXPECTED_REJECTION:${label}`);
}
export async function packageFixture(
  bucket: R2Bucket,
  db: D1Database,
  namespace: string,
) {
  const archive = createPrimaryArchive(bucket),
    owner = `owner-${namespace}`,
    workspace = { ownerId: owner, workspaceId: "workspace" };
  const store = createRecoveryStore(db, owner);
  const accepted = new Map<string, AcceptedPreparation>();
  const sourcePermissions = new Set<string>();
  let revoked = false;
  let now = 1000;
  async function chain() {
    try {
      return await store.getChain();
    } catch (error) {
      if (
        !(error instanceof DomainError) ||
        error.code !== "RECOVERY_WORKSPACE_UNINITIALIZED"
      )
        throw error;
      return {
        epochId: "synthetic-epoch",
        sequence: "0",
        previousTransactionDigest: null,
      };
    }
  }
  async function context(): Promise<AuthenticatedRecoveryContext> {
    return {
      workspace,
      actor: {
        id: "client:synthetic-save",
        kind: "service",
        scopes: ["write"],
        expiresAt: 100000,
      },
      issuer: "synthetic-host",
      audience: "job-stack",
      grant: {
        id: "grant",
        revision: "1",
        scopes: ["write"],
        resourceBounds: [{ kind: "workspace", id: "workspace" }],
        expiresAt: 100000,
      },
      chain: await chain(),
      serverTime: now,
    };
  }
  async function committed(
    ids: readonly string[],
    source: boolean,
  ): Promise<readonly VersionManifest[]> {
    const values = [];
    for (const id of ids) {
      demand(!source || sourcePermissions.has(id), "SOURCE_GRANT_DENIED");
      const value = await store.getVersion(id);
      demand(
        value,
        source ? "RECOVERY_SOURCE_CONFLICT" : "RECOVERY_PARENT_CONFLICT",
      );
      values.push(value);
    }
    return values;
  }
  const authority: RecoveryPreparationAuthority = {
    async accept(input, supplied) {
      demand(
        !revoked && equalMetadata(supplied, await context()),
        "SYNTHETIC_AUTHORITY_DENIED",
      );
      const value: AcceptedPreparation = {
        format: "bound-primary-v1",
        input,
        context: supplied,
        now,
        currentChain: await chain(),
        currentHeads: await store.getHeads(input.lineageId),
        transactionId: crypto.randomUUID(),
        versionId: crypto.randomUUID(),
        namespace,
        parents: await committed(input.expectedParentIds, false),
        sources: await committed(input.sourceVersionIds, true),
      };
      accepted.set(value.transactionId, value);
      return value;
    },
    async resolveAccepted(transactionId, supplied) {
      const value = accepted.get(transactionId);
      if (!value) return null;
      demand(
        !revoked && equalMetadata(value.context, supplied),
        "SYNTHETIC_AUTHORITY_DENIED",
      );
      return {
        ...value,
        now,
        currentChain: await chain(),
        currentHeads: await store.getHeads(value.input.lineageId),
        parents: await committed(value.input.expectedParentIds, false),
        sources: await committed(value.input.sourceVersionIds, true),
      };
    },
  };
  const keys = await generateKeyPair("ES256");
  const custody: RecoverySigningCustody = {
    verificationKey: {
      keyId: "synthetic-runtime-key",
      algorithm: "ES256",
      publicKey: keys.publicKey,
    },
    async signPreparation(binding) {
      return sign(binding);
    },
    async signCommit(binding) {
      return sign(binding);
    },
  };
  async function sign(binding: unknown) {
    return {
      keyId: "synthetic-runtime-key",
      algorithm: "ES256" as const,
      jws: await new CompactSign(canonicalizeEnvelope(binding))
        .setProtectedHeader({
          alg: "ES256",
          kid: "synthetic-runtime-key",
          typ: "job-stack-recovery+jws",
        })
        .sign(keys.privateKey),
    };
  }
  const commitTimes = new Map<string, number>();
  const signer = createRecoverySigner({
    archive,
    authority,
    custody,
    commitAuthority: {
      async resolveCommitted(transactionId, supplied) {
        demand(
          !revoked &&
            supplied.workspace.ownerId === owner &&
            supplied.actor.id === "client:synthetic-background" &&
            supplied.grant.id === "background-grant",
          "SYNTHETIC_BACKGROUND_DENIED",
        );
        const prepared = await store.getPrepared(transactionId);
        const committedAt = commitTimes.get(transactionId);
        return prepared && committedAt !== undefined
          ? { prepared, context: supplied, now, committedAt }
          : null;
      },
    },
  });
  const ports = { archive, authority, signer };
  const input: SaveVersionInput = {
    requestKey: "save",
    lineageId: "lineage",
    entityId: "record",
    kind: "resume",
    expectedParentIds: [],
    branchRequested: false,
    content: { text: "  exact original\r\n" },
    sourceVersionIds: [],
  };
  async function count() {
    return (
      (
        await db
          .prepare(
            "SELECT count(*) AS n FROM recovery_transactions WHERE owner=?",
          )
          .bind(owner)
          .first<{ n: number }>()
      )?.n ?? 0
    );
  }
  await reject(
    async () =>
      prepareRecoveryPackage(
        { ...input, expectedParentIds: ["archive-only"] },
        await context(),
        ports,
      ),
    "uncommitted_parent",
  );
  sourcePermissions.add("archive-only");
  await reject(
    async () =>
      prepareRecoveryPackage(
        { ...input, sourceVersionIds: ["archive-only"] },
        await context(),
        ports,
      ),
    "uncommitted_source",
  );
  demand((await count()) === 0, "D1_COMMITTED_ON_PREPARATION_FAILURE");
  const first = await prepareRecoveryPackage(input, await context(), ports);
  demand((await count()) === 0, "PREPARATION_IS_NOT_COMMIT");
  const evidence = await readPreparationArtifacts(archive, first);
  demand(
    evidence.package.object.versionId !== null &&
      evidence.wrapper.object.versionId !== null,
    "UNPINNED_PACKAGE_EVIDENCE",
  );
  const result = await store.commitPrepared(first);
  commitTimes.set(first.transactionId, 2000);
  demand(
    result.digest === first.result.digest && (await count()) === 1,
    "ATOMIC_COMMIT_MISSING",
  );
  now = 2000;
  const firstVersion = first.versions[0];
  demand(firstVersion, "FIRST_VERSION_MISSING");
  await reject(
    async () =>
      prepareRecoveryPackage(
        {
          ...input,
          requestKey: "denied-source",
          expectedParentIds: [firstVersion.versionId],
          sourceVersionIds: [firstVersion.versionId],
        },
        await context(),
        ports,
      ),
    "current_source_grant",
  );
  demand((await count()) === 1, "D1_COMMITTED_ON_SOURCE_DENIAL");
  sourcePermissions.add(firstVersion.versionId);
  const second = await prepareRecoveryPackage(
    {
      ...input,
      requestKey: "second",
      expectedParentIds: [firstVersion.versionId],
      sourceVersionIds: [firstVersion.versionId],
      content: { text: "next exact version" },
    },
    await context(),
    ports,
  );
  demand(
    second.sourceDescriptors[0]?.manifestDigest ===
      (await hashEnvelope("manifest", firstVersion)),
    "SOURCE_DIGEST_MISMATCH",
  );
  demand((await count()) === 1, "SECOND_PREPARATION_COMMITTED");
  const corrupt: PrimaryArchive = {
    ...archive,
    async putImmutable(value) {
      const stored = await archive.putImmutable(value);
      if (value.object.key.startsWith("packages/"))
        await bucket.put(
          `${stored.object.namespace}/${stored.object.key}`,
          new Uint8Array([0]),
        );
      return stored;
    },
  };
  await reject(
    async () =>
      prepareRecoveryPackage(
        {
          ...input,
          requestKey: "corrupt",
          expectedParentIds: [firstVersion.versionId],
        },
        await context(),
        { ...ports, archive: corrupt },
      ),
    "corrupt_package",
  );
  demand((await count()) === 1, "D1_COMMITTED_ON_CORRUPTION");
  now = 150000;
  const background: AuthenticatedRecoveryContext = {
    ...(await context()),
    actor: {
      id: "client:synthetic-background",
      kind: "service",
      scopes: ["recovery:commit"],
      expiresAt: 200000,
    },
    grant: {
      id: "background-grant",
      revision: "1",
      scopes: ["recovery:commit"],
      resourceBounds: [{ kind: "workspace", id: "workspace" }],
      expiresAt: 200000,
    },
  };
  const certificate = await signer.signCommit(first, background);
  demand(
    certificate.transactionDigest ===
      (await hashEnvelope("transaction", unsignedPreparation(first))),
    "COMMIT_DIGEST_MISMATCH",
  );
  revoked = true;
  await reject(
    () => signer.signCommit(first, background),
    "revoked_background",
  );
  return {
    checks: 14,
    committedTransactions: await count(),
    preparationNotCommit: true,
    sourceClosureFromD1: true,
    expiredClientCurrentBackground: true,
    zeroCommitOnFailure: true,
    package: evidence.package,
    wrapper: evidence.wrapper,
  };
}
