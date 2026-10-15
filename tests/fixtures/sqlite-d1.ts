import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

/** Local synthetic D1 seam over real SQLite for unit tests. It implements only the
 * prepare/bind/first/all/run/batch surface used by the product, with batch()
 * atomic like D1. Runtime D1 behavior is separately exercised under Miniflare. */
type Statement = D1PreparedStatement & { readonly sql: string };
export function sqliteD1(options: { migrations?: boolean } = {}) {
  const raw = new DatabaseSync(":memory:");
  if (options.migrations !== false)
    for (const name of readdirSync("migrations")
      .filter((file) => file.endsWith(".sql"))
      .sort())
      raw.exec(readFileSync(`migrations/${name}`, "utf8"));
  const statements: string[] = [];
  /** SQL of each committed batch, in order (rolled-back batches excluded). */
  const batches: string[][] = [];
  function statement(sql: string, values: readonly unknown[] = []): Statement {
    const params = () => values as SQLInputValue[];
    function execute() {
      statements.push(sql);
      return raw.prepare(sql);
    }
    const value = {
      sql,
      bind(...next: unknown[]) {
        return statement(sql, next);
      },
      async first<T>(column?: string) {
        const row = execute().get(...params()) as
          | Record<string, unknown>
          | undefined;
        if (!row) return null;
        const copy = { ...row };
        return (column === undefined ? copy : copy[column]) as T;
      },
      async all<T>() {
        const results = execute()
          .all(...params())
          .map((row) => ({ ...row })) as T[];
        return { results, success: true as const, meta: {} };
      },
      async run() {
        const outcome = execute().run(...params());
        return {
          results: [],
          success: true as const,
          meta: {
            changes: Number(outcome.changes),
            last_row_id: Number(outcome.lastInsertRowid),
          },
        };
      },
      async raw() {
        throw Error("unsupported-fixture-raw");
      },
    };
    return value as unknown as Statement;
  }
  const db = {
    prepare(sql: string) {
      return statement(sql);
    },
    async batch(list: D1PreparedStatement[]) {
      raw.exec("BEGIN");
      try {
        const results = [];
        for (const item of list) results.push(await item.run());
        raw.exec("COMMIT");
        batches.push(list.map((item) => (item as Statement).sql));
        return results;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
    async exec() {
      throw Error("unsupported-fixture-exec");
    },
  };
  return {
    db: db as unknown as D1Database,
    raw,
    statements,
    batches,
    count(table: string) {
      return Number(
        (raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number })
          .n,
      );
    },
  };
}
