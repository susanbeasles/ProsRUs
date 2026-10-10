import { WorkerEntrypoint } from "cloudflare:workers";
import type { Environment } from "./environment";
import {
  readInvocation,
  parseReadRequest,
} from "./application/shared-read-authority";
export { Coordinator } from "./jobs/coordinator";
function unavailable(): never {
  throw Error("operation-unavailable");
}
export class JobStack extends WorkerEntrypoint<Environment> {
  async invokeCore(value: unknown): Promise<unknown> {
    const request = parseReadRequest(value);
    const invocation = await readInvocation(
      request,
      this.env.CONTROL_AUTHORITY,
    );
    const workspace = invocation.capability.workspace;
    const stub = this.env.COORDINATOR.get(
      this.env.COORDINATOR.idFromName(
        workspace.ownerId + "/" + workspace.workspaceId,
      ),
    );
    return stub.invokeCore(request);
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
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
  async scheduled() {
    return unavailable();
  },
  async queue() {
    return unavailable();
  },
} satisfies ExportedHandler<Environment, { id: string }>;
