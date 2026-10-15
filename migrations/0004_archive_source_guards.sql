-- Optional signed archive-only original dependencies. Generic saves remain inert.
-- Source identity/current head/projection/legacy absence are checked in the same
-- recovery transaction INSERT step, before any companion/result/outbox effects.
CREATE TRIGGER recovery_archive_source_guard BEFORE INSERT ON recovery_transactions
WHEN json_type(NEW.prepared,'$.domainEffects.plan.readSet.archiveSources') IS NOT NULL
BEGIN
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM json_each(NEW.prepared,'$.domainEffects.plan.readSet.archiveSources') AS source
  WHERE NOT EXISTS(
   SELECT 1 FROM recovery_versions AS version WHERE version.owner=NEW.owner AND version.workspace_id=NEW.workspace_id
    AND version.version_id=json_extract(source.value,'$.versionId') AND version.lineage_id=json_extract(source.value,'$.lineageId')
    AND version.entity_id=json_extract(source.value,'$.entityId') AND version.kind=json_extract(source.value,'$.kind')
    AND version.manifest_digest=json_extract(source.value,'$.manifestDigest')
    AND version.transaction_id=json_extract(source.value,'$.capture.transactionId')
    AND json_extract(version.manifest,'$.recordSnapshot.type')='exact_original'
    AND json_array_length(version.manifest,'$.artifacts')=1
    AND json_extract(version.manifest,'$.artifacts[0].digest')=json_extract(source.value,'$.original.digest')
    AND json_extract(version.manifest,'$.artifacts[0].sizeBytes')=json_extract(source.value,'$.original.sizeBytes')
    AND json_extract(version.manifest,'$.recordSnapshot.original.sizeBytes')=json_extract(source.value,'$.original.sizeBytes')
    AND json_extract(version.manifest,'$.artifacts[0].mediaType')=json_extract(source.value,'$.original.mediaType')
  )
  OR (SELECT count(*) FROM recovery_lineages AS lineage WHERE lineage.owner=NEW.owner AND lineage.workspace_id=NEW.workspace_id
   AND lineage.entity_id=json_extract(source.value,'$.entityId') AND lineage.kind IN ('artifact','evidence','resume'))<>1
  OR NOT EXISTS(SELECT 1 FROM recovery_lineages AS lineage WHERE lineage.owner=NEW.owner AND lineage.workspace_id=NEW.workspace_id
   AND lineage.lineage_id=json_extract(source.value,'$.lineageId') AND lineage.entity_id=json_extract(source.value,'$.entityId') AND lineage.kind=json_extract(source.value,'$.kind'))
  OR (SELECT count(*) FROM recovery_projections AS projection WHERE projection.owner=NEW.owner AND projection.workspace_id=NEW.workspace_id
   AND projection.entity_id=json_extract(source.value,'$.entityId') AND projection.kind IN ('artifact','evidence','resume'))<>1
  OR NOT EXISTS(SELECT 1 FROM recovery_projections AS projection WHERE projection.owner=NEW.owner AND projection.workspace_id=NEW.workspace_id
   AND projection.entity_id=json_extract(source.value,'$.entityId') AND projection.kind=json_extract(source.value,'$.kind')
   AND projection.lineage_id=json_extract(source.value,'$.lineageId') AND projection.version_id=json_extract(source.value,'$.versionId')
   AND projection.body=json_extract(source.value,'$.projectionBody') COLLATE BINARY)
  OR (SELECT count(*) FROM recovery_heads AS head WHERE head.owner=NEW.owner AND head.workspace_id=NEW.workspace_id
   AND head.lineage_id=json_extract(source.value,'$.lineageId'))<>1
  OR NOT EXISTS(SELECT 1 FROM recovery_heads AS head WHERE head.owner=NEW.owner AND head.workspace_id=NEW.workspace_id
   AND head.lineage_id=json_extract(source.value,'$.lineageId') AND head.version_id=json_extract(source.value,'$.versionId'))
  OR EXISTS(SELECT 1 FROM records AS record WHERE record.owner=NEW.owner AND record.kind='artifact' AND record.id=json_extract(source.value,'$.entityId'))
 ) THEN RAISE(ABORT,'RECOVERY_DOMAIN_ARCHIVE_SOURCE_CONFLICT') END;
END;
