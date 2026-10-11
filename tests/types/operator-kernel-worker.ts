import {
  observeOperatorPending,
  type PendingDatabase,
} from "../../src/storage/audited-pending-observation";
import type { AuditedImportPlan } from "../../src/application/audited-legacy-import";
import type { CheckedAuditedSourceProfile } from "../../src/application/audited-source-profile";
declare const native: D1Database;
declare const plan: AuditedImportPlan;
declare const profile: CheckedAuditedSourceProfile;
const finite: PendingDatabase = native;
void observeOperatorPending(
  {
    db: finite,
    currentWorkspace: async () => plan.workspace,
    readOriginalCopy: async () => new Uint8Array(),
    window: Object.freeze({ nowMs: 1, expiresAtMs: 2 }),
    current: async () => {},
  },
  plan,
  profile,
);
