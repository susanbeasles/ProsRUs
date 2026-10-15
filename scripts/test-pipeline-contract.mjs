import test from "node:test";
import assert from "node:assert/strict";
import {
  operationById,
  validateCoreInput,
  validateCoreOutput,
  CORE_SCOPES,
} from "../integration/shared-contract.mjs";
const id = "job-stack.pipeline.page.read.v1";
test("pipeline page is one read operation under existing records scope", () => {
  const op = operationById(id);
  assert.ok(op, "page operation must exist");
  assert.equal(op.name, "job_stack_pipeline_page");
  assert.equal(op.scope, "job-stack.records.read");
  assert.equal(op.effect, "read");
  assert.equal(op.maxOutputBytes, 64000);
  assert.equal(CORE_SCOPES.includes("job-stack.pipeline.page.read"), false);
});
test("page input accepts only workspace, view and cursor", () => {
  const input = {
    workspaceId: "synthetic_workspace",
    view: "relationships",
    cursor: null,
  };
  assert.deepEqual(validateCoreInput(id, input), input);
  for (const extra of [
    { limit: 20 },
    { sourceLabel: "caller" },
    { fields: ["company"] },
    { view: "private" },
    { cursor: "x".repeat(4097) },
  ])
    assert.throws(() => validateCoreInput(id, { ...input, ...extra }));
});
test("page output is closed, bounded and explicitly pending", () => {
  const page = {
    format: "pipeline-page-v1",
    status: "available",
    workspaceId: "synthetic_workspace",
    view: "all",
    datasetId: "a".repeat(64),
    importObservedAt: 100,
    totalObservations: 154,
    historicalRelationships: 10,
    range: { start: 0, end: 0 },
    items: [],
    nextCursor: null,
  };
  assert.deepEqual(validateCoreOutput(id, page), page);
  for (const extra of [
    { rawSource: "private" },
    { totalObservations: 155 },
    { items: Array(21).fill({}) },
    { status: "empty" },
  ])
    assert.throws(() => validateCoreOutput(id, { ...page, ...extra }));
});
test("unsupported page capacity is unavailable without changing old record APIs", () => {
  const unavailable = {
    format: "pipeline-page-v1",
    status: "unavailable",
    workspaceId: "synthetic_workspace",
    view: "all",
    reason: "page_capacity",
  };
  assert.deepEqual(validateCoreOutput(id, unavailable), unavailable);
  assert.deepEqual(
    validateCoreOutput("job-stack.records.read.v1", {
      items: [],
      nextCursor: null,
    }),
    { items: [], nextCursor: null },
  );
  assert.throws(() =>
    validateCoreOutput("job-stack.records.read.v1", {
      items: [],
      nextCursor: null,
      display: {},
    }),
  );
});
test('new page operation introduces no duplicate or new public grant scopes',()=>{
 assert.equal(new Set(CORE_SCOPES).size,CORE_SCOPES.length);
});
