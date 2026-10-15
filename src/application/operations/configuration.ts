import { demand } from "../../domain/model";
import { schemas } from "../contracts";
import type { OperationDependencies, OperationRequest } from "../dependencies";
export async function updateSettings(
  { actor, raw, now }: OperationRequest,
  { store }: Pick<OperationDependencies, "store" | "settings">,
) {
  demand(actor.kind === "user", "USER_REQUIRED");
  const { revision, ...value } = schemas.update_settings.parse(raw);
  demand(
    !value.sendingEnabled ||
      (value.sender && value.profileResolved && value.integrationVerified),
    "SENDING_PREREQUISITES",
  );
  const current = await store.get("settings", "main");
  if (!current) {
    demand(revision === 0, "REVISION_CONFLICT");
    return store.add("settings", "main", value, actor.id, now);
  }
  return store.update("settings", "main", value, revision, actor.id, now);
}
