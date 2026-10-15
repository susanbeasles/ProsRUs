-- compatibility: additive
-- Product command request ledger and decision audit. Additive only: no existing
-- table, trigger or row changes. Recovery history (0002-0004) stays the sole
-- committed record of every local-write: its recovery_request_results row is
-- written in the same D1 batch as the transaction, outbox job and domain rows.
-- One row per owner/workspace/request key across every registered command.
-- Pending rows retain the lifecycle root. A committed local-write row stores
-- only the recovery transaction id (its result is read from
-- recovery_request_results); only intake results, which have no recovery
-- transaction, are stored here. A committed row is never updated or deleted.
CREATE TABLE command_requests (
 owner TEXT NOT NULL CHECK(length(owner) BETWEEN 1 AND 100),
 workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 100),
 request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 100),
 operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 100),
 input_digest TEXT NOT NULL CHECK(length(input_digest)=64 AND input_digest NOT GLOB '*[^a-f0-9]*'),
 state TEXT NOT NULL CHECK(state IN ('pending','committed')),
 root TEXT CHECK(root IS NULL OR (json_valid(root) AND length(CAST(root AS BLOB))<=1900000)),
 root_revision INTEGER NOT NULL DEFAULT 0 CHECK(root_revision>=0),
 result TEXT CHECK(result IS NULL OR (json_valid(result) AND length(CAST(result AS BLOB))<=131072)),
 recovery_transaction_id TEXT CHECK(recovery_transaction_id IS NULL OR length(recovery_transaction_id) BETWEEN 1 AND 100),
 created_at INTEGER NOT NULL CHECK(created_at>=0),
 updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
 PRIMARY KEY(owner,workspace_id,request_key),
 CHECK(CASE state WHEN 'pending' THEN result IS NULL AND recovery_transaction_id IS NULL
  ELSE (result IS NULL)<>(recovery_transaction_id IS NULL) END),
 CHECK(state='pending' OR root IS NULL)
) WITHOUT ROWID;
-- A recovery-backed commit must name the exact committed recovery result for
-- the same owner/workspace/request key; the ledger cannot claim otherwise.
CREATE TRIGGER command_requests_recovery_result BEFORE UPDATE OF state ON command_requests
WHEN NEW.state='committed' AND NEW.recovery_transaction_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM recovery_request_results AS committed WHERE committed.owner=NEW.owner AND committed.workspace_id=NEW.workspace_id
  AND committed.request_key=NEW.request_key AND committed.transaction_id=NEW.recovery_transaction_id)
BEGIN SELECT RAISE(ABORT,'COMMAND_RECOVERY_RESULT_MISSING'); END;
-- Identity and meaning are fixed at insert; only pending rows may change.
CREATE TRIGGER command_requests_identity_immutable BEFORE UPDATE ON command_requests
WHEN NEW.owner IS NOT OLD.owner OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.request_key IS NOT OLD.request_key
 OR NEW.operation_id IS NOT OLD.operation_id OR NEW.input_digest IS NOT OLD.input_digest OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'COMMAND_REQUEST_IDENTITY_IMMUTABLE'); END;
CREATE TRIGGER command_requests_committed_immutable BEFORE UPDATE ON command_requests
WHEN OLD.state='committed'
BEGIN SELECT RAISE(ABORT,'COMMAND_REQUEST_COMMITTED'); END;
CREATE TRIGGER command_requests_root_monotonic BEFORE UPDATE ON command_requests
WHEN NEW.root_revision<OLD.root_revision
BEGIN SELECT RAISE(ABORT,'COMMAND_REQUEST_ROOT_REGRESSION'); END;
CREATE TRIGGER command_requests_immutable_delete BEFORE DELETE ON command_requests
BEGIN SELECT RAISE(ABORT,'COMMAND_REQUEST_IMMUTABLE'); END;
-- REPLACE would bypass delete triggers; reject any insert over an existing identity.
CREATE TRIGGER command_requests_immutable_replace BEFORE INSERT ON command_requests
WHEN EXISTS(SELECT 1 FROM command_requests AS prior WHERE prior.owner=NEW.owner AND prior.workspace_id=NEW.workspace_id AND prior.request_key=NEW.request_key)
BEGIN SELECT RAISE(ABORT,'COMMAND_REQUEST_IMMUTABLE'); END;

-- One append-only row per command decision. Identifiers and fixed reason codes
-- only: no request bodies, record content or owner contact addresses.
CREATE TABLE command_audit (
 owner TEXT NOT NULL CHECK(length(owner) BETWEEN 1 AND 100),
 workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 100),
 event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 100),
 invocation_id TEXT NOT NULL CHECK(length(invocation_id) BETWEEN 1 AND 100),
 operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 100),
 request_key TEXT CHECK(request_key IS NULL OR length(request_key) BETWEEN 1 AND 100),
 input_digest TEXT NOT NULL CHECK(length(input_digest)=64 AND input_digest NOT GLOB '*[^a-f0-9]*'),
 entrypoint TEXT NOT NULL CHECK(entrypoint IN ('owner','mcp')),
 principal_id TEXT NOT NULL CHECK(length(principal_id) BETWEEN 1 AND 256),
 grant_id TEXT NOT NULL CHECK(length(grant_id) BETWEEN 1 AND 256),
 grant_revision INTEGER NOT NULL CHECK(grant_revision>0),
 stage TEXT NOT NULL CHECK(stage IN ('read','before-durable','after-durable','before-ack','upload-start','upload-chunk','upload-complete','upload-resolve','prepare','sign-preparation','commit-primary')),
 decision TEXT NOT NULL CHECK(decision IN ('allow','replay','deny','conflict')),
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 80 AND reason NOT GLOB '*[^A-Za-z0-9_.-]*'),
 created_at INTEGER NOT NULL CHECK(created_at>=0),
 PRIMARY KEY(owner,workspace_id,event_id)
) WITHOUT ROWID;
CREATE INDEX command_audit_recent ON command_audit(owner,workspace_id,created_at);
CREATE TRIGGER command_audit_immutable_update BEFORE UPDATE ON command_audit
BEGIN SELECT RAISE(ABORT,'COMMAND_AUDIT_IMMUTABLE'); END;
CREATE TRIGGER command_audit_immutable_delete BEFORE DELETE ON command_audit
BEGIN SELECT RAISE(ABORT,'COMMAND_AUDIT_IMMUTABLE'); END;
CREATE TRIGGER command_audit_immutable_replace BEFORE INSERT ON command_audit
WHEN EXISTS(SELECT 1 FROM command_audit AS prior WHERE prior.owner=NEW.owner AND prior.workspace_id=NEW.workspace_id AND prior.event_id=NEW.event_id)
BEGIN SELECT RAISE(ABORT,'COMMAND_AUDIT_IMMUTABLE'); END;
