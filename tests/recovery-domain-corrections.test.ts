import {
  recoverySchemas,
  validateSchema,
} from "../integration/shared-contract.mjs";
import { describe, expect, it } from "vitest";
import {
  domainFixture,
  packetPlan,
  snapshot,
  baselinePlan,
} from "./fixtures/domain-preparation";
import {
  parseDomainPlan,
  acceptedDomainPlanSchema,
} from "../src/domain/recovery-domain-plan";
import { domainRecordSnapshotSchema } from "../src/domain/recovery-record";
import { preparedEnvelopeSchema } from "../src/domain/recovery";
import { buildPrimaryPackage } from "../src/application/recovery-package-content";
import { prepareRecoveryPackage } from "../src/application/recovery-preparation";
import { createRecoverySigner } from "../src/identity/recovery-signing";
import { unsignedPreparation } from "../src/storage/recovery-package-archive";
import { artifactBaselinePlan } from "./fixtures/domain-original";
import { canonicalizeEnvelope } from "../src/domain/recovery-canonical";
import { validateCommittedOriginal } from "../src/application/recovery-domain-original";
import {
  preparationFixture,
  primaryContext,
  primaryInput,
} from "./fixtures/primary-preparation";

describe("R1 exact stored business values at every enclosing boundary", () => {
  function paddedCompanion() {
    const plan = structuredClone(packetPlan());
    const candidate = plan.candidates[1];
    if (!candidate || candidate.snapshot.recordKind !== "opportunity")
      throw Error("FIXTURE");
    candidate.snapshot.body.sourceUrl = " https://example.com/job ";
    return plan;
  }
  it("rejects a normalized non-primary URL in the whole plan and accepted wrapper", async () => {
    const plan = paddedCompanion();
    const fixture = await domainFixture(undefined, plan);
    expect(() => parseDomainPlan(plan)).toThrow();
    expect(() =>
      acceptedDomainPlanSchema.parse(fixture.accepted.domainPlan),
    ).toThrow();
  });
  it("rejects inherited and nested prep URL normalization without losing valid claim whitespace", () => {
    const prep = snapshot("prep", "prep-1", 1, {
      interviewId: "interview-1",
      company: "Example",
      role: "Engineer",
      sourceUrl: " https://example.com/job ",
      roleBrief: "Brief",
      examples: [{ claim: "  exact claim  ", sources: [] }],
      questions: [],
      assumptions: [],
      createdAt: 1000,
    });
    expect(() => domainRecordSnapshotSchema.parse(prep)).toThrow();
    const exact = {
      ...prep,
      body: {
        ...(prep.body as Record<string, unknown>),
        sourceUrl: "https://example.com/job",
      },
    };
    expect(domainRecordSnapshotSchema.parse(exact)).toEqual(exact);
  });
  it.each([
    " https://example.com/job ",
    "https://exam\tple.com/job",
    "https://example.com/\njob",
  ])(
    "rejects transforming URL spelling %j in candidates and observed raw guards",
    (sourceUrl) => {
      const plan = structuredClone(packetPlan());
      const candidate = plan.candidates[1];
      const guard = plan.readSet.records[1];
      if (
        !candidate ||
        candidate.snapshot.recordKind !== "opportunity" ||
        !guard ||
        guard.state !== "present"
      )
        throw Error("FIXTURE");
      candidate.snapshot.body.sourceUrl = sourceUrl;
      expect(() => parseDomainPlan(plan)).toThrow();
      candidate.snapshot.body.sourceUrl = "https://example.com/job";
      guard.rawBody = JSON.stringify({
        ...JSON.parse(guard.rawBody),
        sourceUrl,
      });
      expect(() => parseDomainPlan(plan)).toThrow();
    },
  );
  it("denies unaccepted normalization before archive or custody and in signer reconstruction", async () => {
    const fixture = await domainFixture();
    const signer = createRecoverySigner(fixture);
    const prepared = await prepareRecoveryPackage(
      fixture.input,
      fixture.context,
      { ...fixture, signer },
    );
    const bad = paddedCompanion();
    const badFixture = await domainFixture(undefined, bad);
    let signs = 0;
    const guarded = createRecoverySigner({
      ...badFixture,
      custody: {
        ...badFixture.custody,
        async signPreparation(binding) {
          signs++;
          return badFixture.custody.signPreparation(binding);
        },
      },
    });
    await expect(
      buildPrimaryPackage(
        badFixture.accepted,
        { archive: badFixture.archive, trustRootIds: ["synthetic-primary"] },
        "persist",
      ),
    ).rejects.toThrow();
    expect(badFixture.objects.size).toBe(0);
    await expect(
      prepareRecoveryPackage(badFixture.input, badFixture.context, {
        ...badFixture,
        signer: guarded,
      }),
    ).rejects.toThrow();
    expect(signs).toBe(0);
    fixture.accepted.domainPlan.plan = bad;
    await expect(
      signer.signPreparation(unsignedPreparation(prepared), fixture.context),
    ).rejects.toThrow();
  });
  it("rejects a padded candidate in the prepared effects sink rather than normalizing it back to the signed value", async () => {
    const fixture = await domainFixture();
    const signer = createRecoverySigner(fixture);
    const prepared = await prepareRecoveryPackage(
      fixture.input,
      fixture.context,
      { ...fixture, signer },
    );
    const altered = structuredClone(prepared);
    const candidate = altered.domainEffects?.plan.candidates[1];
    if (!candidate || candidate.snapshot.recordKind !== "opportunity")
      throw Error("FIXTURE");
    candidate.snapshot.body.sourceUrl = " https://example.com/job ";
    expect(() => preparedEnvelopeSchema.parse(altered)).toThrow();
  });
});

describe("R2 original file evidence", () => {
  it("denies observed original when only snapshot and raw row JSON exist", async () => {
    const plan = artifactBaselinePlan();
    const candidate = plan.candidates[0];
    if (!candidate?.observation) throw Error("FIXTURE");
    Object.assign(candidate.observation, { originalArtifact: "observed" });
    expect(() => parseDomainPlan(plan)).toThrow();
    const fixture = await domainFixture(undefined, plan);
    await expect(
      buildPrimaryPackage(
        fixture.accepted,
        { archive: fixture.archive, trustRootIds: ["synthetic-primary"] },
        "persist",
      ),
    ).rejects.toThrow();
    expect(fixture.objects.size).toBe(0);
  });
});

it("R2 resolves an observed original through the existing complete upload reader", async () => {
  const fixture = await domainFixture(undefined, artifactBaselinePlan());
  const bytes = new TextEncoder().encode(
    "%PDF-1.7\nUploaded original\n%%EOF\n",
  );
  const start = await fixture.uploads.begin(
    {
      requestKey: "original-upload",
      original: {
        sizeBytes: bytes.length,
        fileName: "legacy.pdf",
        mediaType: "application/pdf",
        format: "PDF",
        lastModified: 90,
      },
    },
    fixture.context,
  );
  await fixture.uploads.putChunk(
    {
      uploadHandle: start.uploadHandle,
      ordinal: 0,
      requestKey: "original-part",
      body: new Blob([new Uint8Array(bytes)]).stream(),
    },
    fixture.context,
  );
  const ready = await fixture.uploads.complete(
    start.uploadHandle,
    fixture.context,
  );
  const candidate = fixture.accepted.domainPlan.plan.candidates[0];
  if (!candidate || candidate.observation?.originalArtifact !== "missing")
    throw Error("FIXTURE");
  candidate.artifacts.push({
    role: "uploaded-original",
    source: {
      type: "upload",
      uploadHandle: start.uploadHandle,
      digest: ready.artifact.digest,
      sizeBytes: ready.artifact.sizeBytes,
      mediaType: ready.artifact.mediaType,
    },
  });
  candidate.observation = {
    ...candidate.observation,
    originalArtifact: "observed",
    original: {
      artifactRole: "uploaded-original",
      digest: ready.artifact.digest,
      sizeBytes: ready.artifact.sizeBytes,
      mediaType: ready.artifact.mediaType,
    },
  };
  const signer = createRecoverySigner(fixture);
  const prepared = await prepareRecoveryPackage(
    fixture.input,
    fixture.context,
    { ...fixture, signer },
  );
  const schema = recoverySchemas.preparedEnvelopeSchema;
  if (!schema) throw Error("FIXTURE");
  expect(validateSchema(schema, prepared)).toEqual(prepared);
  const incomplete = structuredClone(prepared);
  const observation = incomplete.domainEffects?.plan.candidates[0]?.observation;
  if (!observation) throw Error("FIXTURE");
  Reflect.deleteProperty(observation, "original");
  expect(() => validateSchema(schema, incomplete)).toThrow();
  const descriptor = prepared.versions[0]?.artifacts[2];
  if (!descriptor) throw Error("FIXTURE");
  expect((await fixture.archive.get(descriptor.object))?.bytes).toEqual(bytes);
  await signer.verifyPreparation(prepared);
});

it("R1 rejects normalization when the opportunity is the primary result as well", async () => {
  const plan = structuredClone(packetPlan());
  const candidate = plan.candidates[1];
  if (!candidate || candidate.snapshot.recordKind !== "opportunity")
    throw Error("FIXTURE");
  candidate.snapshot.body.sourceUrl = "https://example.com/\njob";
  Object.assign(plan, {
    resultRecord: {
      candidateRole: candidate.role,
      recordKind: "opportunity",
      entityId: candidate.snapshot.entityId,
      revision: candidate.snapshot.revision,
    },
  });
  const fixture = await domainFixture(undefined, plan);
  await expect(
    buildPrimaryPackage(
      fixture.accepted,
      { archive: fixture.archive, trustRootIds: ["synthetic-primary"] },
      "persist",
    ),
  ).rejects.toThrow();
  expect(fixture.objects.size).toBe(0);
});

it.each([
  "missing-locator",
  "not-applicable-file",
  "duplicate-role",
  "raw-original",
])("R2 denies inconsistent original state %s", (kind) => {
  const plan = artifactBaselinePlan(),
    candidate = plan.candidates[0];
  if (!candidate?.observation) throw Error("FIXTURE");
  if (kind === "missing-locator")
    Object.assign(candidate.observation, { originalLocator: "another-key" });
  if (kind === "not-applicable-file")
    candidate.observation = {
      kind: "legacy_baseline",
      originalArtifact: "not_applicable",
      originalLocator: null,
      approvalProvenance: "none",
    };
  if (kind === "duplicate-role") {
    const artifact = candidate.artifacts[0];
    if (!artifact) throw Error("FIXTURE");
    candidate.artifacts.push(structuredClone(artifact));
  }
  if (kind === "raw-original")
    Object.assign(candidate.observation, {
      originalArtifact: "observed",
      original: {
        artifactRole: "legacy-json",
        digest: "a".repeat(64),
        sizeBytes: 100,
        mediaType: "application/json",
      },
    });
  expect(() => parseDomainPlan(plan)).toThrow();
});

it("R2 accepts a separately captured file even when its bytes equal its metadata representation", async () => {
  const fixture = await preparationFixture();
  const first = canonicalizeEnvelope({ type: "exact_bytes", sizeBytes: 0 });
  const bytes = canonicalizeEnvelope({
    type: "exact_bytes",
    sizeBytes: first.length + 1,
  });
  const prepared = await prepareRecoveryPackage(
    { ...primaryInput, content: bytes },
    primaryContext,
    fixture,
  );
  const manifest = prepared.versions[0];
  if (!manifest) throw Error("FIXTURE");
  expect(canonicalizeEnvelope(manifest.recordSnapshot)).toEqual(bytes);
  expect(() => validateCommittedOriginal(manifest, 0)).not.toThrow();
});
it("R2 distinguishes full upload transport media from preserved original file media", async () => {
  const fixture = await preparationFixture(),
    bytes = new TextEncoder().encode("%PDF-1.7\nOriginal\n%%EOF\n");
  const started = await fixture.uploads.begin(
    {
      requestKey: "captured-file",
      original: {
        fileName: "legacy.pdf",
        sizeBytes: bytes.length,
        mediaType: "application/pdf",
        format: "PDF",
        lastModified: 90,
      },
    },
    primaryContext,
  );
  await fixture.uploads.putChunk(
    {
      uploadHandle: started.uploadHandle,
      ordinal: 0,
      requestKey: "capture-part",
      body: new Blob([new Uint8Array(bytes)]).stream(),
    },
    primaryContext,
  );
  await fixture.uploads.complete(started.uploadHandle, primaryContext);
  const { content, ...input } = primaryInput;
  void content;
  const prepared = await prepareRecoveryPackage(
    { ...input, uploadHandle: started.uploadHandle },
    primaryContext,
    fixture,
  );
  const manifest = prepared.versions[0];
  if (!manifest) throw Error("FIXTURE");
  expect(() => validateCommittedOriginal(manifest, 0)).not.toThrow();
});

it.each(["snapshot", "raw-row"])(
  "R2 preserves an independently uploaded original equal to %s bytes",
  async (representation) => {
    const fixture = await domainFixture(undefined, artifactBaselinePlan());
    const candidate = fixture.accepted.domainPlan.plan.candidates[0],
      guard = fixture.accepted.domainPlan.plan.readSet.records[0];
    if (
      !candidate ||
      candidate.observation?.originalArtifact !== "missing" ||
      !guard ||
      guard.state !== "present"
    )
      throw Error("FIXTURE");
    const bytes =
      representation === "snapshot"
        ? canonicalizeEnvelope(candidate.snapshot)
        : new TextEncoder().encode(guard.rawBody);
    const started = await fixture.uploads.begin(
      {
        requestKey: "equal-original",
        original: {
          fileName: "legacy.pdf",
          sizeBytes: bytes.length,
          mediaType: "application/pdf",
          format: "PDF",
          lastModified: 90,
        },
      },
      fixture.context,
    );
    await fixture.uploads.putChunk(
      {
        uploadHandle: started.uploadHandle,
        ordinal: 0,
        requestKey: "equal-part",
        body: new Blob([new Uint8Array(bytes)]).stream(),
      },
      fixture.context,
    );
    const ready = await fixture.uploads.complete(
      started.uploadHandle,
      fixture.context,
    );
    candidate.artifacts.push({
      role: "exact-original",
      source: {
        type: "upload",
        uploadHandle: started.uploadHandle,
        digest: ready.artifact.digest,
        sizeBytes: ready.artifact.sizeBytes,
        mediaType: ready.artifact.mediaType,
      },
    });
    candidate.observation = {
      ...candidate.observation,
      originalArtifact: "observed",
      original: {
        artifactRole: "exact-original",
        digest: ready.artifact.digest,
        sizeBytes: ready.artifact.sizeBytes,
        mediaType: ready.artifact.mediaType,
      },
    };
    const signer = createRecoverySigner(fixture);
    const prepared = await prepareRecoveryPackage(
      fixture.input,
      fixture.context,
      { ...fixture, signer },
    );
    const descriptor = prepared.versions[0]?.artifacts[2];
    if (!descriptor) throw Error("FIXTURE");
    expect((await fixture.archive.get(descriptor.object))?.bytes).toEqual(
      bytes,
    );
    expect(descriptor.digest).toBe(
      prepared.versions[0]?.artifacts[representation === "snapshot" ? 0 : 1]
        ?.digest,
    );
  },
);

it.each(["missing", "not_applicable"])(
  "R2 shared consumer round trips honest %s observation",
  async (state) => {
    const fixture = await domainFixture(
      undefined,
      state === "missing" ? artifactBaselinePlan() : baselinePlan(),
    );
    const signer = createRecoverySigner(fixture);
    const prepared = await prepareRecoveryPackage(
      fixture.input,
      fixture.context,
      { ...fixture, signer },
    );
    const schema = recoverySchemas.preparedEnvelopeSchema;
    if (!schema) throw Error("FIXTURE");
    expect(validateSchema(schema, prepared)).toEqual(prepared);
  },
);
