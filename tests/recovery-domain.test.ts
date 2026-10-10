import { describe, it, expect } from "vitest";
import { prepareRecoveryPackage } from "../src/application/recovery-preparation";
import { createRecoverySigner } from "../src/identity/recovery-signing";
import {
  readBoundPrimaryPackage,
  unsignedPreparation,
} from "../src/storage/recovery-package-archive";
import { domainFixture } from "./fixtures/domain-preparation";
import { parseDomainPlan } from "../src/domain/recovery-domain-plan";
import { packetPlan } from "./fixtures/domain-preparation";
import { validateDomainEffects } from "../src/application/recovery-domain-effects";
import { baselinePlan, claimBody } from "./fixtures/domain-preparation";
import { buildPrimaryPackage } from "../src/application/recovery-package-content";
import {
  primaryInput,
  preparationFixture,
  primaryContext,
} from "./fixtures/primary-preparation";
import { hashEnvelope } from "../src/domain/recovery-canonical";
import { recoveryRequestDigest } from "../src/application/recovery-request";
import {
  recoverySchemas,
  validateSchema,
  validateCoreInput,
  CORE_SCOPES,
} from "../integration/shared-contract.mjs";
import legacyGolden from "./fixtures/recovery-domain-legacy-golden.json";
import { primaryPackageSchema } from "../src/domain/recovery-package";
import {
  canonicalizeEnvelope,
  parseEnvelopeJson,
} from "../src/domain/recovery-canonical";

describe("signed domain packages", () => {
  it("preserves the complete packet and opportunity in one independently reconstructed primary package", async () => {
    const fixture = await domainFixture();
    const signer = createRecoverySigner(fixture);
    const prepared = await prepareRecoveryPackage(
      fixture.input,
      fixture.context,
      { ...fixture, signer },
    );
    expect(prepared.versions).toHaveLength(2);
    expect(prepared.versions.map((v) => v.recordSnapshot)).toEqual(
      fixture.accepted.domainPlan.plan.candidates.map((c) => c.snapshot),
    );
    expect(prepared.result.versionId).toBe("version-packet");
    const core = await readBoundPrimaryPackage(
      fixture.archive,
      unsignedPreparation(prepared),
    );
    expect(core.manifests).toHaveLength(2);
    expect(prepared.objects).toHaveLength(3);
    await signer.verifyPreparation(prepared);
  });
});

describe("closed domain acceptance", () => {
  it.each([
    [
      "format",
      (p: Record<string, unknown>) => {
        p.format = "domain-plan-v2";
      },
    ],
    [
      "unknown field",
      (p: Record<string, unknown>) => {
        p.sql = "DELETE FROM records";
      },
    ],
  ])("rejects %s before package effects", (_name, change) => {
    const plan: Record<string, unknown> = structuredClone(packetPlan());
    change(plan);
    expect(() => parseDomainPlan(plan)).toThrow();
  });
  it("rejects executable/accessor/prototype/sparse plan input without evaluating accessors", () => {
    const plan = structuredClone(packetPlan());
    let reads = 0;
    Object.defineProperty(plan, "inputDigest", {
      enumerable: true,
      get() {
        reads++;
        return "b".repeat(64);
      },
    });
    expect(() => parseDomainPlan(plan)).toThrow("INVALID_JSON_VALUE");
    expect(reads).toBe(0);
    expect(() =>
      parseDomainPlan(
        Object.assign(Object.create({ hidden: true }), packetPlan()),
      ),
    ).toThrow("INVALID_JSON_VALUE");
    const sparse = structuredClone(packetPlan());
    delete sparse.candidates[0];
    expect(() => parseDomainPlan(sparse)).toThrow("INVALID_JSON_VALUE");
  });
  it("rejects a body key outside the full typed model and duplicated raw JSON keys", () => {
    const plan = structuredClone(packetPlan());
    const guard = plan.readSet.records.find((r) => r.state === "present");
    if (!guard || guard.state !== "present") throw Error("FIXTURE");
    guard.rawBody = '{"id":"opportunity-1","id":"opportunity-1"}';
    expect(() => parseDomainPlan(plan)).toThrow("DUPLICATE_JSON_KEY");
    const extra = structuredClone(packetPlan());
    const first = extra.candidates[0];
    if (!first) throw Error("FIXTURE");
    Object.assign(first.snapshot.body, { accessToken: "forbidden" });
    expect(() => parseDomainPlan(extra)).toThrow();
  });
  it("does not permit the next operational revision to predate its observed body", () => {
    const plan = structuredClone(packetPlan());
    const candidate = plan.candidates[1];
    if (!candidate) throw Error("FIXTURE");
    plan.candidates[1] = {
      ...candidate,
      snapshot: { ...candidate.snapshot, updatedAt: 99 },
    };
    const audit = plan.audit[1];
    if (!audit) throw Error("FIXTURE");
    audit.createdAt = 99;
    expect(() => parseDomainPlan(plan)).toThrow("DOMAIN_TIME_REGRESSION");
  });
  it("rejects a candidate unsupported approval evidence even if both lists are well formed", () => {
    const plan = structuredClone(packetPlan());
    const first = plan.candidates[0];
    if (!first) throw Error("FIXTURE");
    first.approval.evidenceVersionIds = ["undeclared"];
    expect(() => parseDomainPlan(plan)).toThrow(
      "DOMAIN_APPROVAL_SOURCE_REQUIRED",
    );
  });
  it("rejects tampering with a signed non-primary record and exact plan digest", async () => {
    const fixture = await domainFixture();
    const signer = createRecoverySigner(fixture);
    const prepared = await prepareRecoveryPackage(
      fixture.input,
      fixture.context,
      { ...fixture, signer },
    );
    const body = structuredClone(prepared);
    const second = body.versions[1];
    if (
      !second ||
      !second.recordSnapshot ||
      typeof second.recordSnapshot !== "object"
    )
      throw Error("FIXTURE");
    Object.assign(second.recordSnapshot, { revision: 88 });
    await expect(validateDomainEffects(body)).rejects.toThrow(
      "DOMAIN_CANDIDATE_MISMATCH",
    );
    const digest = structuredClone(prepared);
    if (!digest.domainEffects) throw Error("FIXTURE");
    Object.assign(digest.domainEffects, { planDigest: "f".repeat(64) });
    await expect(validateDomainEffects(digest)).rejects.toThrow(
      "DOMAIN_PLAN_DIGEST_MISMATCH",
    );
    await expect(
      signer.signPreparation(unsignedPreparation(body), fixture.context),
    ).rejects.toThrow("PREPARATION_CONTENT_MISMATCH");
  });
});

describe("archival compatibility and explicit gaps", () => {
  it("keeps generic domain-looking archival JSON inert", async () => {
    const fixture = await preparationFixture();
    const content = packetPlan().candidates[0]?.snapshot;
    const prepared = await prepareRecoveryPackage(
      { ...primaryInput, content },
      primaryContext,
      fixture,
    );
    expect(prepared.domainEffects).toBeUndefined();
    expect(Object.hasOwn(prepared, "domainEffects")).toBe(false);
    expect(prepared.versions).toHaveLength(1);
  });
  it("preserves an incomplete permitted legacy claim as explicit inert quarantine", async () => {
    const plan = structuredClone(baselinePlan());
    const guard = plan.readSet.records[0],
      candidate = plan.candidates[0];
    if (!guard || guard.state !== "present" || !candidate)
      throw Error("FIXTURE");
    const body = { id: claimBody.id, text: "Retained incomplete legacy row" };
    guard.rawBody =
      ' {"text":"Retained incomplete legacy row", "id":"claim-1"} ';
    const quarantine = {
      ...candidate.snapshot,
      type: "legacy_record_quarantine",
      reason: "incomplete_legacy_claim",
      body,
    };
    const altered = {
      ...plan,
      candidates: [{ ...candidate, snapshot: quarantine }],
    };
    const fixture = await domainFixture(undefined, parseDomainPlan(altered));
    const signer = createRecoverySigner(fixture);
    const prepared = await prepareRecoveryPackage(
      fixture.input,
      fixture.context,
      { ...fixture, signer },
    );
    expect(prepared.versions[0]?.recordSnapshot).toEqual(quarantine);
    expect(prepared.domainEffects?.plan.mutations).toEqual([]);
  });
  it("binds baseline missing-original provenance into the exact manifest", async () => {
    const fixture = await domainFixture(undefined, baselinePlan());
    const core = await buildPrimaryPackage(
      fixture.accepted,
      { archive: fixture.archive, trustRootIds: ["synthetic-primary"] },
      "persist",
    );
    expect(core.proposed.versions[0]?.generationRecipe?.parameters).toEqual(
      fixture.accepted.domainPlan.plan.candidates[0]?.observation,
    );
  });
});

describe("shared recovery schema consumer", () => {
  it("round trips the entire signed domain envelope through the generated shared projection", async () => {
    const fixture = await domainFixture();
    const signer = createRecoverySigner(fixture);
    const prepared = await prepareRecoveryPackage(
      fixture.input,
      fixture.context,
      { ...fixture, signer },
    );
    const schema = recoverySchemas.preparedEnvelopeSchema;
    if (!schema) throw Error("FIXTURE");
    expect(validateSchema(schema, prepared)).toEqual(prepared);
  });
  it.each(["offer", "question", "reminder"])(
    "adds archival %s vocabulary without caller plan authority",
    (kind) => {
      const value = { ...primaryInput, workspaceId: "workspace", kind };
      expect(validateCoreInput("job-stack.version.save.v1", value)).toEqual(
        value,
      );
      expect(() =>
        validateCoreInput("job-stack.version.save.v1", {
          ...value,
          domainPlan: packetPlan(),
        }),
      ).toThrow();
      expect(CORE_SCOPES).not.toContain(`job-stack.${kind}.activate`);
    },
  );
});

describe("historical bytes and bounded authority", () => {
  it("preserves the exact old request, payload, manifest and complete package hash goldens", async () => {
    const fixture = await preparationFixture();
    const accepted = await fixture.authority.accept(
      primaryInput,
      primaryContext,
    );
    const core = await buildPrimaryPackage(
      accepted,
      {
        archive: fixture.archive,
        trustRootIds: fixture.signer.capabilities.trustRootIds,
      },
      "persist",
    );
    expect(
      await recoveryRequestDigest(primaryInput, primaryContext.workspace, null),
    ).toBe(legacyGolden.requestDigest);
    expect(await hashEnvelope("inventory", core)).toBe(
      legacyGolden.packageDigest,
    );
    expect(await hashEnvelope("manifest", core.proposed.versions[0])).toBe(
      legacyGolden.manifestDigest,
    );
    expect(await hashEnvelope("preparation", core.proposed)).toBe(
      legacyGolden.payloadDigest,
    );
    expect(new TextDecoder().decode(canonicalizeEnvelope(core))).toBe(
      legacyGolden.coreCanonical,
    );
    const decoded = primaryPackageSchema.parse(
      parseEnvelopeJson(legacyGolden.coreCanonical),
    );
    expect(Object.hasOwn(decoded.proposed, "domainEffects")).toBe(false);
    expect(new TextDecoder().decode(canonicalizeEnvelope(decoded))).toBe(
      legacyGolden.coreCanonical,
    );
  });
  it.each(["lineage", "effect", "audit", "record", "version", "cycle"])(
    "denies duplicate or cyclic %s identity before archive effects",
    async (type) => {
      const fixture = await domainFixture();
      const bound = structuredClone(fixture.accepted.domainPlan);
      const first = bound.plan.candidates[0],
        second = bound.plan.candidates[1];
      const mutation = bound.plan.mutations[0],
        audit = bound.plan.audit[0],
        record = bound.plan.readSet.records[0],
        version = bound.candidateVersions[0],
        secondVersion = bound.candidateVersions[1];
      if (
        !first ||
        !second ||
        !mutation ||
        !audit ||
        !record ||
        !version ||
        !secondVersion
      )
        throw Error("FIXTURE");
      if (type === "lineage") second.lineageId = first.lineageId;
      if (type === "effect") bound.plan.mutations.push({ ...mutation });
      if (type === "audit") bound.plan.audit.push({ ...audit });
      if (type === "record") bound.plan.readSet.records.push({ ...record });
      if (type === "version") secondVersion.versionId = version.versionId;
      if (type === "cycle") first.sourceVersionIds = ["version-opportunity"];
      const accepted = { ...fixture.accepted, domainPlan: bound };
      await expect(
        buildPrimaryPackage(
          accepted,
          { archive: fixture.archive, trustRootIds: ["synthetic-primary"] },
          "persist",
        ),
      ).rejects.toThrow();
      expect(fixture.objects.size).toBe(0);
    },
  );
  it("rejects an oversized full plan without truncating or creating a package", async () => {
    const fixture = await domainFixture();
    const bound = structuredClone(fixture.accepted.domainPlan);
    const first = bound.plan.candidates[0];
    if (!first) throw Error("FIXTURE");
    first.artifacts.push({
      role: "oversized",
      source: {
        type: "utf8",
        mediaType: "text/plain",
        text: "x".repeat(131072),
      },
    });
    await expect(
      buildPrimaryPackage(
        { ...fixture.accepted, domainPlan: bound },
        { archive: fixture.archive, trustRootIds: ["synthetic-primary"] },
        "persist",
      ),
    ).rejects.toThrow("ENVELOPE_TOO_LARGE");
    expect(fixture.objects.size).toBe(0);
  });
  it("a producer plan cannot obtain a signature without independently resolved acceptance", async () => {
    const fixture = await domainFixture();
    const signer = createRecoverySigner(fixture);
    const prepared = await prepareRecoveryPackage(
      fixture.input,
      fixture.context,
      { ...fixture, signer },
    );
    let custodyCalls = 0;
    const denied = createRecoverySigner({
      ...fixture,
      authority: {
        ...fixture.authority,
        async resolveAccepted() {
          return null;
        },
      },
      custody: {
        ...fixture.custody,
        async signPreparation(binding) {
          custodyCalls++;
          return fixture.custody.signPreparation(binding);
        },
      },
    });
    await expect(
      denied.signPreparation(unsignedPreparation(prepared), fixture.context),
    ).rejects.toThrow("PREPARATION_NOT_ACCEPTED");
    expect(custodyCalls).toBe(0);
  });
});

it("preserves exact leading whitespace in accepted record content instead of silently normalizing it", () => {
  const plan = structuredClone(packetPlan());
  const candidate = plan.candidates[0];
  if (!candidate || candidate.snapshot.recordKind !== "packet")
    throw Error("FIXTURE");
  const claim = candidate.snapshot.body.claims[0];
  if (!claim) throw Error("FIXTURE");
  claim.text = "  Exact original claim text  ";
  const parsed = parseDomainPlan(plan);
  const saved = parsed.candidates[0];
  if (!saved || saved.snapshot.recordKind !== "packet") throw Error("FIXTURE");
  expect(saved.snapshot.body.claims[0]?.text).toBe(
    "  Exact original claim text  ",
  );
});
it("rejects duplicate accepted committed closure entries before any archive write", async () => {
  const first = await preparationFixture();
  const old = await prepareRecoveryPackage(primaryInput, primaryContext, first);
  const manifest = old.versions[0];
  if (!manifest) throw Error("FIXTURE");
  const plan = structuredClone(packetPlan());
  const primary = plan.candidates[0];
  if (!primary) throw Error("FIXTURE");
  primary.sourceVersionIds = [manifest.versionId];
  const fixture = await domainFixture(first.archive, parseDomainPlan(plan));
  fixture.accepted.sources.push(manifest, manifest);
  await expect(
    buildPrimaryPackage(
      fixture.accepted,
      { archive: fixture.archive, trustRootIds: ["synthetic-primary"] },
      "persist",
    ),
  ).rejects.toThrow("DUPLICATE_DOMAIN_CLOSURE");
});

it("the signer rejects a producer domain-effect accessor before invoking it or custody", async () => {
  const fixture = await domainFixture();
  const signer = createRecoverySigner(fixture);
  const prepared = await prepareRecoveryPackage(
    fixture.input,
    fixture.context,
    { ...fixture, signer },
  );
  const payload = structuredClone(unsignedPreparation(prepared));
  let reads = 0;
  Object.defineProperty(payload, "domainEffects", {
    enumerable: true,
    get() {
      reads++;
      return prepared.domainEffects;
    },
  });
  await expect(
    signer.signPreparation(payload, fixture.context),
  ).rejects.toThrow("INVALID_JSON_VALUE");
  expect(reads).toBe(0);
});

it("binds every non-primary effect and guard before custody signs", async () => {
  const fixture = await domainFixture();
  const signer = createRecoverySigner(fixture);
  const prepared = await prepareRecoveryPackage(
    fixture.input,
    fixture.context,
    { ...fixture, signer },
  );
  let custodyCalls = 0;
  const guarded = createRecoverySigner({
    ...fixture,
    custody: {
      ...fixture.custody,
      async signPreparation(binding) {
        custodyCalls++;
        return fixture.custody.signPreparation(binding);
      },
    },
  });
  for (const field of [
    "audit",
    "source-key",
    "predicate",
    "result",
    "artifact",
    "actor",
    "version",
  ]) {
    const payload = structuredClone(unsignedPreparation(prepared));
    const effects = payload.domainEffects;
    if (!effects) throw Error("FIXTURE");
    const candidate = effects.plan.candidates[0],
      audit = effects.plan.audit[0],
      guard = effects.plan.readSet.records[1];
    if (!candidate || !audit || !guard || guard.state !== "present")
      throw Error("FIXTURE");
    if (field === "audit") audit.eventId = "substituted-audit";
    if (field === "source-key")
      effects.plan.sourceKeys.push({
        sourceKey: "https://example.com/other",
        opportunityId: "opportunity-1",
        mode: "insert",
      });
    if (field === "predicate")
      guard.rawBody = guard.rawBody.replace("Prepare packet", "Other meaning");
    if (field === "result") effects.plan.resultRecord.revision++;
    if (field === "artifact")
      candidate.artifacts.push({
        role: "hidden",
        source: {
          type: "utf8",
          mediaType: "text/plain",
          text: "unaccepted bytes",
        },
      });
    if (field === "actor") Object.assign(effects.plan, { actorId: "other" });
    if (field === "version")
      Object.assign(effects, { format: "domain-effects-v2" });
    await expect(
      guarded.signPreparation(payload, fixture.context),
    ).rejects.toThrow();
    if (field !== "version")
      await expect(validateDomainEffects(payload)).rejects.toThrow();
  }
  expect(custodyCalls).toBe(0);
});
