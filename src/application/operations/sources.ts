import { z } from "zod";
import { discoveryWindowSchema } from "../../domain/targeting-profile";
import { demand } from "../../domain/model";
import { boundedText } from "../../providers/http";
import { saveEvidence } from "../evidence";
import { readBoard } from "../../providers/boards";
import { schemas } from "../contracts";
import type { OperationDependencies, OperationRequest } from "../dependencies";
export async function discover(
  { actor, raw }: OperationRequest,
  { settings, invoke }: Pick<OperationDependencies, "settings" | "invoke">,
) {
  schemas.discover.parse(raw);
  const { value: config } = await settings();
  demand(
    config.discoveryWindow && config.targetingProfile,
    "DISCOVERY_UNCONFIGURED",
  );
  discoveryWindowSchema.parse(config.discoveryWindow);
  const results = [];
  for (const board of config.boards) {
    const listings = await readBoard(board.provider, board.company);
    for (const listing of listings) {
      results.push(
        await invoke(actor, "capture_opportunity", {
          company: listing.company,
          role: listing.role,
          sourceUrl: listing.sourceUrl,
          description: listing.description,
          terms: {
            employment: "full_time",
            baseUsd: null,
            hourlyUsd: null,
            remote: listing.remote ? true : null,
            match401k: null,
            zeroPremium: null,
            affordableCare: null,
          },
        }),
      );
    }
  }
  return { captured: results.length };
}
export async function syncMail(
  { raw, now }: OperationRequest,
  { reserve }: Pick<OperationDependencies, "reserve">,
) {
  schemas.sync_mail.parse(raw);
  return reserve("sync", `sync-${Math.floor(now / 300000)}`, {});
}
export async function reconcileAction(
  { raw, now }: OperationRequest,
  { reserve }: Pick<OperationDependencies, "reserve">,
) {
  const { intentId } = schemas.reconcile_action.parse(raw);
  return reserve(
    "reconcile",
    `reconcile-${intentId}-${Math.floor(now / 60000)}`,
    { intentId },
  );
}
export async function importDocument(
  { actor, raw, now }: OperationRequest,
  {
    store,
    deps,
    settings,
  }: Pick<OperationDependencies, "store" | "deps" | "settings">,
) {
  const { fileId } = schemas.import_document.parse(raw);
  const google = await deps.google();
  const metadata = z
    .object({ name: z.string(), mimeType: z.string() })
    .parse(await google.selectedDriveFile(fileId));
  demand(
    metadata.mimeType === "application/vnd.google-apps.document",
    "ONLY_GOOGLE_DOC_EXPORT_SUPPORTED",
  );
  const text = await boundedText(await google.exportDocument(fileId), 200000);
  const { value: config } = await settings();
  return saveEvidence(
    { name: metadata.name, text, owner: deps.owner, actor: actor.id, now },
    {
      store,
      artifacts: deps.artifacts,
      profileExtraction: config.profileExtraction,
    },
  );
}
