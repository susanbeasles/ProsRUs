import type {
  InputById,
  OutputById,
  CoreInvokeRequest,
  CoreScope,
} from "../../integration/shared-contract.mjs";
const input: InputById["job-stack.pipeline.page.read.v1"] = {
  workspaceId: "synthetic",
  view: "relationships",
  cursor: null,
};
const call: CoreInvokeRequest = {
  contract: "job-stack.shared-auth.v1",
  invocationId: "synthetic",
  operationId: "job-stack.pipeline.page.read.v1",
  input,
};
const scope: CoreScope = "job-stack.records.read";
// @ts-expect-error The alias operation never adds a new authority scope.
const invented: CoreScope = "job-stack.pipeline.page.read";
const limit: InputById["job-stack.pipeline.page.read.v1"] = {
  workspaceId: "synthetic",
  view: "all",
  cursor: null,
  // @ts-expect-error Fixed page size cannot be selected by a caller.
  limit: 20,
};
const oldPage: OutputById["job-stack.records.read.v1"] = {
  items: [],
  nextCursor: null,
  // @ts-expect-error Old closed record summaries do not silently become display pages.
  datasetId: "synthetic",
};
void call;
void scope;
void invented;
void limit;
void oldPage;
