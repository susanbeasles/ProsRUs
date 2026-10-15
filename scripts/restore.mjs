// Operator client for the local restore entry (docs/recovery-backup.md).
// Usage: node scripts/restore.mjs <workspaceId> <restoreId> [targetSequence|latest] [--unsigned]
// Sends the repository's migrations so replay can apply them when a change
// needs a newer schema. Prints the restore report; writes nothing else.
import { readdirSync, readFileSync } from "node:fs";
import { splitMigrationSql } from "./runtime-migrations.mjs";

const [workspaceId, restoreId, target = "latest", ...flags] = process.argv.slice(2);
if (!/^[A-Za-z0-9_-]{1,100}$/.test(workspaceId ?? "") || !/^[A-Za-z0-9_-]{1,100}$/.test(restoreId ?? "")
    || !(target === "latest" || /^(0|[1-9][0-9]{0,19})$/.test(target)) || flags.some((flag) => flag !== "--unsigned"))
  throw Error("Usage: node scripts/restore.mjs <workspaceId> <restoreId> [targetSequence|latest] [--unsigned]");
const migrations = readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()
  .map((name) => ({ name, sql: splitMigrationSql(readFileSync(`migrations/${name}`, "utf8")) }));
const port = process.env.RESTORE_PORT ?? "8799";
const response = await fetch(`http://127.0.0.1:${port}/restore`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ workspaceId, restoreId, targetSequence: target === "latest" ? null : target, migrations,
    requireSignedCheckpoint: !flags.includes("--unsigned") }),
});
console.log(JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exitCode = 1;
