import { readFileSync, statSync, writeFileSync } from "node:fs";

function readJson(path) {
  if (statSync(path).size > 65536) throw Error("Configuration input exceeds the size limit");
  return JSON.parse(readFileSync(path, "utf8"));
}

const [outputFile, ownerId, googleClientId = "", ...extra] = process.argv.slice(2);
if (!outputFile || !/^[A-Za-z0-9_-]{1,100}$/.test(ownerId ?? "") || ownerId === "UNCONFIGURED" || extra.length)
  throw Error("Usage: node scripts/configure.mjs terraform-output.json owner-id [google-client-id]");
if (googleClientId.length > 512 || /[\x00-\x20\x7f]/.test(googleClientId))
  throw Error("Invalid public Google client identity");

const outputs = readJson(outputFile);
const value = name => outputs?.[name]?.value;
const environment = value("environment");
if (!["staging", "production"].includes(environment)) throw Error("Invalid environment");
const name = `job-stack-${environment}`;
const accountId = value("account_id"), databaseId = value("database_id");
if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/.test(accountId)
    || typeof databaseId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(databaseId)
    || value("bucket_name") !== name || value("queue_name") !== name)
  throw Error("Invalid or mismatched Terraform resource references");

const config = readJson("wrangler.jsonc");
// Resource mapping cannot activate public ingress or background effects. A
// separately reviewed composition supplies any reciprocal authority binding.
if (config.main !== "src/worker.ts" || config.workers_dev !== false || config.preview_urls !== false
    || !Array.isArray(config.queues?.consumers) || config.queues.consumers.length !== 0
    || !Array.isArray(config.triggers?.crons) || config.triggers.crons.length !== 0
    || config.d1_databases?.length !== 1 || config.d1_databases[0].binding !== "DB"
    || config.r2_buckets?.length !== 1 || config.r2_buckets[0].binding !== "ARTIFACTS"
    || config.queues.producers?.length !== 1 || config.queues.producers[0].binding !== "JOBS"
    || !config.vars || typeof config.vars !== "object")
  throw Error("Expected the reviewed private, read-only source configuration");

config.name = name;
config.account_id = accountId;
config.vars.OWNER_ID = ownerId;
config.vars.GOOGLE_CLIENT_ID = googleClientId;
config.d1_databases[0].database_id = databaseId;
config.d1_databases[0].database_name = name;
config.r2_buckets[0].bucket_name = value("bucket_name");
config.queues.producers[0].queue = value("queue_name");
writeFileSync(`wrangler.${environment}.json`, JSON.stringify(config, null, 2) + "\n");
console.log(`Wrote wrangler.${environment}.json for review; not deployed or authorized. The existing Control authority binding and private configuration still require qualification.`);
