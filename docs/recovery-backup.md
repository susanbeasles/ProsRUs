# Backup, checkpoints and restore: operator guide

Design and rationale: [ADR 0004](adr/0004-continuous-backup-and-restore.md).
Acceptance proof: `npm run test:replicator` (real local Workerd; 12 checks).

## What runs where

| Piece | Identity | Bindings | Schedule |
| --- | --- | --- | --- |
| Product `job-stack-<env>` | product Worker | `DB`, `ORIGINALS`, `UPLOADS`, `JOBS`, `CONTROL_AUTHORITY` | none |
| Replicator `job-stack-<env>-replicator` | its own Worker | `DB`, `ORIGINALS` (read), `BACKUP`, `RECEIPT_SIGNING_KEY` | `*/5`, `23 3 * * *`, `53 3 1 * *` |

The product never binds `BACKUP` (enforced in `scripts/configure.mjs` and by the
infra exclusive-bucket test). Buckets per environment:

| Bucket | Holds | Protection |
| --- | --- | --- |
| `-uploads` | upload sessions, receipts, chunks | lifecycle delete 7d, abort multipart 1d, no lock |
| `-originals` | promoted originals, packages, preparations | whole-bucket lock 30d, no lifecycle delete |
| `-backup` | `changes/`, `receipts/` (30d), `checkpoints/daily` (90d), `checkpoints/monthly` (365d), `objects/` (365d lock, no lifecycle) | prefix locks; lifecycle one day after each lock |

## Status meanings (`job_stack_recovery_status`)

| State | Meaning |
| --- | --- |
| `protected` | Every committed transaction has a verified receipt, and a verified checkpoint is under 26h old. |
| `protection_pending` | Committed work is replicating; oldest pending commit is 15 minutes old or less. |
| `delayed` | Pending work is older than 15 minutes (or the replicator has no signing key yet). |
| `degraded` | History is verified but no verified checkpoint exists within 26h. |
| `failed` | At least one job is quarantined or dead-lettered. Investigate before anything else. |
| `unavailable` | No recovery chain is bound for the workspace yet. |

D1 Time Travel is never reported as protection.

## Commissioning (root provisioning path, owner)

1. Root stack creates the three buckets, the replicator Worker (placeholder),
   its crons and bindings. `cf-root-apply` needs Workers Scripts Edit (seed
   inventory change pending with the owner).
2. Create the receipt signing key offline (ES256 / P-256). Store only the
   private JWK, as `{"format":"recovery-signing-key-v1","keyId","algorithm":"ES256","privateJwk":{…}}`,
   in Secrets Store as `job-stack-<env>-receipt-signing-key`. Keep the public
   half as a `recovery-trust-root-v1` document for restores. Never commit either.
3. Set `OWNER_ID` on the replicator to the capability owner id.
4. Deploy through the release pipeline; the replicator target uses the
   `worker-version/v1` health contract (no route).

Until step 2 completes, jobs stop at the receipt stage with
`receipt_custody_unavailable` and status reads `delayed`; nothing is labelled
protected.

## Restore (never in place)

1. Through the root path, create a NEW D1 database and a NEW originals bucket.
   Do not point anything at them yet.
2. Copy `wrangler.restore.example.jsonc` to an untracked
   `wrangler.restore.jsonc`; fill the new ids, `OWNER_ID` and the receipt
   `RECEIPT_TRUST_ROOT`.
3. `npx wrangler dev -c wrangler.restore.jsonc --port 8799` (remote bindings;
   the entry answers loopback requests only, in `operator-local` mode only).
4. `node scripts/restore.mjs <workspaceId> <restoreId> [targetSequence|latest]`.
   The restore chooses the newest signed, verified checkpoint at or before the
   target, rebuilds tables, restores triggers, replays later changes through the
   production commit path (every chain, head, parent and domain guard re-checked),
   applies repository migrations only when a change needs them, then re-hashes and
   copies every referenced file, recording a restore alias per pinned version.
5. Review the report. `outcome: "partial"` names `stoppedAt.sequence` and the
   reason (`change_gap`, `schema_migration_required`, `change_link_broken`, …):
   the database is consistent through `restoredThrough`.
6. Reconcile infrastructure: point the product and replicator bindings at the
   restored resources through the root stack, review the plan, then apply.
   Restoring Terraform state does not roll back infrastructure; follow
   infra `docs/state-protection.md`.

Interrupted uploads are not restored; clients restart them. Preparation
wrappers are pre-commit evidence and are not backed up.

## Items to confirm at first live run (VERIFY)

- D1 `meta.size_after` and table-valued `pragma_table_info` / `pragma_foreign_key_list`
  behave in production D1 as in local Workerd.
  https://developers.cloudflare.com/d1/sql-api/sql-statements/
- The deployer's D1 migration ledger table name (restore writes `d1_migrations`).
- R2 `put` with `sha256` and `onlyIf: { etagDoesNotMatch: "*" }` semantics on
  locked buckets. https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- Scheduled Worker CPU limits against the checkpoint verification budget (2 GiB per run).
