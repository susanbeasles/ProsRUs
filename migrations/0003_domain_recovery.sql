-- Additive finite domain guards. Existing 0002 history and CAS remain unchanged.
-- All predicates execute before the transaction insert, in its single D1 batch.
CREATE TRIGGER recovery_domain_guard BEFORE INSERT ON recovery_transactions
WHEN json_type(NEW.prepared,'$.domainEffects') IS NOT NULL
BEGIN
 SELECT CASE WHEN json_extract(NEW.prepared,'$.domainEffects.format')<>'domain-effects-v1'
  OR json_extract(NEW.prepared,'$.domainEffects.plan.format')<>'domain-plan-v1'
  OR json_extract(NEW.prepared,'$.domainEffects.plan.workspace.ownerId')<>NEW.owner
  OR json_extract(NEW.prepared,'$.domainEffects.plan.workspace.workspaceId')<>NEW.workspace_id
 THEN RAISE(ABORT,'RECOVERY_DOMAIN_CONFLICT') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM json_each(NEW.prepared,'$.domainEffects.plan.readSet.records') AS expected
  WHERE (json_extract(expected.value,'$.state')='absent' AND EXISTS(
   SELECT 1 FROM records AS record WHERE record.owner=NEW.owner AND record.kind=json_extract(expected.value,'$.recordKind') AND record.id=json_extract(expected.value,'$.entityId')))
  OR (json_extract(expected.value,'$.state')='present' AND NOT EXISTS(
   SELECT 1 FROM records AS record WHERE record.owner=NEW.owner AND record.kind=json_extract(expected.value,'$.recordKind') AND record.id=json_extract(expected.value,'$.entityId')
   AND record.body=json_extract(expected.value,'$.rawBody') COLLATE BINARY
   AND record.revision=json_extract(expected.value,'$.revision') AND record.updated_at=json_extract(expected.value,'$.updatedAt')))
 ) THEN RAISE(ABORT,'RECOVERY_DOMAIN_CONFLICT') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM json_each(NEW.prepared,'$.domainEffects.plan.readSet.sourceKeys') AS expected
  WHERE (json_type(expected.value,'$.opportunityId')='null' AND EXISTS(SELECT 1 FROM source_keys AS source WHERE source.owner=NEW.owner AND source.source_key=json_extract(expected.value,'$.sourceKey')))
  OR (json_type(expected.value,'$.opportunityId')='text' AND NOT EXISTS(SELECT 1 FROM source_keys AS source WHERE source.owner=NEW.owner AND source.source_key=json_extract(expected.value,'$.sourceKey') AND source.opportunity_id=json_extract(expected.value,'$.opportunityId')))
 ) THEN RAISE(ABORT,'RECOVERY_DOMAIN_CONFLICT') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM json_each(NEW.prepared,'$.domainEffects.plan.readSet.collections') AS collection
  WHERE (SELECT count(*) FROM records AS record WHERE record.owner=NEW.owner AND (
   (json_extract(collection.value,'$.kind')='all_claims' AND record.kind='claim')
   OR (json_extract(collection.value,'$.kind')='all_artifacts' AND record.kind='artifact')
   OR (json_extract(collection.value,'$.kind')='unresolved_profile_conflicts' AND record.kind='question' AND json_extract(record.body,'$.type')='profile_conflict' AND json_extract(record.body,'$.status') IS NOT 'resolved')
   OR (json_extract(collection.value,'$.kind')='interview_reminders' AND record.kind='reminder' AND json_extract(record.body,'$.interviewId')=json_extract(collection.value,'$.interviewId'))
  ))<>json_array_length(collection.value,'$.memberIds')
  OR EXISTS(SELECT 1 FROM records AS record WHERE record.owner=NEW.owner AND (
   (json_extract(collection.value,'$.kind')='all_claims' AND record.kind='claim')
   OR (json_extract(collection.value,'$.kind')='all_artifacts' AND record.kind='artifact')
   OR (json_extract(collection.value,'$.kind')='unresolved_profile_conflicts' AND record.kind='question' AND json_extract(record.body,'$.type')='profile_conflict' AND json_extract(record.body,'$.status') IS NOT 'resolved')
   OR (json_extract(collection.value,'$.kind')='interview_reminders' AND record.kind='reminder' AND json_extract(record.body,'$.interviewId')=json_extract(collection.value,'$.interviewId'))
  ) AND NOT EXISTS(SELECT 1 FROM json_each(collection.value,'$.memberIds') AS member WHERE member.value=record.id))
 ) THEN RAISE(ABORT,'RECOVERY_DOMAIN_CONFLICT') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM json_each(NEW.prepared,'$.sourceDescriptors') AS source WHERE NOT EXISTS(
   SELECT 1 FROM recovery_versions AS version WHERE version.owner=NEW.owner AND version.workspace_id=NEW.workspace_id
   AND version.version_id=json_extract(source.value,'$.versionId') AND version.manifest_digest=json_extract(source.value,'$.manifestDigest')
   AND version.epoch_id=json_extract(source.value,'$.epochId') AND version.lineage_id=json_extract(source.value,'$.lineageId')
  )
 ) THEN RAISE(ABORT,'RECOVERY_DOMAIN_SOURCE_CONFLICT') END;
END;

-- This is an in-transaction statement-time observation, available only when the
-- containing batch commits. It is not the unobservable physical commit instant.
-- unixepoch('subsec') is supported by the tested D1 runtime; precision is 1 ms.
CREATE TABLE recovery_commit_observations (
 owner TEXT NOT NULL,workspace_id TEXT NOT NULL,transaction_id TEXT NOT NULL,
 observed_at_ms INTEGER NOT NULL DEFAULT (CAST(ROUND(unixepoch('subsec')*1000) AS INTEGER)),
 clock TEXT NOT NULL CHECK(clock='d1-unixepoch-subsec-v1'),
 precision_ms INTEGER NOT NULL CHECK(precision_ms=1),
 preparation_digest TEXT NOT NULL CHECK(length(preparation_digest)=64 AND preparation_digest NOT GLOB '*[^a-f0-9]*'),
 transaction_digest TEXT NOT NULL CHECK(length(transaction_digest)=64 AND transaction_digest NOT GLOB '*[^a-f0-9]*'),
 result_digest TEXT NOT NULL CHECK(length(result_digest)=64 AND result_digest NOT GLOB '*[^a-f0-9]*'),
 PRIMARY KEY(owner,workspace_id,transaction_id),
 FOREIGN KEY(owner,workspace_id,transaction_id) REFERENCES recovery_transactions(owner,workspace_id,transaction_id),
 CHECK(observed_at_ms>=0 AND observed_at_ms<=9007199254740991)
) WITHOUT ROWID;
CREATE TRIGGER recovery_commit_observation_guard BEFORE INSERT ON recovery_commit_observations
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM recovery_commit_observations WHERE owner=NEW.owner AND workspace_id=NEW.workspace_id AND transaction_id=NEW.transaction_id)
 THEN RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE') END;
 SELECT CASE WHEN NEW.observed_at_ms<>CAST(ROUND(unixepoch('subsec')*1000) AS INTEGER)
 OR NOT EXISTS(SELECT 1 FROM recovery_transactions AS transaction_record
  WHERE transaction_record.owner=NEW.owner AND transaction_record.workspace_id=NEW.workspace_id AND transaction_record.transaction_id=NEW.transaction_id
   AND transaction_record.transaction_digest=NEW.transaction_digest
   AND json_extract(transaction_record.prepared,'$.createdAt')<=NEW.observed_at_ms
   AND json_extract(transaction_record.prepared,'$.result.digest')=NEW.result_digest)
 OR EXISTS(SELECT 1 FROM recovery_request_results WHERE owner=NEW.owner AND workspace_id=NEW.workspace_id AND transaction_id=NEW.transaction_id)
 THEN RAISE(ABORT,'RECOVERY_COMMIT_OBSERVATION_CONFLICT') END;
END;
CREATE TRIGGER recovery_commit_observation_update BEFORE UPDATE ON recovery_commit_observations BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_commit_observation_delete BEFORE DELETE ON recovery_commit_observations BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
