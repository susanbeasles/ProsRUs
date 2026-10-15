-- compatibility: additive
-- Independent backup ledger (ADR 0004). Additive only: no existing table, trigger
-- or row changes. Every row is evidence written once by the replicator (or, for
-- aliases, by an operator restore into a NEW database) and never updated.

-- Byte identity of each pinned primary object as copied to the backup bucket.
CREATE TABLE recovery_backup_objects (
 owner TEXT NOT NULL, workspace_id TEXT NOT NULL,
 storage_key TEXT NOT NULL CHECK(length(storage_key) BETWEEN 1 AND 1101),
 version_id TEXT NOT NULL CHECK(length(version_id) BETWEEN 1 AND 100),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
 size_bytes INTEGER NOT NULL CHECK(size_bytes>=0 AND size_bytes<=9007199254740991),
 backup_key TEXT NOT NULL,
 transaction_id TEXT NOT NULL,
 PRIMARY KEY(owner,workspace_id,storage_key,version_id),
 FOREIGN KEY(owner,workspace_id,transaction_id) REFERENCES recovery_transactions(owner,workspace_id,transaction_id),
 CHECK(backup_key='objects/sha256/'||substr(sha256,1,2)||'/'||sha256)
) WITHOUT ROWID;
CREATE INDEX recovery_backup_objects_digest ON recovery_backup_objects(owner,workspace_id,sha256);

-- A row exists only after every table and file object was read back and re-hashed.
CREATE TABLE recovery_checkpoints (
 owner TEXT NOT NULL, workspace_id TEXT NOT NULL,
 checkpoint_id TEXT NOT NULL CHECK(length(checkpoint_id)<=40 AND (checkpoint_id GLOB 'daily-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR checkpoint_id GLOB 'monthly-[0-9][0-9][0-9][0-9]-[0-9][0-9]')),
 kind TEXT NOT NULL CHECK(kind IN ('daily','monthly')),
 epoch_id TEXT NOT NULL,
 sequence TEXT NOT NULL CHECK(length(sequence)<=20 AND (sequence='0' OR (sequence GLOB '[1-9]*' AND sequence NOT GLOB '*[^0-9]*'))),
 transaction_digest TEXT CHECK(transaction_digest IS NULL OR (length(transaction_digest)=64 AND transaction_digest NOT GLOB '*[^a-f0-9]*')),
 manifest_key TEXT NOT NULL,
 manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^a-f0-9]*'),
 schema_fingerprint TEXT NOT NULL CHECK(length(schema_fingerprint)=64 AND schema_fingerprint NOT GLOB '*[^a-f0-9]*'),
 table_count INTEGER NOT NULL CHECK(table_count>=1),
 file_count INTEGER NOT NULL CHECK(file_count>=0),
 file_bytes INTEGER NOT NULL CHECK(file_bytes>=0),
 created_at INTEGER NOT NULL CHECK(created_at>=0),
 verified_at INTEGER NOT NULL CHECK(verified_at>=created_at),
 PRIMARY KEY(owner,workspace_id,checkpoint_id),
 FOREIGN KEY(owner,workspace_id) REFERENCES recovery_workspaces(owner,workspace_id),
 CHECK(substr(checkpoint_id,1,length(kind)+1)=kind||'-')
) WITHOUT ROWID;
CREATE INDEX recovery_checkpoints_verified ON recovery_checkpoints(owner,workspace_id,verified_at);

-- Written only by the restore procedure in a new database: R2 cannot preserve the
-- pinned upload version, so a restored object maps the pinned identity to the
-- version created by the restore. Content digests are still checked on read.
CREATE TABLE recovery_restored_objects (
 storage_key TEXT NOT NULL CHECK(length(storage_key) BETWEEN 1 AND 1101),
 original_version_id TEXT NOT NULL CHECK(length(original_version_id) BETWEEN 1 AND 100),
 restored_version_id TEXT NOT NULL CHECK(length(restored_version_id) BETWEEN 1 AND 100),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
 size_bytes INTEGER NOT NULL CHECK(size_bytes>=0 AND size_bytes<=9007199254740991),
 restore_id TEXT NOT NULL CHECK(length(restore_id) BETWEEN 1 AND 100),
 restored_at INTEGER NOT NULL CHECK(restored_at>=0),
 PRIMARY KEY(storage_key,original_version_id)
) WITHOUT ROWID;

CREATE TRIGGER recovery_backup_objects_immutable_update BEFORE UPDATE ON recovery_backup_objects BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_backup_objects_immutable_delete BEFORE DELETE ON recovery_backup_objects BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_backup_objects_immutable_replace BEFORE INSERT ON recovery_backup_objects WHEN EXISTS(SELECT 1 FROM recovery_backup_objects AS prior WHERE prior.owner=NEW.owner AND prior.workspace_id=NEW.workspace_id AND prior.storage_key=NEW.storage_key AND prior.version_id=NEW.version_id) BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_checkpoints_immutable_update BEFORE UPDATE ON recovery_checkpoints BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_checkpoints_immutable_delete BEFORE DELETE ON recovery_checkpoints BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_checkpoints_immutable_replace BEFORE INSERT ON recovery_checkpoints WHEN EXISTS(SELECT 1 FROM recovery_checkpoints AS prior WHERE prior.owner=NEW.owner AND prior.workspace_id=NEW.workspace_id AND prior.checkpoint_id=NEW.checkpoint_id) BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_restored_objects_immutable_update BEFORE UPDATE ON recovery_restored_objects BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_restored_objects_immutable_delete BEFORE DELETE ON recovery_restored_objects BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER recovery_restored_objects_immutable_replace BEFORE INSERT ON recovery_restored_objects WHEN EXISTS(SELECT 1 FROM recovery_restored_objects AS prior WHERE prior.storage_key=NEW.storage_key AND prior.original_version_id=NEW.original_version_id) BEGIN SELECT RAISE(ABORT,'RECOVERY_HISTORY_IMMUTABLE'); END;
