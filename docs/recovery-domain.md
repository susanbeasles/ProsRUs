# Signed domain packages: version 1 handoff

## Owned API and authority

`parseDomainPlan` is the closed, detached semantic boundary for `domain-plan-v1`.
`AcceptedPreparation.domainPlan` optionally carries that plan, candidate role/version
assignments, and exact expected heads for every candidate. The existing
`buildPrimaryPackage` implements both persistence and read-only reconstruction;
there is no alternative domain signer. `PreparedEnvelopePayload.domainEffects`
optionally contains `domain-effects-v1`, the complete plan, its digest and exact
candidate assignment. Historical omission stays omission. Public `SaveVersionInput`
has no domain plan field. Generic archived snapshots cannot activate business rows.

A plan is data, not authority. The trusted host must independently derive and
resolve it through `PreparationAuthority`; the signer reconstructs all content
before custody signs. The store is an internal sink after signature verification.
Its additional `validateDomainEffects` enforces candidate/effect/body/artifact,
request, workspace, actor and result consistency. Calling this validator directly
does not authenticate anyone. No ambient user, invocation correlation value or
producer-provided digest grants acceptance.

The plan identifies the registered operation, exact input digest, planner version
and source digest, workspace/actor, stable request root/key, full guarded readset,
candidates, record mutations, source-key effects, mandatory legacy audits and
primary result record. Stable plan/request digests exclude attempt version IDs and
workspace chain allocation; they retain the complete accepted business meaning.
All original generic request/package addressing remains unchanged.

`domain_record` snapshots have formatVersion 1, kind/entity/revision/business
updatedAt and the full strict typed body. Mapping is exact: thread → conversation,
prep → prep_brief, attempt → external_receipt; other permitted kinds map directly.
Offer, question and reminder are added archival vocabulary, not new capabilities.
Connection/session bodies and unknown fields are forbidden. Operational packets
are immutable. Record business strings are preserved, never silently trimmed.
Stored opportunity/prep URL validators are non-transforming inside every enclosing
schema: boundary whitespace and embedded tab/newline spellings that Zod would
rewrite are rejected before acceptance/package or prepared-effects parsing. Public
operation input and canonical source-key normalization remain separate.

## Bounds and complete artifact closure

Maximums are 32 candidates, 128 committed references, 128 guarded rows, 16 selected
collections and 128 audit/source-key entries. The complete accepted composite has
a 512 KiB cap and canonical metadata retains its 128 KiB cap. Per-field maxima do
not override aggregate limits. Oversize input fails without truncation or widened
binary buffering.

Every candidate has one lineage and explicit heads. The package contains all full
candidate manifests plus the complete independently resolved, recursively reachable
committed parent/source closure. Missing/surplus/duplicate/cyclic closure denies.
A candidate version cannot support another candidate as a supposedly committed
source. The self-reference-free package binding remains bound-primary-v1 over a
recovery-package-v1 core. Snapshot bytes are canonical JSON; additional artifacts
are explicit UTF-8 bytes, exact guarded legacy serialization, committed immutable
artifacts or scoped upload handles. Reads verify digest/length before use.

## Baseline and malformed data

`baseline-archive-v1` is a separate archival-only transaction: exact read guards,
zero operational mutations/source-key effects/legacy audits, unverified approval
with no active evidence. Snapshot old revision/time/content remain inert; manifest
createdAt is the observed preparation time. `legacy-observation-v1` recipe parameters
bind original-artifact availability/locator and inert approval provenance. Raw
`records.body` serialization is an additional artifact, distinct from canonical
parsed snapshot bytes, preserving whitespace, ordering and escapes.

Only an incomplete legacy claim composed entirely of the strict known safe claim
fields can use `legacy_record_quarantine` / `incomplete_legacy_claim`, with mandatory
raw-body evidence. This does not authorize arbitrary malformed rows or secret
fields. Unsupported malformed records remain blocked and retained unchanged;
callers must report that gap rather than inventing a normalized snapshot or
silently excluding the row from a complete predicate. A missing status on a
profile-conflict question counts as unresolved for SQL membership conflict checks,
even when its unsupported body prevents producing a valid accepted plan.

### Exact original-file correspondence

An observed original requires observation.original with artifactRole, digest,
sizeBytes and mediaType. artifactRole selects exactly one artifact belonging to
that candidate; the actual signed descriptor must match all three byte identity
fields. The locator must be the observed artifact body's key or packet body's
artifactKey. Snapshot/raw-row JSON and UTF-8 generated text cannot fill this role.
Only an existing verified upload or committed full-file capture is supported.
Committed captures must have the existing exact_bytes/exact_original snapshot,
one matching full-file artifact at index0, and consistent size metadata;
structured snapshot archives cannot masquerade as captures. Complete bytes are
verified/read back by the shared builder and independently reconstructed signer.
The D1 sink rechecks candidate-local provenance, immutable committed source and
exact descriptor correspondence, even when an adversary recomputes plan hashes.
It never treats a label or digest alone as preservation evidence.

For a record with a direct original locator, missing keeps that exact locator,
without an original reference or claim of preserved file bytes. not_applicable has
a null locator and is reserved for records with no direct file locator. Unsupported
or inaccessible original sources cannot be automatically relabeled observed or
not_applicable. A valid missing baseline may still preserve its metadata honestly.
Content equality does not determine provenance: a separately captured full file
may legitimately have the same bytes as a metadata representation. The primitive
requires the explicit capture source and exact candidate-local locator/reference,
not hash inequality. Transport artifact media (normally application/octet-stream)
is distinct from preserved original filename/format/media metadata. It does not
fetch locators or infer a legacy filename/content association from provider state.

Task4D's independently authorized resolver must select the original source, verify
its exact association with the observed locator and supply the explicit role and
expected descriptor. Existing committed/upload readers perform byte verification.
Other old-file source shapes remain unsupported until a separately approved
resolver exists. This correction is prerelease: initial failed-review domain
observations are retained as evidence, not accepted as valid new provenance.
Historical generic envelopes without domainEffects keep their original hashes.

## Atomic durability, retries and audit

Migration 0003 is additive. The one existing `RecoveryStore.commitPrepared` D1 batch
now includes domain records/source_keys/legacy audit and commit observation alongside
history, chain, heads, projections, request result, recovery audit and durable outbox.
There is no post-commit legacy Store call. The transaction insert trigger raises
SQL ABORT for changed/absent raw body, revision/time, source-only rows, exact source
keys or complete selected collection membership. Existing append-only and chain
triggers stay intact. Generated SQL uses only finite trusted operations.

Retained exact request lookup happens before stale mutable readset validation. An
ambiguous successful batch reconciles its exact result; wrong digest/identity fails.
Mandatory audit failures roll back the mutation. Durable audit rows are evidence,
not diagnostic logging. Queue delivery and replica protection remain separate
outbox consumers; no additional logger, telemetry backend or release pipeline is
introduced. Runtime rollback tests snapshot every legacy/recovery table and chain.

## Trusted commit read port

`RecoveryStore.readCommitted({workspace, transactionId})` returns null when absent,
or exact stored `{prepared, result, observation}` after owner/workspace and digest
checks. A historical transaction without an observation returns observation:null;
no historical now is invented. Task4I must expose the reviewed private read ports
using this primitive and fresh context/reauthorization.

The immutable observation contains:

- kind `atomic_batch_statement`
- clock `d1-unixepoch-subsec-v1`, precisionMs 1
- observedAt in Unix milliseconds
- exact preparationDigest, transactionDigest and resultDigest

SQL supplies `CAST(ROUND(unixepoch('subsec')*1000) AS INTEGER)` within the successful
atomic batch. The insert trigger requires the same SQL-step clock, exact transaction
and result identity, no completed prior request result and prepared.createdAt no
later than the observation. Readback recomputes both payload digests, compares the
stored result and checks observedAt against a fresh DB clock. Update, delete,
replace and later retroactive insertion are denied. The store never accepts caller
time. Physical commit can occur later: this is a trusted statement observation,
not an exact physical commit timestamp or a statement of clock accuracy.

The actual local D1 runtime supports SQLite's subsecond millisecond result. A
same-second nonzero-millisecond prepare/commit test uses real D1 and the production
package/signer with a labeled memory archive seam to avoid unrelated Node/R2 proxy
latency. All companion and archival closure cases use real R2 and D1. See
[SQLite date/time subsec semantics](https://sqlite.org/lang_datefunc.html) and
[D1 batch transaction semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

## Shared projection and next owners

Run `node scripts/generate-recovery-schemas.mjs`, then
`node scripts/generate-shared-types.mjs`. The former derives only the recovery
schema slot from product Zod definitions and appends the three approved archival
kinds. It records exact source hashes. It drops only redundant unconstrained
`propertyNames:{type:"string"}` because JSON object keys are already strings, and
rejects any constrained propertyNames rule. Zod semantic refinements remain in the
single product semantic parser; the shared projection is structural validation,
not an independent authorization engine. The second generator emits consumer
Typescript declarations from that module. Both `--check` commands are part of
`npm run verify`; generated module/declarations are not hand-edited.

The reviewed initial import and preserved pre-change golden corpus are separate
from these generated bytes. After independent review, the coordinator synchronizes
exact shared bytes to the isolated Control consumer. Task4D owns deterministic
operation planners, baseline selection/request-root lifecycle and atomic companion
plans. Task4I owns shared-auth/private RPC/Coordinator integration and commit/result
consumers. Neither public operation wiring nor live custody/provisioning/deployment
is claimed by these primitives.
