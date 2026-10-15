# ADR 0004: Continuous backup, checkpoints and restore

Status: accepted (owner decisions, 2026-10-15)

## Context

Every committed product change is already one immutable, hash-chained
`recovery_transactions` row written in the same D1 batch as its domain effects,
request result, audit rows and one `recovery_outbox` job (stage
`primary_journal`). Exact originals are immutable, content-addressed objects.
Nothing consumed the outbox, so `recovery_protection` stayed
`protection_pending` forever and no independent copy existed.

The owner chose continuous version capture with incremental backups and periodic
complete checkpoints. Files and databases are captured differently but restored
by one procedure. The backup destination must be independent of the application,
retention must be bounded, and the UI must never call pending work "protected".

## Decision

### Separate identity and destination

A second Worker, `job-stack-<env>-replicator`, built from this repository
(`src/replicator/`, `wrangler.replicator.jsonc`) is the only principal bound to
the `job-stack-<env>-backup` bucket. The product Worker has no binding to it, no
service binding to the replicator and no shared queue, so no product code path can
write, overwrite or delete backup history. The replicator reads `DB` and
`ORIGINALS`, writes `BACKUP`, and signs receipts with its own key
(`RECEIPT_SIGNING_KEY`, a Secrets Store binding that only it holds). The replicator
has no route, no `workers.dev` subdomain and no `fetch` surface beyond a 404.

It wakes on its own crons: a 5-minute sweep of due outbox jobs (the outbox is the
durable queue; nothing is lost if a wake-up is missed), a daily checkpoint plus
retention pass at 03:23 UTC, and a monthly checkpoint on day 1.

### Backup layout (create-only)

```
changes/<workspaceId>/<sequence:20>-<transactionDigest>.json   recovery-change-v1
receipts/<workspaceId>/<sequence:20>.json                      signed protection receipt
checkpoints/<daily|monthly>/<workspaceId>/<period>/manifest.json + tables/<table>.ndjson
objects/sha256/<first two hex>/<sha256>                        exact file bytes, deduplicated
```

Every put is conditional create-only. An existing object whose bytes hash to the
expected digest is `matched_existing`; anything else is an integrity fault that
quarantines the job. Only new content is copied. There are no binary-diff chains:
a file version is always restorable from one object.

### Ordered, idempotent replication

The replicator claims jobs through the existing fenced lease. For transaction N it:

1. **primary_journal**: reads the committed envelope from D1 and re-hashes every
   primary object it names in `ORIGINALS`.
2. **replicate**: refuses to proceed until transaction N-1 has a receipt (ordering
   per workspace), then writes the change record and copies each missing object.
3. **verify**: reads every replica object back and re-hashes it.
4. **receipt**: signs a `protection receipt` (primary and replica observations
   must describe the same content set), writes it create-only, and projects
   `verified_both` through `RecoveryStore.projectProtection` under the lease fence.
5. **complete**.

A failure records the stage reached as `retryable` with bounded exponential
backoff. Integrity faults become `quarantined`, and repeated failure becomes
`dead_letter`. Duplicate delivery, crash-after-put and lease theft are all
idempotent: puts match existing bytes, the receipt key is per sequence and
`projectProtection` is fenced.

### Checkpoints

A checkpoint is one D1 batch (one SQLite read transaction) that captures the chain
head, the latest applied migration, the DDL of every application table, index and
trigger, and every row of every table in insertion order (`rowid`, or primary key
for `WITHOUT ROWID` tables). It also lists every file object the retained state
references. Table dumps and the manifest are written create-only. A checkpoint
becomes **verified** only after the replicator reads every table object and every
referenced file object back from `BACKUP` and re-hashes it. Then one immutable
`recovery_checkpoints` row is appended. A database too large for one consistent
batch fails explicitly with `checkpoint_too_large`; it is never split into
inconsistent pages.

### Restore

Restore is never in place. It targets a new D1 database and a new originals bucket:

1. Choose the newest verified checkpoint at or before the target.
2. Recreate its tables and indexes, load rows in order, then recreate its triggers.
3. Replay later change records in sequence order through the production
   `RecoveryStore.commitPrepared` path, so every chain, head, parent and guarded
   domain predicate is re-checked by the same SQL triggers as the original commit.
4. Re-hash and copy every referenced file from `objects/`.
5. Emit a restore report.

Changes recorded under a newer schema than the restored database stop the replay
until the matching migrations are applied.

### Retention

Changes and receipts are kept for 30 days, daily checkpoints for 90 days and
monthly checkpoints for 12 months. Bucket lifecycle rules (Terraform) expire them
one day after their lock ends. Objects have a 365-day lock and no lifecycle rule.
The replicator deletes an object only when its lock has expired and no retained
checkpoint, retained change or current original references it.

### Status

`job_stack_recovery_status` reports `protected` only when the latest verified
sequence equals the head sequence and a verified checkpoint exists within 26
hours. Pending work is `protection_pending` (15 minutes or less) or `delayed`.
Quarantined or dead-letter jobs report `failed`. D1 Time Travel is a platform layer and
is never reported as protection.

## Consequences

- **Runtime cannot see lock rules.** The R2 binding cannot observe bucket lock
  rules. Receipts therefore record retention as `mode: "unknown"`. The lock and
  lifecycle configuration is proven by the infra repo's `tofu test` and by
  plan/drift review, not by runtime claims.
- **Root provisioning prerequisites.** Before the replicator can sign anything,
  the receipt key and the replicator Worker must be provisioned through the
  privileged root path. Until then jobs wait at `receipt` with
  `receipt_custody_unavailable` and the UI shows `delayed`, never `protected`.
- **Checkpoint size.** Checkpoint size is bounded by one D1 batch response. A
  larger dataset needs a reviewed export path (D1 export API through the root
  path) instead of silent pagination.
- **Commit observation time.** Replay re-establishes the commit observation at
  restore time. The restore report records both the original and the replayed
  observation times.
