import type { SaveVersionResult } from "../../domain/recovery";
import { demand } from "../../domain/model";
import { prepareRecoveryPackage } from "../recovery-preparation";
import {
  recoveryRequestDigest,
  resolveRequestUpload,
  snapshotSaveInput,
} from "../recovery-request";
import type {
  AcceptedPreparation,
  PrimaryArchive,
  RecoverySigner,
  RecoveryUploadResolver,
} from "../recovery-ports";
import { createRecoveryStore } from "../../storage/recovery-store";
import { equalMetadata } from "../../storage/recovery-metadata";
import type { CommandSession } from "./session";
import {
  currentChain,
  hostPreparationAuthority,
  recoveryContext,
} from "./recovery-host";

export type VersionSaveCommandPorts = Readonly<{
  db: D1Database;
  archive: PrimaryArchive;
  signer: RecoverySigner;
  uploads?: RecoveryUploadResolver;
  ids: () => string;
}>;

/** `job-stack.version.save.v1`: one inert archival version through the
 * maintained prepare/sign/commit path. Parents/sources must be committed in
 * this workspace; heads are checked by the host and again by the D1 sink. */
export async function runVersionSave(
  session: CommandSession,
  ports: VersionSaveCommandPorts,
): Promise<SaveVersionResult> {
  demand(
    session.request.operationId === "job-stack.version.save.v1",
    "operation-unavailable",
  );
  const { workspaceId: ignored, ...raw } = session.request.input;
  void ignored;
  const input = snapshotSaveInput(raw),
    invocation = session.invocation,
    store = createRecoveryStore(ports.db, session.workspace.ownerId),
    chain = await currentChain(ports.db, store, invocation),
    context = recoveryContext(invocation, chain);
  const upload = await resolveRequestUpload(input, context, ports.uploads);
  const requestDigest = await recoveryRequestDigest(
    input,
    context.workspace,
    upload,
  );
  // A lost ledger flip reconciles to the committed winner; a changed meaning
  // under the same key fails REQUEST_KEY_CONFLICT inside the store.
  const prior = await store.findRequest(input.requestKey, requestDigest);
  if (prior) return prior;
  async function manifests(ids: readonly string[]) {
    const values = [];
    for (const versionId of ids) {
      const manifest = await store.getVersion(versionId);
      demand(manifest, "RECOVERY_CLOSURE_MISSING", 409);
      values.push(manifest);
    }
    return values;
  }
  const heads = await store.getHeads(input.lineageId);
  const accepted: AcceptedPreparation = {
    format: "bound-primary-v1",
    input,
    context,
    now: session.now(),
    currentChain: chain,
    currentHeads: heads,
    transactionId: ports.ids(),
    versionId: ports.ids(),
    namespace: invocation.capability.namespace,
    parents: await manifests(input.expectedParentIds),
    sources: await manifests(input.sourceVersionIds),
  };
  const authority = hostPreparationAuthority(accepted, async () => ({
    fresh:
      equalMetadata(await currentChain(ports.db, store, invocation), chain) &&
      equalMetadata(await store.getHeads(input.lineageId), heads),
    now: session.now(),
  }));
  const prepared = await prepareRecoveryPackage(input, context, {
    archive: ports.archive,
    signer: ports.signer,
    authority,
    uploads: ports.uploads,
  });
  await session.authorize("before-ack");
  return store.commitPrepared(prepared);
}
