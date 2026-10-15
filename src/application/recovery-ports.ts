import type { Principal } from "../domain/model";
import type {
  ArchiveInventory,
  ArchiveObjectRef,
  AuditEvent,
  AuthenticatedRecoveryContext,
  CommitCertificate,
  CurrentPursuitAuthorization,
  PreparedEnvelope,
  PreparedEnvelopePayload,
  ProtectionReceipt,
  ProtectionView,
  RecoveryCheckpoint,
  RecoveryEvent,
  RecoveryJobResult,
  RecoveryKind,
  RetentionObservation,
  SaveVersionInput,
  SaveVersionResult,
  SignatureAlgorithm,
  VersionManifest,
  WorkspaceChain,
  WorkspaceRef,
} from "../domain/recovery";

export type { AuthenticatedRecoveryContext } from "../domain/recovery";
export type ArchiveCapabilities = Readonly<{
  conditionalCreate: "atomic" | "unavailable";
  exactVersionRead: "provider_version" | "immutable_key_checked_identity";
  retentionObservation: "supported" | "unavailable";
}>;
export type ArchivePutInput = Readonly<{
  object: ArchiveObjectRef;
  bytes: Uint8Array;
  digest: string;
  hashPurpose:
    | "blob"
    | "manifest"
    | "transaction"
    | "preparation"
    | "commit"
    | "checkpoint"
    | "receipt"
    | "inventory"
    | "epoch_transition";
}>;
export type ArchivePutResult = Readonly<{
  object: ArchiveObjectRef;
  outcome: "created" | "matched_existing" | "appended_version";
}>;
export type ArchiveReadResult = Readonly<{
  object: ArchiveObjectRef;
  bytes: Uint8Array;
}>;
/** Byte-array archive methods are limited to 8 MiB; metadata remains 128 KiB.
 * Stream methods are required for original files, replication and restore. */
export type ArchiveStreamReadResult = Readonly<{
  object: ArchiveObjectRef;
  sizeBytes: number;
  mediaType: string;
  body: ReadableStream<Uint8Array>;
}>;
export type ArchiveStreamPutInput = Readonly<{
  object: ArchiveObjectRef;
  digest: string;
  hashPurpose: "blob";
  sizeBytes: number;
  transportSha256: string;
  body: ReadableStream<Uint8Array>;
}>;
export type ArchiveListInput = Readonly<{
  namespace: string;
  prefix: string;
  cursor: string | null;
}>;
export type ArchivePage = Readonly<{
  items: readonly ArchiveObjectRef[];
  nextCursor: string | null;
}>;
export type ArchiveReader = Readonly<{
  get: (object: ArchiveObjectRef) => Promise<ArchiveReadResult | null>;
  getStream: (
    object: ArchiveObjectRef,
  ) => Promise<ArchiveStreamReadResult | null>;
  list: (input: ArchiveListInput) => Promise<ArchivePage>;
}>;
/** Logical content-addressed identity: never replace mismatching bytes; always read back.
 * R2 uses atomic create-only writes and checks returned upload identity at immutable keys.
 * B2 may append a version and read exact fileId; GET then PUT is never an atomic CAS.
 * No deletion, mutable overwrite, retention administration or generic URL fetching port.
 */
export type PrimaryArchive = ArchiveReader &
  Readonly<{
    capabilities: ArchiveCapabilities &
      Readonly<{ conditionalCreate: "atomic" }>;
    putImmutable: (input: ArchivePutInput) => Promise<ArchivePutResult>;
    putImmutableStream: (
      input: ArchiveStreamPutInput,
    ) => Promise<ArchivePutResult>;
  }>;
export type ReplicaArchive = ArchiveReader &
  Readonly<{
    capabilities: ArchiveCapabilities;
    putImmutable: (input: ArchivePutInput) => Promise<ArchivePutResult>;
    putImmutableStream: (
      input: ArchiveStreamPutInput,
    ) => Promise<ArchivePutResult>;
    observeRetention: (
      object: ArchiveObjectRef,
    ) => Promise<RetentionObservation>;
  }>;
/** Host-owned capability. It revalidates issuer/audience/current grants and resolves
 * content/readback itself; a parsed context alone is not authenticated authority.
 * signCommit independently establishes the matching durable commit from trusted storage.
 * No arbitrary byte-signing, key export or receipt/checkpoint-signing endpoint.
 */
export type RecoverySigner = Readonly<{
  capabilities: Readonly<{
    custody: "trusted_server";
    algorithms: readonly SignatureAlgorithm[];
    trustRootIds: readonly string[];
  }>;
  signPreparation: (
    input: PreparedEnvelopePayload,
    context: AuthenticatedRecoveryContext,
  ) => Promise<PreparedEnvelope>;
  /** Public-key verification only; does not establish current authority or commitment. */
  verifyPreparation: (prepared: PreparedEnvelope) => Promise<void>;
  signCommit: (
    prepared: PreparedEnvelope,
    context: AuthenticatedRecoveryContext,
  ) => Promise<CommitCertificate>;
}>;
/** This independently deployed verifier uses its own archive reads and protected custody.
 * The primary API cannot issue receipts or advance/rewind its checkpoint.
 */
export type IndependentVerifier = Readonly<{
  verifyInventory: (inventory: ArchiveInventory) => Promise<ProtectionReceipt>;
  readCheckpoint: (
    workspace: WorkspaceRef,
  ) => Promise<RecoveryCheckpoint | null>;
  compareAndAdvance: (
    input: Readonly<{
      expected: RecoveryCheckpoint | null;
      next: RecoveryCheckpoint;
      receipt: ProtectionReceipt;
    }>,
  ) => Promise<RecoveryCheckpoint>;
}>;
export type RecoveryJobLease = Readonly<{
  jobId: string;
  transactionId: string;
  owner: string;
  fence: string;
  expiresAt: number;
  attempt: number;
  stage: RecoveryJobResult["stage"];
}>;
export type RecoveryProjection = Readonly<{
  kind: RecoveryKind;
  entityId: string;
  versionId: string;
  body: unknown;
}>;
/** Result.digest binds the result version's purpose-separated manifest hash.
 * Transaction chain digest hashes the unsigned PreparedEnvelopePayload with the
 * transaction purpose; preparation uses its own distinct purpose over that payload.
 * Atomic commit includes versions/envelope/heads/request-result/audit/durable outbox.
 * All mutating job finalization is checked against the lease fence at the DB sink.
 * History is append-only; no generic SQL, history update/delete or approval activation.
 */
export type CommittedRecovery = Readonly<{
  prepared: PreparedEnvelope;
  result: SaveVersionResult;
  observation: Readonly<{
    kind: "atomic_batch_statement";
    clock: "d1-unixepoch-subsec-v1";
    precisionMs: 1;
    observedAt: number;
    preparationDigest: string;
    transactionDigest: string;
    resultDigest: string;
  }> | null;
}>;
export type RecoveryStore = Readonly<{
  readCommitted: (
    input: Readonly<{ workspace: WorkspaceRef; transactionId: string }>,
  ) => Promise<CommittedRecovery | null>;
  commitPrepared: (envelope: PreparedEnvelope) => Promise<SaveVersionResult>;
  /** Save orchestration must provide its trusted canonical request digest before
   * checking heads/preparing a retry. A mismatched key fails REQUEST_KEY_CONFLICT.
   * Omitting the digest supports authorized result lookup only.
   */
  findRequest: (
    requestKey: string,
    expectedRequestDigest?: string,
  ) => Promise<SaveVersionResult | null>;
  getVersion: (versionId: string) => Promise<VersionManifest | null>;
  listVersions: (
    lineageId: string,
    cursor?: string,
  ) => Promise<
    Readonly<{ items: readonly VersionManifest[]; nextCursor: string | null }>
  >;
  /** Throws RECOVERY_WORKSPACE_UNINITIALIZED before the first atomic commit.
   * The host supplies the trusted initial workspace/epoch; the store invents none.
   */
  getChain: () => Promise<WorkspaceChain>;
  getHeads: (lineageId: string) => Promise<readonly string[]>;
  getPrepared: (transactionId: string) => Promise<PreparedEnvelope | null>;
  readAudit: (
    cursor: string | null,
  ) => Promise<
    Readonly<{ items: readonly AuditEvent[]; nextCursor: string | null }>
  >;
  getProtection: (versionId: string) => Promise<ProtectionView>;
  listDueJobs: (
    now: number,
    cursor: string | null,
  ) => Promise<
    Readonly<{ jobIds: readonly string[]; nextCursor: string | null }>
  >;
  claimJob: (
    jobId: string,
    owner: string,
    now: number,
    leaseMs: number,
  ) => Promise<RecoveryJobLease | null>;
  renewJob: (
    lease: RecoveryJobLease,
    now: number,
    leaseMs: number,
  ) => Promise<RecoveryJobLease | null>;
  finishJob: (
    lease: RecoveryJobLease,
    result: RecoveryJobResult,
    now: number,
  ) => Promise<"applied" | "stale_fence">;
  /** The trusted current server clock fences the write; receipt time is evidence.
   * An older receipt cannot regress lastCheckedAt, including concurrent writes.
   */
  projectProtection: (
    lease: RecoveryJobLease,
    receipt: ProtectionReceipt,
    now: number,
  ) => Promise<"applied" | "stale_fence">;
}>;
export type SourceAuthorization = Readonly<{
  sourceId: string;
  workspace: WorkspaceRef;
  accountId: string;
  resourceIds: readonly string[];
  grantId: string;
  grantRevision: string;
  expiresAt: number;
}>;
export type SourceRevision = Readonly<{
  sourceId: string;
  providerId: string;
  providerRevision: string;
  bytes: Uint8Array | null;
  mediaType: string;
  missing: boolean;
}>;
/** Bounded approved-source reads only. No sends, scheduling, publishing or capture. */
export type SourceReader = Readonly<{
  readPage: (
    input: Readonly<{
      authorization: SourceAuthorization;
      cursor: string | null;
    }>,
  ) => Promise<
    Readonly<{ items: readonly SourceRevision[]; nextCursor: string | null }>
  >;
}>;
export type RecoveryClock = Readonly<{ now: () => number }>;
export type AuthenticatedContextResolver = Readonly<{
  resolve: (
    actor: Principal,
    input: SaveVersionInput,
  ) => Promise<AuthenticatedRecoveryContext>;
}>;
/** Parseable archived evidence never confers authority. Host rechecks current owner,
 * exact opportunity and bounded correspondence/calendar scopes. Missing grant is denial.
 * Offers, compensation, sensitive disclosures and commitments require separate approval.
 */
export type CurrentPursuitResolver = Readonly<{
  resolve: (
    input: Readonly<{ actor: Principal; opportunityId: string; now: number }>,
  ) => Promise<CurrentPursuitAuthorization | null>;
}>;
/** No verifier, replica mutation, outbound action or credentials in the primary save path. */
export type RecoveryDependencies = Readonly<{
  store: RecoveryStore;
  archive: PrimaryArchive;
  signer: RecoverySigner;
  clock: RecoveryClock;
  contextResolver: AuthenticatedContextResolver;
}>;
export type SourceSyncPorts = Readonly<{
  reader: SourceReader;
  saveVersion: (input: SaveVersionInput) => Promise<SaveVersionResult>;
  checkpoints: Readonly<{
    read: (sourceId: string) => Promise<RecoveryEvent | null>;
    record: (checkpoint: RecoveryEvent) => Promise<SaveVersionResult>;
  }>;
  authorization: Readonly<{
    resolve: (sourceId: string) => Promise<SourceAuthorization | null>;
  }>;
  clock: RecoveryClock;
}>;
export type { PreparedUpload } from "../domain/recovery-upload";
export type RecoveryUploadResolver = Readonly<{
  resolve: (
    uploadHandle: string,
    context: AuthenticatedRecoveryContext,
  ) => Promise<import("../domain/recovery-upload").PreparedUpload>;
}>;
/** Current host authentication/resource-grant check. Archived session fields are
 * evidence only. A parsed context, same owner, or upload handle is not authority. */
export type UploadAuthority = Readonly<{
  authorize: (
    context: AuthenticatedRecoveryContext,
    stage: "start" | "chunk" | "complete" | "resolve",
    session: import("../domain/recovery-upload").UploadSession | null,
  ) => Promise<
    Readonly<{
      context: AuthenticatedRecoveryContext;
      now: number;
      namespace: string;
      expiresAt: number;
    }>
  >;
}>;
/** One shared lifecycle-owned budget, never a new/no-op instance per request. */
export type RecoveryIntakeBudget = Readonly<{
  run: <T>(
    kind: "metadata" | "chunk" | "finalize",
    work: () => Promise<T>,
  ) => Promise<T>;
}>;

/** Returned only by an authenticated host that independently resolves committed
 * parents and currently permitted committed sources. Archive candidates never qualify.
 * now/currentChain/currentHeads are fresh authority checks, not caller-issued fields. */
export type AcceptedPreparation = Readonly<{
  format: "bound-primary-v1";
  domainPlan?: import("../domain/recovery-domain-plan").AcceptedDomainPlan;
  input: SaveVersionInput;
  context: AuthenticatedRecoveryContext;
  now: number;
  currentChain: WorkspaceChain;
  currentHeads: readonly string[];
  transactionId: string;
  versionId: string;
  namespace: string;
  parents: readonly VersionManifest[];
  sources: readonly VersionManifest[];
}>;
export type RecoveryPreparationAuthority = Readonly<{
  accept: (
    input: SaveVersionInput,
    context: AuthenticatedRecoveryContext,
  ) => Promise<AcceptedPreparation>;
  resolveAccepted: (
    transactionId: string,
    context: AuthenticatedRecoveryContext,
  ) => Promise<AcceptedPreparation | null>;
}>;
/** Exact durable D1 commit plus CURRENT background authority, separately from the
 * preserved, possibly expired client/grant/precommit-chain provenance. */
export type RecoveryCommitAuthority = Readonly<{
  resolveCommitted: (
    transactionId: string,
    context: AuthenticatedRecoveryContext,
  ) => Promise<Readonly<{
    prepared: PreparedEnvelope;
    context: AuthenticatedRecoveryContext;
    now: number;
    committedAt: number;
  }> | null>;
}>;
export type RecoverySigningCustody = Readonly<{
  verificationKey: import("../domain/recovery-canonical").RecoveryVerificationKey;
  signPreparation: (
    binding: import("../domain/recovery").RecoverySignatureBinding &
      Readonly<{ purpose: "preparation" }>,
  ) => Promise<import("../domain/recovery").RecoverySignature>;
  signCommit: (
    binding: import("../domain/recovery").RecoverySignatureBinding &
      Readonly<{ purpose: "commit" }>,
  ) => Promise<import("../domain/recovery").RecoverySignature>;
}>;
