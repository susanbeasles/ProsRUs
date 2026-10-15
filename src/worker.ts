import { WorkerEntrypoint } from "cloudflare:workers";
import type { Environment } from "./environment";
import { operationById } from "../integration/shared-contract.mjs";
import {
  currentInvocation,
  parseCoreRequest,
} from "./application/shared-read-authority";
import { commandFor } from "./application/commands/registry";
import { publicFailure } from "./application/commands/execute";
import {
  RELEASE_MARKER_PATH,
  releaseMarker,
  releaseMarkerResponse,
} from "./release-marker";
export { Coordinator } from "./jobs/coordinator";
function unavailable(): never {
  throw Error("operation-unavailable");
}
async function discard(body: ReadableStream<Uint8Array> | undefined) {
  if (body && !body.locked) await body.cancel().catch(() => undefined);
}
export class JobStack extends WorkerEntrypoint<Environment> {
  /** Thin authority + Durable Object forwarder. Reads keep their existing
   * contract; commands are refused here when the registry says unavailable,
   * before any authority call. Only the upload chunk may carry a body stream. */
  async invokeCore(
    value: unknown,
    body?: ReadableStream<Uint8Array>,
  ): Promise<unknown> {
    let request, effect;
    try {
      request = parseCoreRequest(value);
      const operation = operationById(request.operationId);
      if (!operation || operation.effect === "recovery-commit") unavailable();
      effect = operation.effect;
      if (effect !== "read") commandFor(request.operationId);
      if (body !== undefined && request.operationId !== "job-stack.upload.chunk.v1")
        throw Error("operation-denied");
    } catch (error) {
      await discard(body);
      if (request === undefined || effect === "read") throw error;
      throw Error(publicFailure(error));
    }
    let invocation;
    try {
      invocation = (
        await currentInvocation(
          request,
          this.env.CONTROL_AUTHORITY,
          "read",
          effect,
        )
      ).invocation;
    } catch (error) {
      await discard(body);
      if (effect === "read") throw error;
      throw Error("operation-denied");
    }
    const workspace = invocation.capability.workspace;
    const stub = this.env.COORDINATOR.get(
      this.env.COORDINATOR.idFromName(
        workspace.ownerId + "/" + workspace.workspaceId,
      ),
    );
    return body === undefined
      ? stub.invokeCore(request)
      : stub.invokeCore(request, body);
  }
  /** Same `http-release-marker/v1` payload for service-only health checks. */
  async releaseMarker() {
    return releaseMarker(this.env.RELEASE_MARKER);
  }
  async ownerAsset(request: Request) {
    const url = new URL(request.url),
      root = "/owner/job-stack";
    if (
      request.method !== "GET" ||
      !(
        [root, root + "/"].includes(url.pathname) ||
        /^\/owner\/job-stack\/assets\/[A-Za-z0-9_.-]+$/.test(url.pathname)
      )
    )
      return new Response("Not found", { status: 404 });
    url.pathname = [root, root + "/"].includes(url.pathname)
      ? "/"
      : url.pathname.slice(root.length);
    url.search = "";
    const response = await this.env.ASSETS.fetch(
      new Request(url, { method: "GET" }),
    );
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    headers.set(
      "content-security-policy",
      "default-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    return new Response(response.body, { status: response.status, headers });
  }
  async handle(..._args: unknown[]): Promise<never> {
    void _args;
    return unavailable();
  }
  async receivePush(..._args: unknown[]): Promise<never> {
    void _args;
    return unavailable();
  }
  async putUploadChunk(..._args: unknown[]): Promise<never> {
    void _args;
    return unavailable();
  }
  async downloadArtifact(..._args: unknown[]): Promise<never> {
    void _args;
    return unavailable();
  }
  async readRecoveryState(..._args: unknown[]): Promise<never> {
    void _args;
    return unavailable();
  }
  async readRecoveryObject(..._args: unknown[]): Promise<never> {
    void _args;
    return unavailable();
  }
  async readRecoveryCommit(..._args: unknown[]): Promise<never> {
    void _args;
    return unavailable();
  }
  async readRecoveryResult(..._args: unknown[]): Promise<never> {
    void _args;
    return unavailable();
  }
}
export default {
  async fetch(request: Request, env: Environment) {
    if (
      request.method === "GET" &&
      new URL(request.url).pathname === RELEASE_MARKER_PATH
    )
      return releaseMarkerResponse(env.RELEASE_MARKER);
    return new Response("Not found", { status: 404 });
  },
  // Cron and queue consumers stay disabled; the JOBS producer binding is
  // reserved for separately gated external effects.
  async scheduled() {
    return unavailable();
  },
  async queue() {
    return unavailable();
  },
} satisfies ExportedHandler<Environment, { id: string }>;
