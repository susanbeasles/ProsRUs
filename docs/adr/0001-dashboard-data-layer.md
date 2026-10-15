# ADR 0001: Owner dashboard data layer and interim contracts

Status: accepted (2026-10-15)

## Context

The owner dashboard moved from one read-only component to a routed application with writes. Backend write commands and the recovery-status read were being built in parallel, and some contract details were settled during the work.

## Decisions

1. **No data-fetching library.** A small query cache and mutation client in `dashboard/lib/` keep the existing invariants (navigation generation, abort, byte bounds, catalog-only operations) explicit and testable without React.
2. **Per-grant workspace.** Each selected grant owns one cache and one mutation client. A grant change disposes both; nothing can cross grants. Navigation within a grant advances the cache generation instead of clearing completed data (stale-while-revalidate for exact keys).
3. **Write transport.** Writes follow Control's contract: fresh one-use nonce from `GET /owner/job-stack/api/nonce?grant=&method=POST&target=<query-free path>` per attempt, then `POST /owner/job-stack/api/operations/<name>?grant=` with `x-owner-nonce` and a JSON body of at most 64 KiB. The body carries `workspaceId` from the session (Control also injects it), `requestKey` and `body`.
4. **Transition table mirror.** `src/domain/rules.ts` keeps its transition table private, so `dashboard/lib/opportunity.ts` mirrors it. `tests/dashboard-transitions.test.ts` proves the mirror equal to the domain's `transition()` for every state pair, so a domain change fails the test instead of drifting silently.
5. **Interim recovery-status read.** `job_stack_recovery_status` is not yet in `integration/shared-contract.mjs`. The dashboard reads it with the existing owner GET flow at `/api/operations/job_stack_recovery_status?workspaceId=<session workspace>`, bounded to 16 KiB and validated by a strict local `recovery-status-v1` schema, while `request()` stays catalog-only. When the catalog gains the operation, its output limit applies automatically. Sequences are decimal strings and times epoch milliseconds, matching existing catalog encodings. A 501 renders "Backup status unavailable".
6. **Intentionally unavailable writes.** Packet creation and submission recording are refused before any request and rendered as disabled actions with reasons until the backend serves them (`INTENTIONALLY_UNAVAILABLE` in `lib/api.ts`).
7. **Default page.** A URL without `page` opens the pipeline, preserving pre-router deep links and the initial read budget; Overview is `page=overview`.
8. **DOM tests.** `happy-dom` is the only added devDependency. Because the core-planner identity hashes `package-lock.json`, its generated files were regenerated with `scripts/generate-core-planner-identity.mjs`; merging with another branch that changes the lock or planner sources requires re-running that generator.

## Consequences

The recovery-status schema and the unavailable-write list are local copies of contracts owned elsewhere and must be removed or updated when the catalog and backend catch up.
