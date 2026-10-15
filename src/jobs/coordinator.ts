import { parseAuditedSourceProfile } from "../application/audited-source-profile";
import { DurableObject } from "cloudflare:workers";
import type { Environment } from "../environment";
import {
  operationById,
  validateCoreOutput,
  type CoreInvokeRequest,
} from "../../integration/shared-contract.mjs";
import {
  readInvocation,
  parseCoreRequest,
} from "../application/shared-read-authority";
import { createRecordReads } from "../application/record-reads";
import { executeCommand } from "../application/commands/execute";
import { createSerialQueue } from "../application/commands/serial";
import { createRecoveryIntakeBudget } from "../application/recovery-admission";
import { createPrimaryArchive } from "../storage/primary-archive";
function unavailable(): never {
  throw Error("operation-unavailable");
}
/** One owner/workspace lifecycle. Read callbacks never enter a mutation tail;
 * every registered command runs serialized in this object's command tail. */
export class Coordinator extends DurableObject<Environment> {
  #commands = createSerialQueue();
  #intakeBudget = createRecoveryIntakeBudget();
  async invokeCore(
    value: unknown,
    body?: ReadableStream<Uint8Array>,
  ): Promise<unknown> {
    let request: CoreInvokeRequest;
    try {
      request = parseCoreRequest(value);
    } catch (error) {
      if (body && !body.locked) await body.cancel().catch(() => undefined);
      throw error;
    }
    if (operationById(request.operationId)?.effect !== "read")
      return this.#commands.run(() =>
        executeCommand(
          request,
          {
            db: this.env.DB,
            archive: createPrimaryArchive(this.env.ARTIFACTS),
            authority: this.env.CONTROL_AUTHORITY,
            trustRoot: this.env.RECOVERY_TRUST_ROOT,
            budget: this.#intakeBudget,
          },
          body,
        ),
      );
    if (body && !body.locked) {
      await body.cancel().catch(() => undefined);
      throw Error("operation-denied");
    }
    return this.#read(request);
  }
  async #read(request: CoreInvokeRequest): Promise<unknown> {
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
      case "job-stack.pipeline.page.read.v1":
        output = await reads.pipelinePage(request.input);
        break;
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
