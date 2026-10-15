# ADR 0001: Finite command registry

Status: accepted (2026-10-15)

## Context

The shared catalog declares 20 non-read operations (14 domain local-writes, `job-stack.version.save.v1`, `job-stack.meeting.import.v1`, `job-stack.profile.export.v1` and upload begin/chunk/complete), but the Coordinator routed only six reads and every write was denied by a single `denyLegacyEffect()`. The core planner/lifecycle and the recovery prepare/sign/commit path already implement the mechanics. Control (`personal-control` 6b4831b) accepts, per invocation, one or more `read` decisions followed by exactly one `before-ack`; any later call or any denial is terminal. It mints only owner invocations and passes on only lowercase kebab-case error codes.

## Decision

- `src/application/commands/registry.ts` holds one explicit availability decision per non-read catalog id; nothing else is dispatchable. Unavailable entries carry a reason. Reads keep their existing route. Legacy service/executor entry points and external effects (send, schedule/reschedule/cancel, mail sync, discovery, document import, reconciliation, queue, cron) deny through `denyLegacyOperation` with a documented reason.
- `JobStack.invokeCore` refuses unavailable operations before any authority call, takes the first `read`, and forwards to the workspace Coordinator. `Coordinator.invokeCore` runs every command in a per-object serial tail.
- The pipeline (`execute.ts`): registry -> pinned authority session (`read`) -> owner-only check (`entrypoint === 'owner'` and `verifiedOwnerPrincipalId === grant.issuerPrincipalId`) -> reserved key check -> ledger decision -> command -> `validateCoreOutput` -> single `before-ack` (if the command did not already take it) -> release with an allow audit.
- Domain commands run the maintained `runCoreOperation` with Product ports; version saves call `prepareRecoveryPackage` directly; intake wires `recovery-uploads.ts` unchanged. The Coordinator is the authenticated host for acceptance (it owns D1 chain/heads/parents; namespace and initial epoch come from the Control capability). Signing custody stays with Control through the declared `signPreparation` RPC; the Product verifies every signature against the public `RECOVERY_TRUST_ROOT` and fails closed without it.

## Consequences

- Available: claim add/review, profile conflict resolve, opportunity capture/assess/transition, conversation capture/associate/draft, interview prepare, offer record, settings update, version save, upload begin/chunk/complete.
- Unavailable: packet create and submission record (their plans need current claim-permission evidence that only Control can resolve, and the contract has no resolver), meeting import (no meeting `authorizationRef` resolver; upload sessions do not bind one), profile export (no maintained export mechanics).
- Production blockers outside this repository: Control does not implement `signPreparation`, so versioned saves deny (`recovery-signing-denied`, or `recovery-signing-authority-unavailable` when no trust root is configured); Control's owner proxy forwards JSON only and does not route the `owner-binary` chunk transport, so uploads cannot complete end to end. Product mechanics are proven against a synthetic Control that implements the declared request schemas.
- An unversioned legacy row first needs an inert baseline save. Because Control allows one `before-ack` per invocation, the baseline batch spends it and the command answers `domain-baseline-committed-retry`; the retried request resumes from the retained root. The maintained planner bounds each commit's committed closure at 128 versions, which caps per-lineage history depth for domain writes.
