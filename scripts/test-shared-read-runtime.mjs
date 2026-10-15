import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { applyMigrations } from "./runtime-migrations.mjs";

process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
async function bundle(contents) {
  return (await build({
    stdin: { contents, resolveDir: process.cwd() }, bundle: true, write: false,
    format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:*"],
  })).outputFiles[0].text;
}

const productScript = await bundle("export {default,JobStack,Coordinator} from './src/worker';");
const authorityScript = await bundle(`
  import {WorkerEntrypoint} from 'cloudflare:workers';
  import {sharedReadFixture} from './tests/fixtures/shared-read-authority';
  import {validateRpc} from './integration/shared-contract.mjs';
  let mode='valid'; const calls=[];
  export class FixtureAuthority extends WorkerEntrypoint {
    async revalidate(value){
      const input=validateRpc('revalidate',value), f=await sharedReadFixture();
      calls.push(input.stage);
      if(input.invocationId!==f.request.invocationId||input.operationId!==f.request.operationId||input.inputDigest!==f.invocation.operation.inputDigest)throw Error('operation-denied');
      if(mode==='revoked'||(mode==='revoke-before-ack'&&input.stage==='before-ack'))throw Error('operation-denied');
      if(mode==='expire-before-ack'&&input.stage==='before-ack')return {...f.response,now:f.response.expiresAtMs};
      if(mode==='revision-drift')return {...f.response,invocation:{...f.invocation,grant:{...f.invocation.grant,revision:2}}};
      return f.response;
    }
  }
  export default {async fetch(request){
    const selected=new URL(request.url).pathname.slice(1);
    if(selected==='calls')return Response.json(calls);
    if(!['valid','revoked','revoke-before-ack','expire-before-ack','revision-drift'].includes(selected))return new Response(null,{status:404});
    mode=selected;calls.length=0;return new Response(null,{status:204});
  }};
`);
const clientScript = `export default {async fetch(request,env){
  try{return Response.json(await env.PRODUCT.invokeCore(await request.json()));}
  catch{return Response.json({error:'read-denied'},{status:403});}
}};`;
let externalEffects = 0;
const denyOutbound = () => { externalEffects++; throw Error("unexpected-outbound"); };
const common = { modules: true, compatibilityDate: "2026-10-08", compatibilityFlags: ["nodejs_compat"], cf: false };
const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false, host: "127.0.0.1", outboundService: denyOutbound,
  workers: [
    { ...common, name: "client", script: clientScript, serviceBindings: { PRODUCT: { name: "product", entrypoint: "JobStack" } } },
    { ...common, name: "product", script: productScript, d1Databases: { DB: "synthetic" },
      durableObjects: { COORDINATOR: { className: "Coordinator", useSQLite: true } },
      serviceBindings: { CONTROL_AUTHORITY: { name: "authority", entrypoint: "FixtureAuthority" }, ASSETS: denyOutbound } },
    { ...common, name: "authority", script: authorityScript },
  ],
}));
try {
  const db = await mf.getD1Database("DB", "product");
  await applyMigrations(db);
  const authority = await mf.getWorker("authority");
  const product = await mf.getWorker("product");
  const request = {
    contract: "job-stack.shared-auth.v1", invocationId: "invocation_fixture",
    operationId: "job-stack.records.read.v1",
    input: { workspaceId: "workspace_fixture", kind: "opportunity", cursor: null },
  };
  const invoke = value => mf.dispatchFetch("https://fixture.invalid/read", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  });
  let response = await invoke(request);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items: [], nextCursor: null });
  assert.deepEqual(await (await authority.fetch("https://fixture.invalid/calls")).json(), ["read", "read", "before-ack"]);
  for (const mode of ["revoked", "revoke-before-ack", "expire-before-ack", "revision-drift"]) {
    await authority.fetch("https://fixture.invalid/" + mode);
    response = await invoke(request);
    assert.equal(response.status, 403, mode);
    assert.deepEqual(await response.json(), { error: "read-denied" }, mode);
    const calls = await (await authority.fetch("https://fixture.invalid/calls")).json();
    assert.equal(calls.length, mode.endsWith("before-ack") ? 3 : 1, mode);
  }
  await authority.fetch("https://fixture.invalid/valid");
  for (const value of [
    { ...request, input: { ...request.input, workspaceId: "foreign_workspace" } },
    { ...request, invocationId: "foreign_invocation" },
    { ...request, callerAuthority: { scopes: ["*"] } },
    { ...request, operationId: "job-stack.claim.add.v1" },
  ]) assert.equal((await invoke(value)).status, 403);
  assert.equal((await product.fetch("https://fixture.invalid/owner/job-stack")).status, 404);
  assert.equal(externalEffects, 0);
  for (const table of ["records", "intents", "recovery_versions"])
    assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n, 0);
  console.log("PASS: real private Product/Coordinator/D1 read; 3 current-authority RPCs; revocation, expiry, revision and selection denial; no public ingress or provider effects. Synthetic authority only.");
} finally {
  await mf.dispose();
}
