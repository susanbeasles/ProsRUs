import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { commandHarness } from "./fixtures/command-harness";
import { SYNTHETIC_WORKSPACE } from "./fixtures/command-control";

const SAVE = "job-stack.version.save.v1";
const saveInput = {
  requestKey: "save-1",
  lineageId: "lineage-resume",
  entityId: "resume-1",
  kind: "resume",
  expectedParentIds: [],
  sourceVersionIds: [],
  branchRequested: false,
  content: { text: "Synthetic resume" },
};
type SaveResult = { versionId: string; transactionId: string };
const original = {
  sizeBytes: 11,
  fileName: "resume.txt",
  mediaType: "text/plain",
  format: null,
  lastModified: null,
};
const bytes = new TextEncoder().encode("hello world");
const stream = (value: Uint8Array) => new Blob([new Uint8Array(value)]).stream();

describe("generic version save", () => {
  it("saves an inert archival version, replays it and denies a stale parent", async () => {
    const h = await commandHarness();
    const saved = (await h.invoke(SAVE, saveInput)) as SaveResult;
    expect(h.control.calls).toEqual([
      "read",
      "sign-preparation",
      "before-ack",
    ]);
    const manifest = await h.reads().version(saved.versionId);
    expect(manifest).toMatchObject({
      kind: "resume",
      entityId: "resume-1",
      lineageId: "lineage-resume",
      approval: { state: "draft" },
    });
    h.control.reset();
    expect(await h.invoke(SAVE, saveInput)).toEqual(saved);
    expect(h.control.calls).toEqual(["read", "before-ack"]);
    await expect(
      h.invoke(SAVE, {
        ...saveInput,
        requestKey: "save-2",
        content: { text: "Second" },
      }),
    ).rejects.toThrow("recovery-head-conflict");
    const next = (await h.invoke(SAVE, {
      ...saveInput,
      requestKey: "save-3",
      expectedParentIds: [saved.versionId],
      content: { text: "Second" },
    })) as SaveResult;
    const history = await h.reads().versions({
      workspaceId: SYNTHETIC_WORKSPACE.workspaceId,
      lineageId: "lineage-resume",
      cursor: null,
    });
    expect(history.items.map((v) => v.versionId).sort()).toEqual(
      [saved.versionId, next.versionId].sort(),
    );
    expect(h.control.violations).toEqual([]);
  });

  it("rejects the reserved internal request key namespace", async () => {
    const h = await commandHarness();
    await expect(
      h.invoke(SAVE, { ...saveInput, requestKey: "internal-baseline-x" }),
    ).rejects.toThrow("reserved-request-key");
    expect(h.sqlite.count("command_requests")).toBe(0);
  });
});

describe("upload intake on the primary archive", () => {
  it("begins, stores a verified chunk, completes and saves the original as a version", async () => {
    const h = await commandHarness();
    const begun = (await h.invoke("job-stack.upload.begin.v1", {
      requestKey: "upload-begin",
      original,
      purpose: { kind: "profile-source" },
    })) as { uploadHandle: string; uploadPath: string; partCount: number };
    expect(begun).toMatchObject({ status: "upload_started", partCount: 1 });
    expect(begun.uploadPath).toBe(
      `/owner/job-stack/api/uploads/${begun.uploadHandle}/chunks/{ordinal}?grant=grant_fixture`,
    );
    const transportSha256 = createHash("sha256").update(bytes).digest("hex");
    const chunk = await h.invoke(
      "job-stack.upload.chunk.v1",
      {
        requestKey: "upload-chunk-0",
        uploadHandle: begun.uploadHandle,
        ordinal: 0,
        sizeBytes: 11,
        transportSha256,
      },
      { body: stream(bytes) },
    );
    expect(chunk).toMatchObject({ status: "chunk_stored", sizeBytes: 11 });
    const ready = await h.invoke("job-stack.upload.complete.v1", {
      requestKey: "upload-complete",
      uploadHandle: begun.uploadHandle,
    });
    expect(ready).toMatchObject({
      status: "upload_ready",
      complete: true,
      sizeBytes: 11,
      original,
    });
    const { content: omitted, ...withoutContent } = saveInput;
    void omitted;
    const saved = (await h.invoke(SAVE, {
      ...withoutContent,
      requestKey: "save-upload",
      uploadHandle: begun.uploadHandle,
    })) as SaveResult;
    const manifest = await h.reads().version(saved.versionId);
    expect(manifest.recordSnapshot).toEqual({
      type: "exact_original",
      original,
    });
    expect(h.control.violations).toEqual([]);
  });

  it("refuses unverifiable purposes, mismatched transport bytes and stray bodies", async () => {
    const h = await commandHarness();
    await expect(
      h.invoke("job-stack.upload.begin.v1", {
        requestKey: "meeting",
        original,
        purpose: {
          kind: "meeting-artifact",
          meetingId: "meeting-1",
          artifactKind: "transcript",
          authorizationRef: "auth-1",
        },
      }),
    ).rejects.toThrow("upload-purpose-unavailable");
    const begun = (await h.invoke("job-stack.upload.begin.v1", {
      requestKey: "upload-begin",
      original,
      purpose: { kind: "profile-source" },
    })) as { uploadHandle: string };
    await expect(
      h.invoke(
        "job-stack.upload.chunk.v1",
        {
          requestKey: "chunk-bad",
          uploadHandle: begun.uploadHandle,
          ordinal: 0,
          sizeBytes: 11,
          transportSha256: "0".repeat(64),
        },
        { body: stream(bytes) },
      ),
    ).rejects.toThrow("upload-transport-mismatch");
    await expect(
      h.invoke(
        "job-stack.upload.chunk.v1",
        {
          requestKey: "chunk-missing",
          uploadHandle: begun.uploadHandle,
          ordinal: 0,
          sizeBytes: 11,
          transportSha256: "0".repeat(64),
        },
      ),
    ).rejects.toThrow("upload-body-required");
    const calls = h.control.calls.length;
    await expect(
      h.invoke(SAVE, saveInput, { body: stream(bytes) }),
    ).rejects.toThrow("operation-denied");
    expect(h.control.calls.length).toBe(calls);
    await expect(
      h.invoke("job-stack.upload.complete.v1", {
        requestKey: "complete-early",
        uploadHandle: begun.uploadHandle,
      }),
    ).rejects.toThrow();
  });
});
