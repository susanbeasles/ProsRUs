-- Recovery history is distinct from mutable legacy recruiting projections.
-- No signed/protected historical versions can be fabricated by this migration.
CREATE TABLE recovery_workspaces (
 owner TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
 UNIQUE(owner,workspace_id)
);
CREATE TABLE recovery_chains (
 owner TEXT NOT NULL, workspace_id TEXT NOT NULL, epoch_id TEXT NOT NULL,
 sequence TEXT NOT NULL CHECK(length(sequence)<=100 AND (sequence='0' OR (sequence GLOB '[1-9]*' AND sequence NOT GLOB '*[^0-9]*'))),
 transaction_digest TEXT,
 PRIMARY KEY(owner,workspace_id),
 FOREIGN KEY(owner,workspace_id) REFERENCES recovery_workspaces(owner,workspace_id),
 CHECK(sequence='0' OR transaction_digest IS NOT NULL)
);
CREATE TABLE recovery_transactions (
 owner TEXT NOT NULL, workspace_id TEXT NOT NULL, transaction_id TEXT NOT NULL,
 epoch_id TEXT NOT NULL, sequence TEXT NOT NULL,
 expected_sequence TEXT NOT NULL CHECK(length(expected_sequence)<=100 AND (expected_sequence='0' OR (expected_sequence GLOB '[1-9]*' AND expected_sequence NOT GLOB '*[^0-9]*'))),
 previous_digest TEXT, transaction_digest TEXT NOT NULL CHECK(length(transaction_digest)=64 AND transaction_digest NOT GLOB '*[^a-f0-9]*'),
 schema_version INTEGER NOT NULL CHECK(schema_version=1),
 request_key TEXT NOT NULL, request_digest TEXT NOT NULL,
 prepared TEXT NOT NULL CHECK(json_valid(prepared)),
 PRIMARY KEY(owner,workspace_id,transaction_id),
 UNIQUE(owner,workspace_id,epoch_id,sequence),
 FOREIGN KEY(owner,workspace_id) REFERENCES recovery_chains(owner,workspace_id),
 CHECK(length(sequence)<=100 AND sequence=CASE WHEN rtrim(expected_sequence,'9')='' THEN '1'||replace(expected_sequence,'9','0') ELSE substr(expected_sequence,1,length(rtrim(expected_sequence,'9'))-1)||CAST((CAST(substr(rtrim(expected_sequence,'9'),-1) AS INTEGER)+1) AS TEXT)||replace(substr(expected_sequence,length(rtrim(expected_sequence,'9'))+1),'9','0') END)
);
CREATE TABLE recovery_lineages (
 owner TEXT NOT NULL, workspace_id TEXT NOT NULL, lineage_id TEXT NOT NULL,
 kind TEXT NOT NULL, entity_id TEXT NOT NULL,
 PRIMARY KEY(owner,workspace_id,lineage_id),
 UNIQUE(owner,workspace_id,kind,entity_id),
 FOREIGN KEY(owner,workspace_id) REFERENCES recovery_workspaces(owner,workspace_id)
);
CREATE TABLE recovery_versions (
 owner TEXT NOT NULL, workspace_id TEXT NOT NULL, version_id TEXT NOT NULL,
 lineage_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
 transaction_id TEXT NOT NULL, epoch_id TEXT NOT NULL,
 sequence TEXT NOT NULL CHECK(length(sequence)<=100 AND sequence GLOB '[1-9]*' AND sequence NOT GLOB '*[^0-9]*'),
 schema_version INTEGER NOT NULL CHECK(schema_version=1), manifest_digest TEXT NOT NULL,
 manifest TEXT NOT NULL CHECK(json_valid(manifest)),
 PRIMARY KEY(owner,workspace_id,version_id),
 UNIQUE(owner,workspace_id,transaction_id,lineage_id),
 FOREIGN KEY(owner,workspace_id,transaction_id) REFERENCES recovery_transactions(owner,workspace_id,transaction_id),
 FOREIGN KEY(owner,workspace_id,lineage_id) REFERENCES recovery_lineages(owner,workspace_id,lineage_id)
);
CREATE INDEX recovery_versions_lineage ON recovery_versions(owner,workspace_id,lineage_id);
CREATE TABLE recovery_heads (
 owner TEXT NOT NULL, workspace_id TEXT NOT NULL, lineage_id TEXT NOT NULL, version_id TEXT NOT NULL,
 PRIMARY KEY(owner,workspace_id,lineage_id,version_id),
 FOREIGN KEY(owner,workspace_id,version_id) REFERENCES recovery_versions(owner,workspace_id,version_id)
);
CREATE TABLE recovery_projections (
 owner TEXT NOT NULL, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
 lineage_id TEXT NOT NULL, version_id TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)),
 PRIMARY KEY(owner,workspace_id,kind,entity_id),
 FOREIGN KEY(owner,workspace_id,version_id) REFERENCES recovery_versions(owner,workspace_id,version_id)
);
CREATE TABLE recovery_events (
 owner TEXT NOT NULL, workspace_id TEXT NOT NULL, event_id TEXT NOT NULL,
 transaction_id TEXT NOT NULL, epoch_id TEXT NOT NULL, sequence TEXT NOT NULL,
 schema_version INTEGER NOT NULL CHECK(schema_version=1), kind TEXT NOT NULL,
 body TEXT NOT NULL CHECK(json_valid(body)), event TEXT NOT NULL CHECK(json_valid(event)),
 PRIMARY KEY(owner,workspace_id,event_id),
 FOREIGN KEY(owner,workspace_id,transaction_id) REFERENCES recovery_transactions(owner,workspace_id,transaction_id)
);
CREATE TABLE recovery_request_results (
 owner TEXT NOT NULL, workspace_id TEXT NOT NULL, request_key TEXT NOT NULL,
 schema_version INTEGER NOT NULL CHECK(schema_version=1), request_digest TEXT NOT NULL,
 transaction_id TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)),
 PRIMARY KEY(owner,workspace_id,request_key),
 FOREIGN KEY(owner,workspace_id,transaction_id) REFERENCES recovery_transactions(owner,workspace_id,transaction_id)
);
CREATE TABLE recovery_audit (
 owner TEXT NOT NULL, workspace_id TEXT NOT NULL, event_id TEXT NOT NULL,
 schema_version INTEGER NOT NULL CHECK(schema_version=1), event TEXT NOT NULL CHECK(json_valid(event)),
 PRIMARY KEY(owner,workspace_id,event_id),
 FOREIGN KEY(owner,workspace_id) REFERENCES recovery_workspaces(owner,workspace_id)
);
CREATE TABLE recovery_outbox (
 owner TEXT NOT NULL, workspace_id TEXT NOT NULL, job_id TEXT NOT NULL, transaction_id TEXT NOT NULL,
 stage TEXT NOT NULL DEFAULT 'primary_journal' CHECK(stage IN ('primary_journal','replicate','verify','receipt','complete')),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','completed','retryable','dead_letter','quarantined')),
 fence TEXT NOT NULL DEFAULT '0' CHECK(length(fence)<=100 AND (fence='0' OR (fence GLOB '[1-9]*' AND fence NOT GLOB '*[^0-9]*'))),
 lease_owner TEXT, lease_expires_at INTEGER, attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt>=0),
 next_attempt_at INTEGER NOT NULL, created_at INTEGER NOT NULL, error_category TEXT,
 PRIMARY KEY(owner,workspace_id,job_id), UNIQUE(owner,workspace_id,transaction_id),
 FOREIGN KEY(owner,workspace_id,transaction_id) REFERENCES recovery_transactions(owner,workspace_id,transaction_id)
);
CREATE INDEX recovery_due_jobs ON recovery_outbox(owner,workspace_id,state,next_attempt_at,job_id);
CREATE TABLE recovery_job_history (
 owner TEXT NOT NULL, workspace_id TEXT NOT NULL, event_id TEXT NOT NULL,
 job_id TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version=1), result TEXT NOT NULL CHECK(json_valid(result)),
 PRIMARY KEY(owner,workspace_id,event_id),
 FOREIGN KEY(owner,workspace_id,job_id) REFERENCES recovery_outbox(owner,workspace_id,job_id)
);
CREATE TABLE recovery_protection_receipts (
 owner TEXT NOT NULL, workspace_id TEXT NOT NULL, receipt_digest TEXT NOT NULL,
 transaction_id TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version=1), receipt TEXT NOT NULL CHECK(json_valid(receipt)),
 PRIMARY KEY(owner,workspace_id,receipt_digest),
 FOREIGN KEY(owner,workspace_id,transaction_id) REFERENCES recovery_transactions(owner,workspace_id,transaction_id)
);
CREATE TABLE recovery_protection (
 owner TEXT NOT NULL, workspace_id TEXT NOT NULL, version_id TEXT NOT NULL,
 view TEXT NOT NULL CHECK(json_valid(view)), receipt_digest TEXT,
 PRIMARY KEY(owner,workspace_id,version_id),
 FOREIGN KEY(owner,workspace_id,version_id) REFERENCES recovery_versions(owner,workspace_id,version_id),
 FOREIGN KEY(owner,workspace_id,receipt_digest) REFERENCES recovery_protection_receipts(owner,workspace_id,receipt_digest)
);
CREATE TABLE recovery_import_baselines (
 owner TEXT NOT NULL, source_table TEXT NOT NULL, source_kind TEXT NOT NULL,
 source_id TEXT NOT NULL, source_revision TEXT, source_snapshot TEXT NOT NULL CHECK(json_valid(source_snapshot)),
 provenance TEXT NOT NULL CHECK(provenance='imported_legacy_baseline'),
 artifact_availability TEXT NOT NULL CHECK(artifact_availability IN ('not_applicable','unobserved','missing','observed')),
 archive_state TEXT NOT NULL CHECK(archive_state='pending'),
 schema_version INTEGER NOT NULL CHECK(schema_version=1),
 PRIMARY KEY(owner,source_table,source_kind,source_id)
);
INSERT INTO recovery_import_baselines
 SELECT owner,'records',kind,id,CAST(revision AS TEXT),json_object('body',json(body),'revision',CAST(revision AS TEXT),'updatedAt',updated_at),
 'imported_legacy_baseline',CASE WHEN kind IN ('artifact','packet') THEN 'unobserved' ELSE 'not_applicable' END,'pending',1 FROM records;
INSERT INTO recovery_import_baselines
 SELECT owner,'source_keys','source',source_key,NULL,json_object('sourceKey',source_key,'opportunityId',opportunity_id),
 'imported_legacy_baseline','not_applicable','pending',1 FROM source_keys;
INSERT INTO recovery_import_baselines
 SELECT owner,'intents','action_intent',id,NULL,json_object('kind',kind,'digest',digest,'payload',json(payload),'state',state,'receipt',receipt,'failure',failure,'attempts',attempts,'createdAt',created_at,'updatedAt',updated_at),
 'imported_legacy_baseline','not_applicable','pending',1 FROM intents;
INSERT INTO recovery_import_baselines
 SELECT owner,'audit','audit',id,NULL,json_object('actor',actor,'operation',operation,'objectId',object_id,'decision',decision,'createdAt',created_at),
 'imported_legacy_baseline','not_applicable','pending',1 FROM audit;

-- A failed predicate is an actual SQL error, never a successful zero-row UPDATE.
CREATE TRIGGER recovery_commit_guard BEFORE INSERT ON recovery_transactions
BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM recovery_workspaces WHERE owner=NEW.owner AND workspace_id=NEW.workspace_id)
 THEN RAISE(ABORT,'RECOVERY_WORKSPACE_MISMATCH') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM recovery_chains WHERE owner=NEW.owner AND workspace_id=NEW.workspace_id AND epoch_id=NEW.epoch_id AND sequence=NEW.expected_sequence AND transaction_digest IS NEW.previous_digest)
 THEN RAISE(ABORT,'RECOVERY_CHAIN_CONFLICT') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM json_each(NEW.prepared,'$.versions') AS candidate
  JOIN recovery_lineages AS lineage ON lineage.owner=NEW.owner AND lineage.workspace_id=NEW.workspace_id
  WHERE (lineage.lineage_id=json_extract(candidate.value,'$.lineageId') AND (lineage.entity_id<>json_extract(candidate.value,'$.entityId') OR lineage.kind<>json_extract(candidate.value,'$.kind')))
     OR (lineage.entity_id=json_extract(candidate.value,'$.entityId') AND lineage.kind=json_extract(candidate.value,'$.kind') AND lineage.lineage_id<>json_extract(candidate.value,'$.lineageId'))
 ) THEN RAISE(ABORT,'RECOVERY_ENTITY_CONFLICT') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM json_each(NEW.prepared,'$.versions') AS candidate, json_each(candidate.value,'$.parentVersionIds') AS parent
  WHERE NOT EXISTS(SELECT 1 FROM recovery_versions AS version WHERE version.owner=NEW.owner AND version.workspace_id=NEW.workspace_id AND version.version_id=parent.value AND version.lineage_id=json_extract(candidate.value,'$.lineageId') AND version.kind=json_extract(candidate.value,'$.kind') AND version.entity_id=json_extract(candidate.value,'$.entityId'))
 ) THEN RAISE(ABORT,'RECOVERY_PARENT_CONFLICT') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM json_each(NEW.prepared,'$.expectedHeads') AS expected WHERE json_extract(expected.value,'$.branchRequested')=0 AND (
   (SELECT count(*) FROM recovery_heads WHERE owner=NEW.owner AND workspace_id=NEW.workspace_id AND lineage_id=json_extract(expected.value,'$.lineageId'))<>json_array_length(expected.value,'$.parentVersionIds')
   OR EXISTS(SELECT 1 FROM recovery_heads AS head WHERE head.owner=NEW.owner AND head.workspace_id=NEW.workspace_id AND head.lineage_id=json_extract(expected.value,'$.lineageId') AND NOT EXISTS(SELECT 1 FROM json_each(expected.value,'$.parentVersionIds') AS parent WHERE parent.value=head.version_id))
  )
 ) THEN RAISE(ABORT,'RECOVERY_HEAD_CONFLICT') END;
END;
CREATE TRIGGER recovery_advance_chain AFTER INSERT ON recovery_transactions
BEGIN
 UPDATE recovery_chains SET sequence=NEW.sequence,transaction_digest=NEW.transaction_digest
 WHERE owner=NEW.owner AND workspace_id=NEW.workspace_id AND epoch_id=NEW.epoch_id AND sequence=NEW.expected_sequence AND transaction_digest IS NEW.previous_digest;
 SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'RECOVERY_CHAIN_CONFLICT') END;
END;
-- Protection evidence may arrive out of order even under the current lease.
-- Abort at the sink so receipt/history/audit writes in the same batch roll back.
CREATE TRIGGER recovery_protection_monotonic BEFORE UPDATE OF view ON recovery_protection
WHEN json_extract(OLD.view,'$.lastCheckedAt') IS NOT NULL AND (
 json_extract(NEW.view,'$.lastCheckedAt') IS NULL OR
 json_extract(NEW.view,'$.lastCheckedAt')<json_extract(OLD.view,'$.lastCheckedAt')
)
BEGIN SELECT RAISE(ABORT,'RECOVERY_PROTECTION_REGRESSION'); END;
CREATE TRIGGER recovery_workspace_immutable_update BEFORE UPDATE ON recovery_workspaces BEGIN SELECT RAISE(ABORT,'RECOVERY_WORKSPACE_IMMUTABLE'); END;
CREATE TRIGGER recovery_workspace_immutable_delete BEFORE DELETE ON recovery_workspaces BEGIN SELECT RAISE(ABORT,'RECOVERY_WORKSPACE_IMMUTABLE'); END;
CREATE TRIGGER recovery_transactions_immutable_update BEFORE UPDATE ON recovery_transactions BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_transactions_immutable_delete BEFORE DELETE ON recovery_transactions BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_lineages_immutable_update BEFORE UPDATE ON recovery_lineages BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_lineages_immutable_delete BEFORE DELETE ON recovery_lineages BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_versions_immutable_update BEFORE UPDATE ON recovery_versions BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_versions_immutable_delete BEFORE DELETE ON recovery_versions BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_events_immutable_update BEFORE UPDATE ON recovery_events BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_events_immutable_delete BEFORE DELETE ON recovery_events BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_request_results_immutable_update BEFORE UPDATE ON recovery_request_results BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_request_results_immutable_delete BEFORE DELETE ON recovery_request_results BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_audit_immutable_update BEFORE UPDATE ON recovery_audit BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_audit_immutable_delete BEFORE DELETE ON recovery_audit BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_job_history_immutable_update BEFORE UPDATE ON recovery_job_history BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_job_history_immutable_delete BEFORE DELETE ON recovery_job_history BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_protection_receipts_immutable_update BEFORE UPDATE ON recovery_protection_receipts BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_protection_receipts_immutable_delete BEFORE DELETE ON recovery_protection_receipts BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_import_baselines_immutable_update BEFORE UPDATE ON recovery_import_baselines BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_import_baselines_immutable_delete BEFORE DELETE ON recovery_import_baselines BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;

-- REPLACE can bypass delete triggers when recursive_triggers is disabled.
-- Reject every replacement-conflicting identity, including SQLite rowid aliases.
-- Keep rowid storage/pagination; ordinary inserts allocate an unused ordinal.
CREATE TRIGGER recovery_workspaces_immutable_replace BEFORE INSERT ON recovery_workspaces WHEN EXISTS(SELECT 1 FROM recovery_workspaces AS prior WHERE prior.rowid=NEW.rowid OR (prior.owner=NEW.owner)) BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_transactions_immutable_replace BEFORE INSERT ON recovery_transactions WHEN EXISTS(SELECT 1 FROM recovery_transactions AS prior WHERE prior.rowid=NEW.rowid OR (prior.owner=NEW.owner AND prior.workspace_id=NEW.workspace_id AND (prior.transaction_id=NEW.transaction_id OR (prior.epoch_id=NEW.epoch_id AND prior.sequence=NEW.sequence)))) BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_lineages_immutable_replace BEFORE INSERT ON recovery_lineages WHEN EXISTS(SELECT 1 FROM recovery_lineages AS prior WHERE prior.rowid=NEW.rowid OR (prior.owner=NEW.owner AND prior.workspace_id=NEW.workspace_id AND (prior.lineage_id=NEW.lineage_id OR (prior.kind=NEW.kind AND prior.entity_id=NEW.entity_id)))) BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_versions_immutable_replace BEFORE INSERT ON recovery_versions WHEN EXISTS(SELECT 1 FROM recovery_versions AS prior WHERE prior.rowid=NEW.rowid OR (prior.owner=NEW.owner AND prior.workspace_id=NEW.workspace_id AND (prior.version_id=NEW.version_id OR (prior.transaction_id=NEW.transaction_id AND prior.lineage_id=NEW.lineage_id)))) BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_events_immutable_replace BEFORE INSERT ON recovery_events WHEN EXISTS(SELECT 1 FROM recovery_events AS prior WHERE prior.rowid=NEW.rowid OR (prior.owner=NEW.owner AND prior.workspace_id=NEW.workspace_id AND prior.event_id=NEW.event_id)) BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_request_results_immutable_replace BEFORE INSERT ON recovery_request_results WHEN EXISTS(SELECT 1 FROM recovery_request_results AS prior WHERE prior.rowid=NEW.rowid OR (prior.owner=NEW.owner AND prior.workspace_id=NEW.workspace_id AND prior.request_key=NEW.request_key)) BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_audit_immutable_replace BEFORE INSERT ON recovery_audit WHEN EXISTS(SELECT 1 FROM recovery_audit AS prior WHERE prior.rowid=NEW.rowid OR (prior.owner=NEW.owner AND prior.workspace_id=NEW.workspace_id AND prior.event_id=NEW.event_id)) BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_job_history_immutable_replace BEFORE INSERT ON recovery_job_history WHEN EXISTS(SELECT 1 FROM recovery_job_history AS prior WHERE prior.rowid=NEW.rowid OR (prior.owner=NEW.owner AND prior.workspace_id=NEW.workspace_id AND prior.event_id=NEW.event_id)) BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_protection_receipts_immutable_replace BEFORE INSERT ON recovery_protection_receipts WHEN EXISTS(SELECT 1 FROM recovery_protection_receipts AS prior WHERE prior.rowid=NEW.rowid OR (prior.owner=NEW.owner AND prior.workspace_id=NEW.workspace_id AND prior.receipt_digest=NEW.receipt_digest)) BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_import_baselines_immutable_replace BEFORE INSERT ON recovery_import_baselines WHEN EXISTS(SELECT 1 FROM recovery_import_baselines AS prior WHERE prior.rowid=NEW.rowid OR (prior.owner=NEW.owner AND prior.source_table=NEW.source_table AND prior.source_kind=NEW.source_kind AND prior.source_id=NEW.source_id)) BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;

-- BEFORE INSERT sees -1 for an unallocated implicit rowid. Check the final
-- allocated ordinal afterward so a stored -1 cannot poison future normal writes.
-- This prevents new invalid rows; retained malformed history needs reviewed,
-- non-destructive quarantine, not deletion or physical rowid replay on restore.
CREATE TRIGGER recovery_workspaces_positive_ordinal AFTER INSERT ON recovery_workspaces WHEN NEW.rowid<=0 BEGIN SELECT RAISE(ABORT,'RECOVERY_INVALID_ORDINAL'); END;
CREATE TRIGGER recovery_transactions_positive_ordinal AFTER INSERT ON recovery_transactions WHEN NEW.rowid<=0 BEGIN SELECT RAISE(ABORT,'RECOVERY_INVALID_ORDINAL'); END;
CREATE TRIGGER recovery_lineages_positive_ordinal AFTER INSERT ON recovery_lineages WHEN NEW.rowid<=0 BEGIN SELECT RAISE(ABORT,'RECOVERY_INVALID_ORDINAL'); END;
CREATE TRIGGER recovery_versions_positive_ordinal AFTER INSERT ON recovery_versions WHEN NEW.rowid<=0 BEGIN SELECT RAISE(ABORT,'RECOVERY_INVALID_ORDINAL'); END;
CREATE TRIGGER recovery_events_positive_ordinal AFTER INSERT ON recovery_events WHEN NEW.rowid<=0 BEGIN SELECT RAISE(ABORT,'RECOVERY_INVALID_ORDINAL'); END;
CREATE TRIGGER recovery_request_results_positive_ordinal AFTER INSERT ON recovery_request_results WHEN NEW.rowid<=0 BEGIN SELECT RAISE(ABORT,'RECOVERY_INVALID_ORDINAL'); END;
CREATE TRIGGER recovery_audit_positive_ordinal AFTER INSERT ON recovery_audit WHEN NEW.rowid<=0 BEGIN SELECT RAISE(ABORT,'RECOVERY_INVALID_ORDINAL'); END;
CREATE TRIGGER recovery_job_history_positive_ordinal AFTER INSERT ON recovery_job_history WHEN NEW.rowid<=0 BEGIN SELECT RAISE(ABORT,'RECOVERY_INVALID_ORDINAL'); END;
CREATE TRIGGER recovery_protection_receipts_positive_ordinal AFTER INSERT ON recovery_protection_receipts WHEN NEW.rowid<=0 BEGIN SELECT RAISE(ABORT,'RECOVERY_INVALID_ORDINAL'); END;
CREATE TRIGGER recovery_import_baselines_positive_ordinal AFTER INSERT ON recovery_import_baselines WHEN NEW.rowid<=0 BEGIN SELECT RAISE(ABORT,'RECOVERY_INVALID_ORDINAL'); END;
