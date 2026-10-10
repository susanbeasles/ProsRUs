import { parseAuditedSourceProfile } from "../application/audited-source-profile";
import { DurableObject } from "cloudflare:workers";
import type { Environment } from "../environment";
import { validateCoreOutput } from "../../integration/shared-contract.mjs";
import {
  readInvocation,
  parseReadRequest,
} from "../application/shared-read-authority";
import { createRecordReads } from "../application/record-reads";
function unavailable(): never {
  throw Error("operation-unavailable");
}
/** One owner/workspace lifecycle. Read callbacks never enter a mutation tail. */
export class Coordinator extends DurableObject<Environment> {
  async invokeCore(value: unknown): Promise<unknown> {
    const request = parseReadRequest(value);
    const invocation = await readInvocation(
      request,
      this.env.CONTROL_AUTHORITY,
    );
    const { ownerId, workspaceId } = invocation.capability.workspace;
    const profile =
      this.env.AUDITED_SOURCE_PROFILE === undefined
        ? undefined
        : parseAuditedSourceProfile(this.env.AUDITED_SOURCE_PROFILE, "runtime");
    const reads = createRecordReads(this.env.DB, ownerId, workspaceId, profile);
    let output: unknown;
    switch (request.operationId) {
      case "job-stack.records.read.v1":
        output = await reads.records(request.input);
        break;
      case "job-stack.version.read.v1":
        output = await reads.version(request.input.versionId);
        break;
      case "job-stack.version.list.v1":
        output = await reads.versions(request.input);
        break;
      case "job-stack.request.read.v1":
        output = await reads.request(request.input.requestKey);
        break;
      case "job-stack.protection.read.v1":
        output = await reads.protection(request.input.versionId);
        break;
      default:
        return unavailable();
    }
    await readInvocation(request, this.env.CONTROL_AUTHORITY, "before-ack");
    return validateCoreOutput(request.operationId, output, {
      grantId: invocation.grant.id,
    });
  }
  // Retired ingress/executor methods remain explicit denials for old callers.
  async invoke(..._args: unknown[]): Promise<never> {
    void _args;
    return unavailable();
  }
  async snapshot(..._args: unknown[]): Promise<never> {
    void _args;
    return unavailable();
  }
  async perform(..._args: unknown[]): Promise<never> {
    void _args;
    return unavailable();
  }
  async beginGoogleConnection(..._args: unknown[]): Promise<never> {
    void _args;
    return unavailable();
  }
  async callback(..._args: unknown[]): Promise<never> {
    void _args;
    return unavailable();
  }
  async upload(..._args: unknown[]): Promise<never> {
    void _args;
    return unavailable();
  }
  async artifact(..._args: unknown[]): Promise<never> {
    void _args;
    return unavailable();
  }
  async wakeMail(..._args: unknown[]): Promise<never> {
    void _args;
    return unavailable();
  }
  async tick(): Promise<never> {
    return unavailable();
  }
  async alarm(): Promise<never> {
    return unavailable();
  }
}
