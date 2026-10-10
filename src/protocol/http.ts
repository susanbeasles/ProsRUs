import type { Environment } from "../environment";
import type { Principal } from "../domain/model";
/** Legacy Principal HTTP dispatch is retired. Only the named shared-authority port serves data. */
export async function handleAuthorized(
  _request: Request,
  _env: Environment,
  _actor: Principal,
) {
  void _request;
  void _env;
  void _actor;
  return new Response("Not found", { status: 404 });
}
