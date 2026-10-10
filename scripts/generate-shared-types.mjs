import { writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as contract from "../integration/shared-contract.mjs";
const target = "integration/shared-contract.d.ts";
function type(schema) {
  contract.assertSupportedSchema(schema);
  return render(schema);
}
function render(schema) {
  if (Array.isArray(schema.type))
    return schema.type.map((t) => render({ ...schema, type: t })).join(" | ");
  if (schema.format === "shared-invocation") return "SharedInvocation";
  if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (schema.oneOf ?? schema.anyOf) {
    const alternatives = schema.oneOf ?? schema.anyOf;
    const closedObject = (variant) =>
      variant.type === "object" && variant.additionalProperties === false;
    const keys = new Set(
      alternatives
        .filter(closedObject)
        .flatMap((variant) => Object.keys(variant.properties ?? {})),
    );
    return (
      "(" +
      alternatives
        .map((variant) => {
          const rendered = type(variant);
          if (!closedObject(variant)) return rendered;
          const forbidden = [...keys].filter(
            (key) => !Object.hasOwn(variant.properties ?? {}, key),
          );
          if (forbidden.length === 0) return rendered;
          return (
            "(" +
            rendered +
            " & { " +
            forbidden
              .map((key) => "readonly " + JSON.stringify(key) + "?: never;")
              .join(" ") +
            " })"
          );
        })
        .join(" | ") +
      ")"
    );
  }
  if (schema.type === "null") return "null";
  if (schema.type === "string") return "string";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "array")
    return "readonly (" + type(schema.items ?? {}) + ")[]";
  if (schema.type === "object")
    return (
      "{ " +
      Object.entries(schema.properties ?? {})
        .map(
          ([k, v]) =>
            "readonly " +
            JSON.stringify(k) +
            ((schema.required ?? []).includes(k) ? "" : "?") +
            ": " +
            type(v) +
            ";",
        )
        .join(" ") +
      " }"
    );
  return "JsonValue";
}
const ids = contract.coreOperations
    .map((o) => JSON.stringify(o.id))
    .join(" | "),
  scopes = contract.CORE_SCOPES.map((v) => JSON.stringify(v)).join(" | ");
const hash = createHash("sha256")
  .update(await readFile("integration/shared-contract.mjs"))
  .digest("hex");
let out = `// Generated from the sole shared-contract.mjs. Source SHA-256: ${hash}\nexport type JsonValue = null | boolean | number | string | readonly JsonValue[] | {readonly [key:string]:JsonValue};\nexport type JsonSchema = Readonly<Record<string,unknown>>;\nexport type ArtifactId=string; export type CanonicalId=string; export type OwnerPrincipalId=string;\nexport type CoreOperationId=${ids};\nexport type CoreScope=${scopes};\nexport type RuntimeOperationId=CoreOperationId|'job-stack.recovery.commit.v1';\nexport type RuntimeScope=CoreScope|'job-stack.recovery.commit';\nexport type CoreEffect='read'|'local-write'|'intake'|'private-export';\n`;
for (const [name, schema] of Object.entries({
  AccessRecord: contract.accessSchema,
  WorkspaceResource: contract.workspaceResourceSchema,
  WorkspaceCapability: contract.capabilitySchema,
  PublicWorkspaceGrantV2: contract.publicGrantSchema,
  RecoveryContinuationGrantV2: contract.recoveryGrantSchema,
  SaveMetadata: contract.saveMetadataSchema,
  SaveVersionInput: contract.saveInputSchema,
}))
  out += `export type ${name}=${type(schema)};\n`;
out += "export interface InputById {\n";
for (const o of [...contract.coreOperations, contract.INTERNAL_OPERATION])
  out += `${JSON.stringify(o.id)}:${type(o.inputSchema)};\n`;
out += "}\nexport interface OutputById {\n";
for (const o of [...contract.coreOperations, contract.INTERNAL_OPERATION])
  out += `${JSON.stringify(o.id)}:${type(o.outputSchema)};\n`;
out += "}\n";
out += `export type OperationEvidence = ${[...contract.coreOperations, contract.INTERNAL_OPERATION].map((o) => `{readonly id:${JSON.stringify(o.id)};readonly version:1;readonly scope:${JSON.stringify(o.scope)};readonly effect:${JSON.stringify(o.effect)};readonly inputDigest:string}`).join(" | ")};\n`;
out += `type InvocationBase={readonly contract:'job-stack.shared-auth.v1';readonly invocationId:ArtifactId;readonly access:AccessRecord;readonly capability:WorkspaceCapability;readonly authorizedAtMs:number;readonly expiresAtMs:number};
export type SharedInvocation = InvocationBase & (
 {readonly entrypoint:'owner';readonly grant:PublicWorkspaceGrantV2;readonly operation:Extract<OperationEvidence,{id:CoreOperationId}>;readonly verifiedOwnerPrincipalId:OwnerPrincipalId} |
 {readonly entrypoint:'mcp';readonly grant:PublicWorkspaceGrantV2;readonly operation:Extract<OperationEvidence,{id:CoreOperationId}>;readonly verifiedOwnerPrincipalId:null} |
 {readonly entrypoint:'recovery';readonly grant:RecoveryContinuationGrantV2;readonly operation:Extract<OperationEvidence,{id:'job-stack.recovery.commit.v1'}>;readonly verifiedOwnerPrincipalId:null});
export type CoreInvokeRequest = {[K in CoreOperationId]:{readonly contract:'job-stack.shared-auth.v1';readonly invocationId:ArtifactId;readonly operationId:K;readonly input:InputById[K]}}[CoreOperationId];
declare const ownerInteractionBrand: unique symbol;
export type TrustedOwnerInteraction={readonly [ownerInteractionBrand]:true};
export interface ProductCorePort {invokeCore<I extends CoreOperationId>(request:Extract<CoreInvokeRequest,{operationId:I}>):Promise<OutputById[I]>;}
export interface CoreOperationDefinition {readonly name:string|null;readonly id:CoreOperationId;readonly version:1;readonly scope:CoreScope;readonly effect:CoreEffect;readonly inputSchema:JsonSchema;readonly outputSchema:JsonSchema;readonly ownerOnly:boolean;readonly domainOperation:string|null;readonly transport:readonly string[];readonly maxInputBytes:number;readonly maxOutputBytes:number;}
export const CONTRACT:'job-stack.shared-auth.v1';
export const LIMITS:Readonly<{metadata:131072;privateComposite:524288;registryHead:16384;registrySegment:65536;registrySegments:8;original:1073741824;chunk:8388608;parts:128;accessMs:300000;depth:64}>;
export const coreOperations:readonly CoreOperationDefinition[];
export const CORE_SCOPES:readonly CoreScope[];export const RUNTIME_SCOPES:readonly RuntimeScope[];
export const INTERNAL_OPERATION:Readonly<{id:'job-stack.recovery.commit.v1';version:1;scope:'job-stack.recovery.commit';effect:'recovery-commit';inputSchema:JsonSchema;outputSchema:JsonSchema}>;
export function operationById(id:string):CoreOperationDefinition|typeof INTERNAL_OPERATION|null;
export function operationByName(name:string):CoreOperationDefinition|null;
export function validateCoreInput<I extends RuntimeOperationId>(id:I,value:unknown):InputById[I];
export function validateCoreOutput<I extends RuntimeOperationId>(id:I,value:unknown,options?:{grantId?:string}):OutputById[I];
export function validateWorkspaceGrant(value:unknown,options?:{internal?:false}):PublicWorkspaceGrantV2;
export function validateWorkspaceGrant(value:unknown,options:{internal:true}):RecoveryContinuationGrantV2;
export function validateCapability(value:unknown):WorkspaceCapability;export function validateAccess(value:unknown):AccessRecord;export function validateInvocation(value:unknown):SharedInvocation;
export function scalarString(value:unknown):boolean;export function dataObject(value:unknown):Record<string,unknown>;export function dataArray(value:unknown,max?:number):unknown[];
export function detachedJson(value:unknown,options?:{maxBytes?:number}):JsonValue;export function canonicalJson(value:unknown,maxBytes?:number):string;
export function assertSupportedSchema(schema:JsonSchema):JsonSchema;\nexport function validateSchema(schema:JsonSchema,value:unknown,options?:{maxBytes?:number}):JsonValue;export function freeze<T>(value:T):Readonly<T>;
export function stageAllowed(operationId:string,stage:string):boolean;
`;
for (const name of Object.keys(contract)) {
  if (name.endsWith("Schema") && typeof contract[name] !== "function")
    out += `export const ${name}:JsonSchema;\n`;
}
out +=
  "export const domainBodySchemas:Readonly<Record<string,JsonSchema>>;export const recoverySchemas:Readonly<Record<string,JsonSchema>>;\nexport const INERT_KINDS:readonly string[];export const RECORD_KINDS:readonly string[];export const PROFILE_KINDS:readonly string[];export const STAGES:readonly string[];\n";
out += "export interface RpcByName {\n";
for (const [name, schema] of Object.entries(contract.rpcSchemas))
  out += `${JSON.stringify(name)}:${type(schema)};\n`;
out +=
  "}\nexport const rpcSchemas:Readonly<Record<keyof RpcByName,JsonSchema>>;export function validateRpc<K extends keyof RpcByName>(method:K,value:unknown):RpcByName[K];\n";
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== out)
    throw Error("Shared declaration/source hash mismatch");
} else {
  await writeFile(target, out);
  await writeFile(
    target.replace(".d.ts", ".d.mts"),
    "export * from './shared-contract.js';\n",
  );
}
console.log("Shared declarations match source " + hash);
