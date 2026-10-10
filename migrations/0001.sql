PRAGMA foreign_keys = ON;
CREATE TABLE records (
 owner TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('claim','opportunity','packet','thread','interview','offer','artifact','connection','reminder','settings','attempt','prep','question')),
 id TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner,kind,id)
);
CREATE INDEX records_recent ON records(owner,kind,updated_at DESC);
CREATE TRIGGER immutable_packet BEFORE UPDATE ON records WHEN OLD.kind='packet' BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PACKET'); END;
CREATE TABLE source_keys(owner TEXT NOT NULL, source_key TEXT NOT NULL, opportunity_id TEXT NOT NULL, PRIMARY KEY(owner,source_key));
CREATE TABLE intents(
 owner TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),
 state TEXT NOT NULL CHECK(state IN ('pending','running','succeeded','ambiguous','blocked','failed')),
 receipt TEXT, failure TEXT, attempts INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner,id)
);
CREATE INDEX intents_pending ON intents(owner,state,updated_at);
CREATE TABLE runs(owner TEXT NOT NULL,run_key TEXT NOT NULL,status TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(owner,run_key));
CREATE TABLE audit(id TEXT PRIMARY KEY,owner TEXT NOT NULL,actor TEXT NOT NULL,operation TEXT NOT NULL,object_id TEXT NOT NULL,decision TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX audit_recent ON audit(owner,created_at DESC);
CREATE TABLE credentials(owner TEXT NOT NULL,provider TEXT NOT NULL,ciphertext TEXT NOT NULL,iv TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(owner,provider));
CREATE TABLE oauth_states(digest TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL,verifier TEXT NOT NULL);
CREATE UNIQUE INDEX unique_external_effect ON intents(owner,kind,digest) WHERE kind IN ('send','schedule');
