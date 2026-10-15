import { readFileSync, readdirSync } from "node:fs";

// Keep trigger bodies intact. Semicolons in strings/comments and CASE ... END
// inside CREATE TRIGGER are not statement boundaries.
export function splitMigrationSql(sql) {
  const statements = [];
  let start = 0;
  let index = 0;
  let quote = null;
  let trigger = false;
  let depth = 0;
  let words = [];
  while (index < sql.length) {
    const char = sql[index];
    if (quote !== null) {
      if (char === quote) {
        if (sql[index + 1] === quote && quote !== "]") index++;
        else quote = null;
      }
      index++;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index + 2);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) throw Error("UNTERMINATED_MIGRATION_COMMENT");
      index = end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      quote = char === "[" ? "]" : char;
      index++;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z_0-9]*/.exec(sql.slice(index));
      const word = match[0].toUpperCase();
      words.push(word);
      if (words[0] === "CREATE" && word === "TRIGGER" && words.length <= 3)
        trigger = true;
      if (trigger && (word === "BEGIN" || word === "CASE")) depth++;
      if (trigger && word === "END") depth--;
      if (depth < 0) throw Error("INVALID_MIGRATION_TRIGGER");
      index += match[0].length;
      continue;
    }
    if (char === ";" && (!trigger || depth === 0)) {
      statements.push(sql.slice(start, index + 1));
      start = index + 1;
      trigger = false;
      words = [];
    }
    index++;
  }
  if (quote !== null || depth !== 0) throw Error("INCOMPLETE_MIGRATION_SQL");
  if (
    sql
      .slice(start)
      .replace(/--[^\n]*(\n|$)|\/\*[\s\S]*?\*\//g, "")
      .trim()
  )
    throw Error("UNTERMINATED_MIGRATION_STATEMENT");
  return statements;
}

export async function applyMigrations(
  db,
  { through = null, after = null } = {},
) {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS runtime_migrations(name TEXT PRIMARY KEY)",
    )
    .run();
  const names = readdirSync("migrations")
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort(
      (a, b) =>
        Number(a.split("_")[0].replace(".sql", "")) -
          Number(b.split("_")[0].replace(".sql", "")) || a.localeCompare(b),
    );
  for (const name of names) {
    if (after !== null && name <= after) continue;
    if (through !== null && name > through) continue;
    if (
      await db
        .prepare("SELECT name FROM runtime_migrations WHERE name=?")
        .bind(name)
        .first()
    )
      continue;
    const statements = splitMigrationSql(
      readFileSync(`migrations/${name}`, "utf8"),
    ).map((sql) => db.prepare(sql));
    await db.batch([
      ...statements,
      db.prepare("INSERT INTO runtime_migrations(name) VALUES(?)").bind(name),
    ]);
  }
}
