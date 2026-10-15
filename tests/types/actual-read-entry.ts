import type { JobStack } from "../../src/worker";
import type { Coordinator } from "../../src/jobs/coordinator";
import { parseReadRequest } from "../../src/application/shared-read-authority";
import {
  validateCoreOutput,
  type InputById,
  type OutputById,
} from "../../integration/shared-contract.mjs";
declare const product: Pick<JobStack, "invokeCore">;
declare const coordinator: Pick<Coordinator, "invokeCore">;
declare const transport: unknown;
const request = parseReadRequest(transport);
const productOutput: Promise<unknown> = product.invokeCore(request);
const coordinatorOutput: Promise<unknown> = coordinator.invokeCore(request);
async function parsed() {
  return validateCoreOutput("job-stack.records.read.v1", await productOutput);
}
void parsed;
void coordinatorOutput;
// Actual RPC returns unknown until the one shared decoder validates it.
// @ts-expect-error Unknown transport is not an authorized typed output.
const unsafe: Promise<OutputById["job-stack.records.read.v1"]> = productOutput;
const duplicate: InputById["job-stack.records.read.v1"] = {
  workspaceId: "workspace",
  kind: "opportunity",
  entityId: "record",
  // @ts-expect-error Record selectors cannot include arbitrary source pointers.
  sourceId: "unavailable",
};
void unsafe;
void duplicate;

import {
  CONTRACT,
  type ProductCorePort,
  type SaveMetadata,
  type SaveVersionInput,
} from "../../integration/shared-contract.mjs";
declare const typedProduct: ProductCorePort;
const listSelection: InputById["job-stack.records.read.v1"] = {
  workspaceId: "workspace",
  kind: "opportunity",
  cursor: null,
};
const detailSelection: InputById["job-stack.records.read.v1"] = {
  workspaceId: "workspace",
  kind: "opportunity",
  entityId: "record",
};
typedProduct.invokeCore({
  contract: CONTRACT,
  invocationId: "i1",
  operationId: "job-stack.records.read.v1",
  input: listSelection,
});
typedProduct.invokeCore({
  contract: CONTRACT,
  invocationId: "i1",
  operationId: "job-stack.records.read.v1",
  input: detailSelection,
});
const bothSelectors: {
  workspaceId: string;
  kind: "opportunity";
  cursor: null;
  entityId: string;
} = {
  workspaceId: "workspace",
  kind: "opportunity",
  cursor: null,
  entityId: "record",
};
// @ts-expect-error The recognized list and detail selectors are mutually exclusive.
const ambiguousSelection: InputById["job-stack.records.read.v1"] =
  bothSelectors;
const ambiguousRequest: {
  contract: typeof CONTRACT;
  invocationId: string;
  operationId: "job-stack.records.read.v1";
  input: typeof bothSelectors;
} = {
  contract: CONTRACT,
  invocationId: "i1",
  operationId: "job-stack.records.read.v1",
  input: bothSelectors,
};
// @ts-expect-error The actual typed port cannot receive both recognized selectors.
typedProduct.invokeCore(ambiguousRequest);
const saveBase = {
  workspaceId: "workspace",
  requestKey: "request",
  lineageId: "lineage",
  entityId: "entity",
  kind: "profile" as const,
  expectedParentIds: [],
  sourceVersionIds: [],
  branchRequested: false,
};
const direct: SaveMetadata = { ...saveBase, content: { text: "synthetic" } };
const uploaded: SaveMetadata = { ...saveBase, uploadHandle: "upload" };
const bothContent = {
  ...saveBase,
  content: { text: "synthetic" },
  uploadHandle: "upload",
};
// @ts-expect-error Content and upload are exclusive closed alternatives too.
const ambiguousSave: SaveMetadata = bothContent;
const { workspaceId: unusedWorkspace, ...bothSaveInput } = bothContent;
// @ts-expect-error The no-workspace save input has the same exclusive alternatives.
const ambiguousSaveInput: SaveVersionInput = bothSaveInput;
void ambiguousSelection;
void direct;
void uploaded;
void ambiguousSave;
void ambiguousSaveInput;
void unusedWorkspace;
