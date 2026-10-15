# Recovery storage migration

Migration `0002_recovery.sql` adds local recovery storage after `0001.sql`. It
does not deploy resources, apply a remote migration, archive legacy bytes, verify
signatures or activate recruiting authority. The trusted host must authorize and
verify a prepared envelope before calling `createRecoveryStore(db, owner)`.

## Atomic save boundary

One D1 batch creates the immutable transaction, candidate manifests, lineage
bindings, head changes, rebuildable record/protection projections, schema-versioned
request result, audit and durable outbox job. The first batch also binds one
immutable workspace per owner and initializes its chain from the trusted prepared
envelope's explicit epoch. Before that commit, `getChain()` throws
`RECOVERY_WORKSPACE_UNINITIALIZED`; reads never invent an epoch or create storage.

The SQL transaction guard compares the workspace, epoch, exact decimal sequence,
previous transaction digest, lineage/entity identity, resolved parents and
non-branch expected heads inside D1. A failed comparison raises `ABORT`. Chain
advancement must change exactly one row; a zero-row update also aborts. D1 batch
rollback includes preceding history, result, audit, heads and outbox writes. R2
and Queues are outside this transaction. Later preparation/orchestration must
persist and read back the complete primary payload before invoking this adapter.

`SaveVersionResult.digest` is `hashEnvelope('manifest', selectedManifest)`.
`transactionDigest` is `hashEnvelope('transaction', unsignedPreparedPayload)`.
Preparation uses its own purpose over the unsigned payload. None of these is an
artifact's exact-byte digest. The adapter checks the selected manifest digest;
signature verification, current grant checks and primary object evidence remain
the trusted host/preparation boundary's responsibilities.

Request keys are owner/workspace scoped. A same-key, same-request-digest retry
returns the stored original result without creating another version or job. A
different digest conflicts, including concurrent retries. Save orchestration
must call `findRequest(key, trustedRequestDigest)` before stale-head/preparation
checks. Its one-argument form is an authorized read lookup only. Commit repeats
the digest guard and reconciles a failed batch against the stored result, covering
an identical race or a lost commit response.
Every persisted result returned by commit is joined to its immutable transaction
and checked against the candidate's owner, workspace and epoch as well as the
request digest. A concurrent bootstrap winner in a different workspace or epoch
cannot turn a losing batch or stale identity pre-read into a successful acknowledgment.

## History and mutable projections

Transactions, lineages, manifests, events, request results, audit, job history,
protection receipts and imported baseline candidates are append-only. UPDATE and
DELETE reject; duplicate insertion guards also reject `INSERT OR REPLACE`,
including alternate unique lineage/entity and transaction/lineage identities.
The guards also cover SQLite's common `rowid`/`_rowid_`/`oid` identity and a
transaction's unique epoch/sequence slot, independently of mutable chain position.
All ten immutable tables also enforce a positive final ordinal with AFTER INSERT
guards. SQLite exposes a provisional -1 before ordinary or NULL rowid allocation;
the AFTER guard checks the actual allocated value. New explicit -2, -1 or 0 through
any rowid alias rejects with `RECOVERY_INVALID_ORDINAL` and rolls back its statement
and D1 batch. Supported unused positive ordinals, omitted rowids and explicit NULL
allocation remain valid. Prior replacement guards remain active; no -1 exemption
is introduced and pagination continues to use stable positive local ordinals.
This does not protect against an administrator dropping triggers or tables. The
adapter exposes no generic SQL, delete or history-update operation.

Heads, record projections, protection views, chain position and outbox execution
state are distinct mutable tables. Explicit branches preserve alternate heads
without replacing the ordinary record projection. Decimal chain sequences and
lease fences are strings, incremented using exact decimal/BigInt operations.
Version, audit and due-job lists use scoped cursors and bounded 100-item pages;
callers must follow `nextCursor` until null rather than treat a first page as a
complete inventory.

Before any separately authorized rollout or restore, inventory retained immutable
tables for nonpositive ordinals. This prospective guard does not repair a database
that already contains them, and an existing -1 can still conflict with the BEFORE
INSERT sentinel. Quarantine the affected store from ordinary write/restore use and
retain its exact history for non-destructive review. Never delete, renumber, replace
or silently rewrite those rows to make the invariant appear satisfied. A forward
compatibility/repair plan needs separate review and authorized migration; this task
performs no live inventory, quarantine or repair. Provider restore must allocate
fresh valid local ordinals while preserving logical history identities and archive
evidence, rather than replay physical SQLite rowids from an exported snapshot.

Claim/takeover increments a fence. Renewal, finalization and protection projection
check current lease owner, fence, transaction, attempt and expiry again at the D1
sink. `projectProtection(lease, receipt, now)` requires the trusted current server
clock. A backdated receipt cannot revive an expired lease. A future receipt rejects,
and a sink trigger rejects `RECOVERY_PROTECTION_REGRESSION` when a receipt would
reduce an already-observed `lastCheckedAt`, rolling back its receipt/projection/audit
batch. Equal observation times remain allowed. The stored receipt is evidence;
this adapter does not independently verify its signature or archive inventory.

## Legacy upgrade and baseline archival

The migration leaves all legacy tables and rows intact. It captures current
`records`, `source_keys`, `intents` and `audit` as `recovery_import_baselines` with
`imported_legacy_baseline` provenance, schema version 1 and pending archive state.
Record revisions and timestamps, original JSON bodies, source associations and
historical action state/receipts are retained. Packet/artifact availability is
`unobserved`, because SQL cannot establish whether the R2 original still exists;
other baseline rows use `not_applicable`. Credentials, OAuth state and scheduling
run rows are neither copied into these baseline packages nor altered.

There are zero committed recovery versions after migration alone. No signed
manifest, verified protection receipt, invented original or fabricated past
revision is inserted. A missing original remains unavailable until a trusted
artifact inspection establishes its actual state. A historical approval or sent
receipt cannot grant current pursuit, sending, scheduling or publishing authority.
The existing operational projections are retained unchanged; Task 4 must wire the
current opportunity-specific pursuit gate before any employer/recruiter contact.

Later Task 4 archives each baseline through Task 3 preparation and the single
atomic commit path before the next revision, retaining the legacy projection's
revision. The immutable pending candidate is evidence of the upgrade snapshot,
not a mutable completion flag. Completion must be reconciled against committed
history/request results. No live backfill is activated by this migration.

## Local verification and rollout limits

`npm run test:recovery` uses real Miniflare D1. The test migration loader applies
numeric-ordered files in atomic batches with a local fixture ledger, preserves
multi-statement trigger bodies and skips already-recorded migrations. The ledger
is test infrastructure, separate from Wrangler's production migration tracking.
Fresh database, repeated loader application and populated `0001.sql` upgrade
fixtures are exercised. Do not execute the same CREATE TABLE migration twice
without a migration ledger.

Coverage includes whole-batch rollback at all 13 prepared-save statement boundaries,
head/chain failure and zero-row CAS abort, same-key retry/conflict, cross-document
sequence and first-workspace races, branch identity/parents, immutable UPDATE,
DELETE and replacement constraints, fenced protection/finalization, 501-item
pagination, exact large decimals and preserved legacy bodies/approvals/artifact
uncertainty. Logs and exact verification outcomes are recorded with the Task 2
checkpoint report. These fixtures establish local SQL/runtime behavior, not live
provider protection or a measured durability/restore service-level objective.

A future live rollout must first inventory the target, select the authorized
migration/signing route, quiesce incompatible writers, preserve a recoverable
backup and run the populated upgrade/acceptance checks on a reviewed staging
snapshot. This task grants no such rollout authority. There is no destructive
down migration: do not drop recovery history to roll back code. Disable the new
writer and preserve the schema/history while investigating; repair forward under
review or restore a complete known-good backup through the separately authorized
restore path. Test batches that abort leave no partial migration ledger/schema or
prepared-save rows. Signed delivery remains required; an unsigned Git fallback
is not permitted.
