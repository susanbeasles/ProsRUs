import { z } from "zod";
import type { SharedInvocation } from "../../../integration/shared-contract.mjs";
import { demand, DomainError } from "../../domain/model";
import {
  authenticatedRecoveryContextSchema,
  workspaceChainSchema,
  type AuthenticatedRecoveryContext,
  type VersionManifest,
  type WorkspaceChain,
} from "../../domain/recovery";
import { MAX_DOMAIN_REFERENCES } from "../../domain/recovery-domain-plan";
import { equalMetadata } from "../../storage/recovery-metadata";
import type {
  AcceptedPreparation,
  RecoveryPreparationAuthority,
  RecoveryStore,
} from "../recovery-ports";

/** The recovery context is a projection of the current shared invocation: the
 * invocation itself is embedded as signed grant evidence. Nothing is invented. */
export function recoveryContext(
  invocation: SharedInvocation,
  chain: WorkspaceChain,
): AuthenticatedRecoveryContext {
  const grant = invocation.grant,
    workspace = invocation.capability.workspace;
  return authenticatedRecoveryContextSchema.parse({
    workspace,
    actor: {
      id: grant.principalId,
      kind: "service",
      scopes: [invocation.operation.scope],
      expiresAt: invocation.expiresAtMs,
    },
    issuer: grant.issuer,
    audience: grant.audience,
    grant: {
      id: grant.id,
      revision: String(grant.revision),
      issuerPrincipalId: grant.issuerPrincipalId,
      sharedAuthority: invocation,
      scopes: grant.scopes,
      resourceBounds: [{ kind: "workspace", id: workspace.workspaceId }],
      expiresAt: grant.expiresAtMs,
    },
    chain,
    serverTime: invocation.authorizedAtMs,
  });
}

/** Current workspace chain. Before the first commit the trusted initial epoch
 * comes from the Control capability; the store invents none. A recovery binding
 * for another workspace of the same owner is a denial, never a rebinding. */
export async function currentChain(
  db: D1Database,
  store: RecoveryStore,
  invocation: SharedInvocation,
): Promise<WorkspaceChain> {
  const { ownerId, workspaceId } = invocation.capability.workspace;
  const bound = await db
    .prepare("SELECT workspace_id FROM recovery_workspaces WHERE owner=?")
    .bind(ownerId)
    .first();
  if (bound !== null)
    demand(
      z.object({ workspace_id: z.string() }).parse(bound).workspace_id ===
        workspaceId,
      "RECOVERY_WORKSPACE_MISMATCH",
      409,
    );
  try {
    return await store.getChain();
  } catch (error) {
    if (
      !(error instanceof DomainError) ||
      error.code !== "RECOVERY_WORKSPACE_UNINITIALIZED"
    )
      throw error;
    return workspaceChainSchema.parse({
      epochId: invocation.capability.initialEpochId,
      sequence: "0",
      previousTransactionDigest: null,
    });
  }
}

/** Committed manifests reachable from the given versions through parent and
 * source edges, bounded by the maintained domain closure ceiling. */
export async function committedClosure(
  store: RecoveryStore,
  roots: readonly string[],
): Promise<VersionManifest[]> {
  const seen = new Map<string, VersionManifest>(),
    pending = [...roots];
  while (pending.length) {
    const versionId = pending.pop();
    if (versionId === undefined || seen.has(versionId)) continue;
    demand(
      seen.size < MAX_DOMAIN_REFERENCES,
      "DOMAIN_CLOSURE_TOO_LARGE",
      409,
    );
    const manifest = await store.getVersion(versionId);
    demand(manifest, "RECOVERY_MANIFEST_CLOSURE_MISMATCH", 409);
    seen.set(versionId, manifest);
    pending.push(...manifest.parentVersionIds, ...manifest.sourceVersionIds);
  }
  return [...seen.values()];
}

/** Product-hosted acceptance: the Coordinator is the authenticated host that
 * owns D1 heads/chain and resolves committed parents/sources itself. The
 * refresh callback re-reads current chain/heads; any drift withdraws acceptance. */
export function hostPreparationAuthority(
  accepted: AcceptedPreparation,
  refresh: () => Promise<Readonly<{ fresh: boolean; now: number }>>,
): RecoveryPreparationAuthority {
  return {
    async accept(_input, context) {
      demand(
        equalMetadata(context, accepted.context),
        "RECOVERY_AUTHORITY_MISMATCH",
        403,
      );
      return accepted;
    },
    async resolveAccepted(transactionId, context) {
      if (
        transactionId !== accepted.transactionId ||
        !equalMetadata(context, accepted.context)
      )
        return null;
      const current = await refresh();
      return current.fresh ? { ...accepted, now: current.now } : null;
    },
  };
}
