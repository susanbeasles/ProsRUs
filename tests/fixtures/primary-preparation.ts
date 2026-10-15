import { CompactSign, generateKeyPair } from "jose";
import { DomainError } from "../../src/domain/model";
import { canonicalizeEnvelope } from "../../src/domain/recovery-canonical";
import type {
  AuthenticatedRecoveryContext,
  PreparedEnvelope,
  RecoverySignatureBinding,
  SaveVersionInput,
  VersionManifest,
} from "../../src/domain/recovery";
import { memoryArchive } from "./primary-memory";
import { createRecoverySigner } from "../../src/identity/recovery-signing";
import {
  createRecoveryIntakeBudget,
  createUploadIntake,
} from "../../src/application/recovery-uploads";

export const primaryContext: AuthenticatedRecoveryContext = {
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
export const primaryInput: SaveVersionInput = {
  requestKey: "request",
  lineageId: "lineage",
  entityId: "resume",
  kind: "resume",
  expectedParentIds: [],
  branchRequested: false,
  content: { text: "  Résumé\r\n" },
  sourceVersionIds: [],
};
export async function preparationFixture() {
  const memory = memoryArchive();
  const keys = await generateKeyPair("ES256");
  let trustedContext = primaryContext;
  let serial = 0;
  let revoked = false;
  let now = 1000;
  let parents: VersionManifest[] = [];
  let sources: VersionManifest[] = [];
  let heads: string[] = [];
  type Accepted = {
    format: "bound-primary-v1";
    input: SaveVersionInput;
    context: AuthenticatedRecoveryContext;
    now: number;
    currentChain: AuthenticatedRecoveryContext["chain"];
    transactionId: string;
    versionId: string;
    namespace: string;
    parents: readonly VersionManifest[];
    sources: readonly VersionManifest[];
    currentHeads: readonly string[];
  };
  const accepted = new Map<string, Accepted>();
  const check = (context: AuthenticatedRecoveryContext) => {
    if (
      revoked ||
      context.issuer !== trustedContext.issuer ||
      context.audience !== trustedContext.audience ||
      context.actor.id !== trustedContext.actor.id ||
      context.workspace.ownerId !== trustedContext.workspace.ownerId ||
      context.workspace.workspaceId !== trustedContext.workspace.workspaceId ||
      context.serverTime !== trustedContext.serverTime
    )
      throw new DomainError("RECOVERY_AUTHORITY_DENIED");
  };
  const authority = {
    async accept(
      input: SaveVersionInput,
      context: AuthenticatedRecoveryContext,
    ) {
      check(context);
      const resolution: Accepted = {
        format: "bound-primary-v1",
        input,
        context,
        now,
        currentChain: context.chain,
        transactionId: `transaction-${++serial}`,
        versionId: `version-${serial}`,
        namespace: "recovery",
        parents,
        sources,
        currentHeads: heads,
      };
      accepted.set(resolution.transactionId, resolution);
      return resolution;
    },
    async resolveAccepted(
      transactionId: string,
      context: AuthenticatedRecoveryContext,
    ) {
      check(context);
      const resolution = accepted.get(transactionId);
      if (!resolution) return null;
      return { ...resolution, now, parents, sources, currentHeads: heads };
    },
  };
  async function sign(binding: RecoverySignatureBinding) {
    const jws = await new CompactSign(canonicalizeEnvelope(binding))
      .setProtectedHeader({
        alg: "ES256",
        kid: "synthetic-primary",
        typ: "job-stack-recovery+jws",
      })
      .sign(keys.privateKey);
    return { keyId: "synthetic-primary", algorithm: "ES256" as const, jws };
  }
  const custody = {
    verificationKey: {
      keyId: "synthetic-primary",
      algorithm: "ES256" as const,
      publicKey: keys.publicKey,
    },
    signPreparation: sign,
    signCommit: sign,
  };
  let committed: PreparedEnvelope | null = null;
  const commitAuthority = {
    async resolveCommitted(
      _transactionId: string,
      context: AuthenticatedRecoveryContext,
    ) {
      if (revoked) throw new DomainError("RECOVERY_AUTHORITY_DENIED");
      return committed
        ? { prepared: committed, context, now, committedAt: 2000 }
        : null;
    },
  };
  const uploads = createUploadIntake({
    archive: memory.archive,
    budget: createRecoveryIntakeBudget(),
    authority: {
      async authorize(context) {
        check(context);
        return { context, now, namespace: "recovery", expiresAt: 50000 };
      },
    },
  });
  const signer = createRecoverySigner({
    archive: memory.archive,
    authority,
    custody,
    uploads,
    commitAuthority,
  });
  return {
    ...memory,
    signer,
    authority,
    uploads,
    custody,
    accepted,
    commitAuthority,
    revoke() {
      revoked = true;
    },
    setContext(value: AuthenticatedRecoveryContext) {
      trustedContext = value;
    },
    setNow(value: number) {
      now = value;
    },
    setClosure(p: VersionManifest[], s: VersionManifest[], h: string[]) {
      parents = p;
      sources = s;
      heads = h;
    },
    commit(value: PreparedEnvelope) {
      committed = value;
    },
  };
}
