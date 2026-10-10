import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
it("enforces tenant identity, immutable packets, and unique external intents in real SQLite", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("migrations/0001.sql", "utf8"));
  db.prepare(
    "INSERT INTO records(owner,kind,id,body,revision,updated_at) VALUES(?,?,?,?,?,?)",
  ).run("one", "claim", "a", "{}", 1, 1);
  expect(() =>
    db
      .prepare(
        "INSERT INTO records(owner,kind,id,body,revision,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run("one", "claim", "a", "{}", 1, 1),
  ).toThrow();
  expect(
    db.prepare("SELECT * FROM records WHERE owner=?").all("other"),
  ).toHaveLength(0);
  db.prepare(
    "INSERT INTO intents(owner,id,kind,digest,payload,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run("one", "i", "send", "d", "{}", "pending", 1, 1);
  expect(() =>
    db
      .prepare(
        "INSERT INTO intents(owner,id,kind,digest,payload,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run("one", "i", "send", "different", "{}", "pending", 1, 1),
  ).toThrow();
  db.prepare(
    "INSERT INTO records(owner,kind,id,body,revision,updated_at) VALUES(?,?,?,?,?,?)",
  ).run("one", "packet", "p", "{}", 1, 1);
  expect(() =>
    db
      .prepare("UPDATE records SET body=? WHERE kind=?")
      .run('{"changed":true}', "packet"),
  ).toThrow();
  db.close();
});
it("deduplicates identical effects even when callers choose different intent IDs", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("migrations/0001.sql", "utf8"));
  const insert = db.prepare(
    "INSERT INTO intents(owner,id,kind,digest,payload,state,created_at,updated_at) VALUES(?,?,?,?,?,'pending',1,1)",
  );
  insert.run("one", "a", "send", "same-effect", "{}");
  expect(() => insert.run("one", "b", "send", "same-effect", "{}")).toThrow();
  db.close();
});
