# Primary recovery package and exact-original intake

This is the local Task 3 capability. It does not expose HTTP upload/save routes, commit a version, process a recording, issue independent-protection receipts, or activate a production signer. Those are separately owned integration tasks. All sources and unresolved candidates remain retained.

## Entry points and outcome meaning

- `createPrimaryArchive(bucket)` binds a private R2 bucket and offers immutable byte/stream writes, pinned reads and bounded listing. It does not authorize an owner or namespace.
- `createUploadIntake({ archive, authority, budget })` provides `begin`, `putChunk`, `complete`, and `resolve`. Missing current authority or shared admission fails closed. A handle alone grants no access.
- `prepareRecoveryPackage(input, context, { archive, signer, authority, uploads })` returns a `PreparedEnvelope` only after complete original bytes, manifests, package and signed wrapper exist and pass readback. This operation has no D1 port and never commits.
- `createRecoverySigner({ archive, authority, custody, uploads, commitAuthority })` independently reconstructs accepted content before purpose signing. Calling it without host ports returns an unavailable signer, never a test signer.
- `openVerifiedArtifact(archive, descriptor)` fully hashes an exact pinned read before opening a second stream pinned to that same provider identity. The delivery stream must be consumed or cancelled by its owner.

`upload_started`, `chunk_stored`, and a `PreparedUpload` are intake outcomes. A preparation is preserved intent with `commitStatus: unknown`. Its embedded `result` is the proposed atomic-commit result, not permission to send that result to a client. Only authorized save orchestration may return `saved_primary` / `protection_pending` after the complete preparation and D1 atomic commit. No Task 3 helper claims independent protection.

## Explicit supported limits

| Input or work                             | Local implementation bound                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Exact original file                       | 1 through 1,073,741,824 bytes (1 GiB)                                                              |
| Chunk body and byte-array archive API     | At most 8,388,608 bytes (8 MiB)                                                                    |
| Selected chunk count                      | At most 128, fixed ordinal geometry                                                                |
| Canonical structured envelope/metadata    | 131,072 bytes (128 KiB), including its overhead                                                    |
| Sequential native byte-stream read buffer | 65,536 bytes                                                                                       |
| Shared active intake                      | Two chunks, one finalization, eight metadata operations, at most 84 MiB of accounting reservations |

Direct structured content is limited to 128 KiB, and every enclosing canonical package/wrapper must also fit its 128 KiB envelope. Thus metadata overhead and repeated manifests can cause a smaller structured request to be rejected explicitly. Large original files use staged handles. No overflow path truncates or recompresses input. Files with one byte beyond the maximum are rejected from their declared metadata before storing a session or allocating a file-sized buffer.

The host must bind one `createRecoveryIntakeBudget()` for its whole isolate/service lifecycle and share it across intake factories and requests. A per-request budget or no-op adapter defeats admission and is not a supported assembly. Reservations account for bounded copies but are not a measured Workerd heap ceiling. Multi-isolate quotas, deployed CPU/time/subrequest limits, request/proxy body limits, timeouts and latency remain acceptance work. A lower deployed maximum must be explicit in the API and UI; it cannot silently override this contract.

## Immutable staged inventory

1. `begin` validates exact original size, filename, declared media type, format and last-modified metadata. It creates an opaque server session and an immutable owner/workspace request-to-session selection before acknowledging. Matching request retries return the selected session; changed metadata conflicts. Competing unselected sessions remain retained.
2. `putChunk` validates current authority and session binding, obtains admission, reads exactly the ordinal's expected size, hashes exact bytes with the existing recovery blob domain, and create-only writes the content-addressed chunk. A create-only selected receipt binds the session descriptor, ordinal, request key and pinned byte descriptor before acknowledgment. Matching retries retain identity. A changed body or different request identity cannot replace that ordinal.
3. `complete` resolves every selected receipt in order, persists the complete selection, sequentially hashes original bytes, promotes through a known-length `FixedLengthStream`, and verifies the full pinned final object. Only then is immutable ready metadata written and reread. Each pass checks every selected chunk's identity, size and hash. No whole-file `arrayBuffer` or tee branch exists.
4. `resolve` reconstructs the session, selected inventory and ready object from R2 alone. It verifies the selected source bytes and the promoted original again under current authority. D1 is unnecessary for this intake reconstruction; it is still necessary to establish version commitment.

Byte object metadata is stable `application/octet-stream`; the user's exact declared MIME, filename, format and timestamps are preserved separately in `original`. The selected inventory at 128 chunks fits the metadata bound. Errors leave immutable evidence for retry or investigation. No automatic garbage collection or deletion is exposed.

Current authorization checks bind actor, owner/workspace, issuer, audience, namespace, grant identity/revision, current host lease deadline, actor/grant expiry and the immutable session expiry. They run at continuation boundaries and after durable stages before acknowledgment. A revoked stage may already have persisted evidence; that evidence is not an acknowledgment and never becomes a saved version by itself. Admission denial cancels an unread body. Stream cancellation propagates through the selected-original iterator to the active pinned read, including a stalled read.

## Self-reference-free package protocol

The `recovery-package-v1` core is written at a server-issued immutable candidate key `packages/<transactionId>`. This key is not the full-envelope content hash. Its proposed transaction uses a logical `packageObject` with `versionId: null` and omits its own later `packageBinding`.

The core contains the complete proposed transaction, all candidate manifests, full immediate committed-parent and permitted committed-source manifests, descriptors for their separately persisted manifests, and complete primary byte descriptors. It retains original content snapshots and source/lineage locators. Nonempty closure must come from the trusted host's committed storage and current source permissions; archived candidates do not prove commitment.

Once the core exists and is reread, `packageBinding` adds its inventory-purpose digest, size, media type and exact observed physical R2 identity to the final prepared payload. The trusted signer reconstructs the same core in read-only mode from independently resolved accepted input, current chain/heads, parents, sources and upload resolution. It checks exact archive content and authority before and after custody signs. It never signs arbitrary caller bytes or trusts a merely parsed context.

The immutable `preparations/<transactionId>` wrapper contains that signed payload, binding, and `commitStatus: unknown`. Preparation rereads and hash/compares the package and wrapper before returning. The wrapper cannot contain its own physical identity; a later signed inventory must bind its observed descriptor. Matching retained wrappers can reconcile lost responses; conflicting candidates are retained and rejected.

Existing meanings are unchanged:

- `SaveVersionResult.digest` hashes the selected manifest with the `manifest` purpose.
- Transaction-chain digest hashes the complete unsigned prepared payload with the `transaction` purpose.
- Preparation signature uses the separate `preparation` purpose over that unsigned payload, including `packageBinding`.
- A commit certificate uses the separate `commit` purpose and requires an exact matching durable D1 commit resolved under current background authority. Original client/grant provenance may have expired by then and remains preserved; it is not reused as background authority.

Historical unbound preparation schemas remain parseable where already supported, but the new signer and certificate paths require `bound-primary-v1` authority and a valid package binding. Unknown formats fail closed. No hash redefinition, synthetic production custody or permissive legacy-auth fallback is supplied.

## Host assembly obligations

The parsed `AuthenticatedRecoveryContext` is data, not proof. The existing canonical authentication host must implement the focused `UploadAuthority`, `RecoveryPreparationAuthority` and `RecoveryCommitAuthority` ports using current issuer/audience, operation/resource grants, owner/workspace mapping and server time. It owns accepted request snapshots and stable server IDs, independently resolves committed parents and current source permission, and keeps signing custody private. Read-only public-key verification establishes signature integrity only.

Task 4 must wire this capability through the existing shared operations, HTTP/MCP and background boundaries. It must check `findRequest(requestKey, trustedRequestDigest)` before stale-head checks or candidate preparation, while independently checking the current authorized workspace/epoch. Same request identity excludes server chain/time/IDs and includes resolved immutable upload meaning. No Task 3 HTTP routes, new issuer, host credentials, grants or production fallback are created.

Source authorities and custody implementations are real remaining local integration work. Provisioning any live keys/grants, provider access, deployment and independently controlled verification remain separate approval/acceptance gates. No local fixture establishes those gates.

## Verification and provider limits

`npm run verify` includes strict source and runtime-fixture typechecks, lint, unit tests, existing Worker/D1/R2/DO checks, recovery D1 checks, representative primary-runtime scenarios, and the build. `npm run test:primary` runs real local Workerd/R2 stream, sink/cancellation, upload/authority, D1 package tests plus an 8 MiB+17-byte multi-chunk reconstruction/download. Large boundaries are explicit:

```sh
CLOUDFLARE_CF_FETCH_ENABLED=false NPM_CONFIG_UPDATE_NOTIFIER=false node scripts/test-primary-runtime.mjs 'large?length=75497489' 'large?length=1073741824'
```

Fixtures disable Miniflare metadata fetch, use generated local signing keys only inside test adapters, and retain unique compiled bundles/results and synthetic R2 state. Each large case also rejects maximum+1 by metadata alone. Final evidence and hash correspondence are recorded outside the product source in the task report. Local wall time is not Worker CPU or production latency. Buffer sizes and admission counts are not measured total resident memory.

R2's adapter checks the upload identity observed at an immutable key; it cannot request arbitrary historical R2 upload versions. Out-of-band replacements are rejected when their identity differs. Same-version provider or transit corruption during the second verified-download stream remains possible; recipients needing end-to-end byte assurance must also check the final digest. The adapter exposes no overwrite, delete, arbitrary URL, credentials, or retention-administration operation. Live R2/B2, independent receipt/checkpoint custody, replication and restore are not established by these primary-only fixtures.
