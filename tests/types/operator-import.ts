import {
  observeOperatorPending,
  type OperatorPendingPorts,
} from "../../src/storage/audited-pending-observation";
import {
  prepareOperatorInput,
  createParentBroker,
  runOperatorImport,
  type OperatorApproval,
} from "../../src/operator/import";
import type { AuditedImportPlan } from "../../src/application/audited-legacy-import";
import type { CheckedAuditedSourceProfile } from "../../src/application/audited-source-profile";
import type {
  InputById,
  OutputById,
} from "../../integration/shared-contract.mjs";
declare const plan: AuditedImportPlan;
declare const profile: CheckedAuditedSourceProfile;
declare const ports: OperatorPendingPorts;
declare const approval: OperatorApproval;
void observeOperatorPending(ports, plan, profile);
const prepared = prepareOperatorInput({ plan, profile, approval });
const broker = createParentBroker(prepared, {
  current: async () => {},
  dispatch: async () => null,
});
void runOperatorImport(prepared, (text) => broker.accept(text));
void observeOperatorPending(
  // @ts-expect-error A production operator must supply the fixed window and current callback.
  {
    db: ports.db,
    currentWorkspace: ports.currentWorkspace,
    readOriginalCopy: ports.readOriginalCopy,
  },
  plan,
  profile,
);
const read: InputById["job-stack.records.read.v1"] = {
  workspaceId: "synthetic",
  kind: "opportunity",
  cursor: null,
  // @ts-expect-error Registration/import adds no writable input to the shared read contract.
  importPlan: plan,
};
const summary: OutputById["job-stack.records.read.v1"] = {
  items: [],
  nextCursor: null,
};
void read;
void summary;
