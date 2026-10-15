import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import assert from "node:assert/strict";
import { applyMigrations } from "./runtime-migrations.mjs";
process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
let effects = 0,
  checks = 0;
const script = (
  await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `import worker,{Coordinator as ActualCoordinator} from './src/local';export {JobStack} from './src/local';export class Coordinator extends ActualCoordinator{async fixtureProbe(){const results=[];for(const method of ['invoke','snapshot','perform','beginGoogleConnection','callback','upload','artifact','wakeMail','tick','alarm']){try{await this[method]({owner:'synthetic-owner',scopes:['*'],state:'approved'});results.push('unexpected-success');}catch(error){results.push(error.message);}}return results;}}export default {...worker,async fetch(request,env){if(new URL(request.url).pathname==='/fixture-probe'){const stub=env.COORDINATOR.get(env.COORDINATOR.idFromName('synthetic-owner/synthetic-workspace'));const results=await stub.fixtureProbe();for(const method of ['scheduled','queue']){try{await worker[method]({},env,{});results.push('unexpected-success');}catch(error){results.push(error.message);}}return Response.json(results);}return worker.fetch(request,env);}};`,
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    target: "es2022",
  })
).outputFiles[0].text;
const trap = () => {
  effects++;
  throw Error("unexpected-effect");
};
const mf = new Miniflare(
  convertV4MiniflareOptions({
    cf: false,
    modules: true,
    script,
    compatibilityDate: "2026-10-08",
    compatibilityFlags: ["nodejs_compat"],
    host: "127.0.0.1",
    d1Databases: { DB: "test" },
    r2Buckets: ["ORIGINALS", "UPLOADS"],
    durableObjects: {
      COORDINATOR: { className: "Coordinator", useSQLite: true },
    },
    serviceBindings: { ASSETS: trap, CONTROL_AUTHORITY: trap },
    outboundService: trap,
  }),
);
try {
  const db = await mf.getD1Database("DB");
  await applyMigrations(db);
  await db
    .prepare(
      "INSERT INTO records(owner,kind,id,body,revision,updated_at) VALUES('synthetic-owner','opportunity','restored-approved',?,1,1)",
    )
    .bind(
      JSON.stringify({
        state: "approved",
        consent: true,
        approval: { state: "approved" },
      }),
    )
    .run();
  for (const path of [
    "/",
    "/owner/job-stack/api/snapshot",
    "/owner/job-stack/api/operations/capture_opportunity",
    "/owner/job-stack/api/operations/send_reply",
    "/owner/job-stack/google/callback",
    "/mcp",
  ])
    for (const method of ["GET", "POST"]) {
      const response = await mf.dispatchFetch("http://localhost:8787" + path, {
        method,
        headers: {
          "x-owner": "synthetic-owner",
          origin: "http://localhost:8787",
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST"
          ? { body: '{"state":"approved","scopes":["*"]}' }
          : {}),
      });
      assert.equal(response.status, 404);
      checks++;
    }
  const effectsResponse = await mf.dispatchFetch(
    "http://localhost:8787/fixture-probe",
  );
  const failures = await effectsResponse.json();
  assert.equal(failures.length, 12);
  assert.ok(
    failures.every((message) => message.includes("operation-unavailable")),
  );
  checks += 12;
  assert.equal(effects, 0);
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM intents").first()).n,
    0,
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM recovery_versions").first()).n,
    0,
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM records").first()).n,
    1,
  );
  checks += 4;
  console.log(
    `PASS: ${checks} real local Worker/Coordinator/D1 closure checks; zero providers, reservations, versions or intents. Authenticated productive reads are tested in the composed Control runtime.`,
  );
} finally {
  await mf.dispose();
}
