import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import replacementFixtures from "./fixtures/recovery-replacement.json";

const migration = "migrations/0002_recovery.sql";

function recoveryDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("migrations/0001.sql", "utf8"));
  db.exec(readFileSync(migration, "utf8"));
  return db;
}

function seedHistory(
  db: DatabaseSync,
  table: string,
  setup: readonly string[],
) {
  db.exec("INSERT INTO recovery_workspaces VALUES('owner','workspace')");
  if (table !== "recovery_workspaces") {
    db.exec(
      "INSERT INTO recovery_chains VALUES('owner','workspace','epoch','0',NULL)",
    );
    db.prepare(
      "INSERT INTO recovery_transactions VALUES('owner','workspace','transaction','epoch','1','0',NULL,?,1,'request',?,'{\"versions\":[],\"expectedHeads\":[]}')",
    ).run("a".repeat(64), "c".repeat(64));
  }
  for (const sql of setup) db.exec(sql);
}

const rowidCases = replacementFixtures.flatMap((fixture) =>
  ["rowid", "_rowid_", "oid"].map((alias) => ({ ...fixture, alias })),
);
const nonpositiveCases = rowidCases.flatMap((fixture) =>
  [-2, -1, 0].map((ordinal) => ({ ...fixture, ordinal })),
);

describe("recovery schema ownership and migration", () => {
  it.each(nonpositiveCases)(
    "rejects unused $table $alias=$ordinal before the next implicit write",
    ({ table, setup, replace, alias, ordinal }) => {
      const db = recoveryDatabase();
      try {
        seedHistory(db, table, setup);
        const before = db.prepare(`SELECT rowid,* FROM ${table}`).all();
        const chain = db.prepare("SELECT * FROM recovery_chains").all();
        expect(() =>
          db.exec(
            replace.replace("$ROWID", alias).replace("$RID", String(ordinal)),
          ),
        ).toThrow(/RECOVERY_INVALID_ORDINAL/);
        expect(db.prepare(`SELECT rowid,* FROM ${table}`).all()).toEqual(
          before,
        );
        expect(db.prepare("SELECT * FROM recovery_chains").all()).toEqual(
          chain,
        );
        db.exec(
          replace
            .replace("INSERT OR REPLACE", "INSERT")
            .replace("($ROWID,", "(")
            .replace("VALUES($RID,", "VALUES("),
        );
        expect(
          db.prepare(`SELECT rowid,* FROM ${table} WHERE rowid=1`).all(),
        ).toEqual(before);
        expect(
          db.prepare(`SELECT rowid FROM ${table} WHERE rowid=2`).get(),
        ).toEqual({ rowid: 2 });
      } finally {
        db.close();
      }
    },
  );

  it.each(rowidCases)(
    "allows allocated positive $table ordinals when $alias is NULL",
    ({ table, setup, replace, alias }) => {
      const db = recoveryDatabase();
      try {
        seedHistory(db, table, setup);
        const before = db.prepare(`SELECT rowid,* FROM ${table}`).all();
        db.exec(replace.replace("$ROWID", alias).replace("$RID", "NULL"));
        expect(
          db.prepare(`SELECT rowid,* FROM ${table} WHERE rowid=1`).all(),
        ).toEqual(before);
        expect(
          db.prepare(`SELECT rowid FROM ${table} WHERE rowid=2`).get(),
        ).toEqual({ rowid: 2 });
      } finally {
        db.close();
      }
    },
  );
  it.each(rowidCases)(
    "rejects $table replacement through $alias without changing source or chain",
    ({ table, setup, replace, alias }) => {
      const db = recoveryDatabase();
      try {
        seedHistory(db, table, setup);
        const before = db.prepare(`SELECT rowid,* FROM ${table}`).all();
        const chain = db.prepare("SELECT * FROM recovery_chains").all();
        const sql = replace.replace("$ROWID", alias).replace("$RID", "1");
        expect(() => db.exec(sql)).toThrow(/RECOVERY_HISTORY_IMMUTABLE/);
        expect(db.prepare(`SELECT rowid,* FROM ${table}`).all()).toEqual(
          before,
        );
        expect(db.prepare("SELECT * FROM recovery_chains").all()).toEqual(
          chain,
        );
      } finally {
        db.close();
      }
    },
  );

  it.each(replacementFixtures)(
    "permits unused positive rowids and retains original $table rows",
    ({ table, setup, replace }) => {
      const db = recoveryDatabase();
      try {
        seedHistory(db, table, setup);
        const before = db.prepare(`SELECT rowid,* FROM ${table}`).all();
        db.exec(replace.replace("$ROWID", "rowid").replace("$RID", "1000"));
        expect(
          db.prepare(`SELECT rowid,* FROM ${table} WHERE rowid=1`).all(),
        ).toEqual(before);
        expect(
          db.prepare(`SELECT rowid FROM ${table} WHERE rowid=1000`).get(),
        ).toEqual({ rowid: 1000 });
      } finally {
        db.close();
      }
    },
  );

  it("rejects transaction epoch-sequence replacement even when the mutable chain is rebuilt", () => {
    const db = recoveryDatabase();
    try {
      seedHistory(db, "recovery_transactions", []);
      db.exec(
        "UPDATE recovery_chains SET sequence='0',transaction_digest=NULL WHERE owner='owner'",
      );
      const before = db
        .prepare("SELECT rowid,* FROM recovery_transactions")
        .all();
      const chain = db.prepare("SELECT * FROM recovery_chains").all();
      const statement = db.prepare(
        "INSERT OR REPLACE INTO recovery_transactions VALUES('owner','workspace','replacement','epoch','1','0',NULL,?,1,'replacement',?,'{\"versions\":[],\"expectedHeads\":[]}')",
      );
      expect(() => statement.run("b".repeat(64), "d".repeat(64))).toThrow(
        /RECOVERY_HISTORY_IMMUTABLE/,
      );
      expect(
        db.prepare("SELECT rowid,* FROM recovery_transactions").all(),
      ).toEqual(before);
      expect(db.prepare("SELECT * FROM recovery_chains").all()).toEqual(chain);
    } finally {
      db.close();
    }
  });
  it("adds recoverable history rather than overwriting legacy records", () => {
    expect(existsSync(migration), "recovery migration is missing").toBe(true);
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(readFileSync("migrations/0001.sql", "utf8"));
      db.prepare("INSERT INTO records VALUES(?,?,?,?,?,?)").run(
        "owner",
        "claim",
        "claim",
        '{"status":"user_confirmed"}',
        7,
        1000,
      );
      db.exec(readFileSync(migration, "utf8"));
      expect(db.prepare("SELECT revision,body FROM records").get()).toEqual({
        revision: 7,
        body: '{"status":"user_confirmed"}',
      });
      expect(
        db.prepare("SELECT count(*) AS count FROM recovery_versions").get(),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare(
            "SELECT provenance,archive_state,source_revision FROM recovery_import_baselines WHERE source_table='records'",
          )
          .get(),
      ).toEqual({
        provenance: "imported_legacy_baseline",
        archive_state: "pending",
        source_revision: "7",
      });
    } finally {
      db.close();
    }
  });

  it("rejects replacement through the lineage's alternate unique identity", () => {
    const db = recoveryDatabase();
    try {
      db.exec("INSERT INTO recovery_workspaces VALUES('owner','workspace')");
      db.exec(
        "INSERT INTO recovery_lineages VALUES('owner','workspace','lineage','resume','entity')",
      );
      const before = db.prepare("SELECT * FROM recovery_lineages").all();
      expect(() =>
        db.exec(
          "INSERT OR REPLACE INTO recovery_lineages VALUES('owner','workspace','replacement','resume','entity')",
        ),
      ).toThrow(/RECOVERY_HISTORY_IMMUTABLE/);
      expect(db.prepare("SELECT * FROM recovery_lineages").all()).toEqual(
        before,
      );
    } finally {
      db.close();
    }
  });

  it("rejects replacement through a historical version's transaction-lineage identity", () => {
    const db = recoveryDatabase();
    try {
      db.exec("INSERT INTO recovery_workspaces VALUES('owner','workspace')");
      db.exec(
        "INSERT INTO recovery_chains VALUES('owner','workspace','epoch','0',NULL)",
      );
      db.prepare(
        "INSERT INTO recovery_transactions VALUES('owner','workspace','transaction','epoch','1','0',NULL,?,1,'request',?,'{\"versions\":[],\"expectedHeads\":[]}')",
      ).run("a".repeat(64), "b".repeat(64));
      db.exec(
        "INSERT INTO recovery_lineages VALUES('owner','workspace','lineage','resume','entity')",
      );
      const insert = db.prepare(
        "INSERT OR REPLACE INTO recovery_versions VALUES('owner','workspace',?,'lineage','resume','entity','transaction','epoch','1',1,?,'{}')",
      );
      insert.run("original", "c".repeat(64));
      const before = db.prepare("SELECT * FROM recovery_versions").all();
      expect(() => insert.run("replacement", "d".repeat(64))).toThrow(
        /RECOVERY_HISTORY_IMMUTABLE/,
      );
      expect(db.prepare("SELECT * FROM recovery_versions").all()).toEqual(
        before,
      );
    } finally {
      db.close();
    }
  });
});
