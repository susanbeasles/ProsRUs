import type { Operation } from "../application/contracts";
/** The only MCP surface is the existing canonical Control dispatcher. */
export async function handleMcp(
  _request: Request,
  _invoke: (name: Operation, input: unknown) => Promise<unknown>,
  _snapshot: () => Promise<unknown>,
) {
  void _request;
  void _invoke;
  void _snapshot;
  return new Response("Not found", { status: 404 });
}
