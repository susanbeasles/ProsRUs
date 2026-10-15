# ADR 0002: Command ledger, idempotency and audit

Status: accepted (2026-10-15)

## Context

Every committed local-write must be captured for backup: one immutable `recovery_transactions` row and its `recovery_outbox` job in the same D1 batch through the maintained recovery store. Requests need idempotency by (owner, workspace, request key). `recovery_request_results` is the authoritative commit record and is written in that batch, but it is keyed to the domain plan digest (known only after planning on current reads), exists only after commit, cannot hold the lifecycle's retained root (allocation, observation, plans) and has no row for intake, which creates no recovery transaction.

## Decision

- Migration `0005_request_ledger.sql` (additive) adds `command_requests`: one row per owner/workspace/request key across all commands, pinning the operation id and the shared invocation input digest. Same key and digest replays; same key with another digest or operation is `request-key-conflict`; keys starting `internal-` are reserved for host baseline saves.
- Pending rows hold the retained lifecycle root under a compare-and-set revision. A committed local-write row stores only `recovery_transaction_id`; a trigger rejects the commit unless the matching `recovery_request_results` row exists, and replay reads that row (plus the committed version for domain entity/revision). Only intake outputs are stored in `result`. We therefore reuse `recovery_request_results` for every committed result and keep the ledger for what it cannot hold.
- Commit ordering: preparation and Control signing happen first; the single `before-ack` is taken immediately before `commitPrepared`, whose one D1 batch writes versions, heads, projections, request result, recovery audit, outbox job, domain `records`/`source_keys` and domain audit. No committed state exists without a passing `before-ack`, and nothing is asked of Control after it. The ledger flip to committed and its allow audit follow in a second batch; a lost flip is reconciled on replay from `recovery_request_results`.
- `command_audit` is append-only (update/delete/replace rejected) with one row per decision (`allow`, `replay`, `deny`, `conflict`) holding identifiers, stage and a fixed reason code only: no bodies, record content or owner contact addresses.

## Consequences

- A before-ack denial, validation failure or key conflict leaves no transaction, outbox job, result or business row; a pending ledger row may remain and resumes with the same meaning. Tests assert this for every enabled local-write.
- Immutable, content-addressed R2 package objects written during preparation can remain after a denial; they are unreferenced by D1 and unacknowledged.
- A denial at the first `read` has no trusted owner/workspace, so it is audited by Control only. A failure to write a denial audit row does not change the denial.
