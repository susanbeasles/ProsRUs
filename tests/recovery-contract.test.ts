import { base64url, CompactSign, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import * as canonical from "../src/domain/recovery-canonical";
import * as recovery from "../src/domain/recovery";

const workspace = { ownerId: "owner", workspaceId: "workspace" };
const locator = {
  workspaceId: "workspace",
  lineageId: "lineage",
  formatVersion: 1,
  namespace: "recovery",
  archives: [{ provider: "primary", namespace: "recovery" }],
  trustRootIds: ["root-key"],
};
const input = {
  requestKey: "request",
  lineageId: "lineage",
  entityId: "resume",
  kind: "resume",
  expectedParentIds: [],
  branchRequested: false,
  content: "  Résumé\r\n",
  sourceVersionIds: [],
};
const manifest = {
  schemaVersion: 1,
  canonicalizationVersion: "jcs-rfc8785-v1",
  hashAlgorithm: "sha256-domain-v1",
  workspace,
  epochId: "epoch",
  sequence: "1",
  transactionId: "transaction",
  versionId: "version",
  lineageId: "lineage",
  entityId: "resume",
  kind: "resume",
  parentVersionIds: [],
  branchRequested: false,
  sourceVersionIds: [],
  recordSnapshot: { text: input.content },
  artifacts: [],
  approval: { state: "draft", evidenceVersionIds: [] },
  actorId: "owner",
  createdAt: 1000,
  generationRecipe: null,
  recoveryLocator: locator,
};

describe("canonical recovery identity", () => {
  it("exports the new recovery operations", () => {
    expect(canonical.canonicalizeEnvelope).toBeTypeOf("function");
    expect(recovery.saveVersionInputSchema).toBeDefined();
  });
  it("hashes reordered properties equally without reordering arrays", async () => {
    expect(await canonical.hashEnvelope("manifest", { a: 1, b: 2 })).toBe(
      await canonical.hashEnvelope("manifest", { b: 2, a: 1 }),
    );
    expect(await canonical.hashEnvelope("manifest", [1, 2])).not.toBe(
      await canonical.hashEnvelope("manifest", [2, 1]),
    );
  });
  it("uses RFC 8785 primitive serialization and UTF-16 property ordering", () => {
    const bytes = canonical.canonicalizeEnvelope({
      "😀": 1,
      "\uE000": 2,
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27, -0],
      controls: "\u000F\n",
    });
    expect(new TextDecoder().decode(bytes)).toBe(
      '{"controls":"\\u000f\\n","numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27,0],"😀":1,"\uE000":2}',
    );
  });
  it("hashes exact blob bytes separately from structured metadata", async () => {
    const bytes = new Uint8Array([0, 13, 10, 255]);
    const copy = bytes.slice();
    const digest = await canonical.hashArtifact(bytes);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toBe(
      await canonical.hashArtifact(new Uint8Array([0, 10, 255])),
    );
    expect(digest).not.toBe(
      await canonical.hashEnvelope("manifest", [0, 13, 10, 255]),
    );
    expect(bytes).toEqual(copy);
  });
  it("separates every metadata purpose and rejects unknown or binary purposes", async () => {
    const purposes = [
      "manifest",
      "transaction",
      "preparation",
      "commit",
      "checkpoint",
      "receipt",
      "inventory",
      "epoch_transition",
      "request",
    ];
    const digests = await Promise.all(
      purposes.map((purpose) => canonical.hashEnvelope(purpose, { a: 1 })),
    );
    expect(new Set(digests).size).toBe(purposes.length);
    await expect(canonical.hashEnvelope("unknown", {})).rejects.toThrow(
      "INVALID_RECOVERY_PURPOSE",
    );
    await expect(canonical.hashEnvelope("blob", {})).rejects.toThrow(
      "INVALID_RECOVERY_PURPOSE",
    );
  });
  it("distinguishes absent properties from null and preserves source strings", async () => {
    expect(await canonical.hashEnvelope("manifest", {})).not.toBe(
      await canonical.hashEnvelope("manifest", { a: null }),
    );
    expect(await canonical.hashEnvelope("manifest", "é")).not.toBe(
      await canonical.hashEnvelope("manifest", "e\u0301"),
    );
    expect(
      new TextDecoder().decode(
        canonical.canonicalizeEnvelope({ source: "  text\r\n" }),
      ),
    ).toBe('{"source":"  text\\r\\n"}');
    expect(input.content).toBe("  Résumé\r\n");
  });
  it.each([
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"nested":{"a":1,"a":2}}',
    '{"__proto__":1,"__proto__":2}',
  ])("rejects duplicate JSON keys before parsing: %s", (text) => {
    expect(() => canonical.parseEnvelopeJson(text)).toThrow(
      "DUPLICATE_JSON_KEY",
    );
  });
  it("allows the same key in different objects and parses inert prototype names", () => {
    expect(canonical.parseEnvelopeJson('[{"a":1},{"a":2}]')).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
    const parsed = canonical.parseEnvelopeJson(
      '{"__proto__":{"polluted":true}}',
    );
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(
      true,
    );
    expect(canonical.canonicalizeEnvelope(parsed)).toEqual(
      new TextEncoder().encode('{"__proto__":{"polluted":true}}'),
    );
  });
  it.each(['"\\ud800"', '"\\udc00"', '{"\\ud800":0}', '"\ud800"'])(
    "rejects invalid Unicode: %s",
    (text) => {
      expect(() => canonical.parseEnvelopeJson(text)).toThrow(
        "INVALID_UNICODE",
      );
    },
  );
  it("rejects invalid Unicode in constructed strings and property names", () => {
    expect(() => canonical.canonicalizeEnvelope({ a: "\ud800" })).toThrow(
      "INVALID_UNICODE",
    );
    expect(() => canonical.canonicalizeEnvelope({ "\udc00": 1 })).toThrow(
      "INVALID_UNICODE",
    );
    expect(canonical.parseEnvelopeJson('"\\ud83d\\ude00"')).toBe("😀");
  });
  it.each([NaN, Infinity, -Infinity])(
    "rejects nonfinite input %s",
    (number) => {
      expect(() => canonical.canonicalizeEnvelope({ number })).toThrow(
        "NONFINITE_JSON_NUMBER",
      );
    },
  );
  it("rejects overflowing JSON numbers and malformed grammar", () => {
    expect(() => canonical.parseEnvelopeJson('{"a":1e400}')).toThrow(
      "NONFINITE_JSON_NUMBER",
    );
    for (const text of [
      '{"a":1,}',
      "[1,]",
      "01",
      "{}false",
      '{"a" 1}',
      '"\\x00"',
    ]) {
      expect(() => canonical.parseEnvelopeJson(text)).toThrow("INVALID_JSON");
    }
  });
  it("rejects non-JSON values rather than silently discarding or coercing them", () => {
    for (const value of [
      { a: undefined },
      [undefined],
      new Date(),
      { a: 1n },
      [, 1],
      new Map(),
      { a: () => 1 },
    ]) {
      expect(() => canonical.canonicalizeEnvelope(value)).toThrow(
        "INVALID_JSON_VALUE",
      );
    }
    const getter = Object.defineProperty({}, "a", {
      enumerable: true,
      get: () => {
        throw new Error("must not execute");
      },
    });
    expect(() => canonical.canonicalizeEnvelope(getter)).toThrow(
      "INVALID_JSON_VALUE",
    );
    expect(() =>
      canonical.canonicalizeEnvelope({ [Symbol("hidden")]: 1 }),
    ).toThrow("INVALID_JSON_VALUE");
  });
  it("bounds JSON size, depth, and cycles without mutating source objects", () => {
    expect(() =>
      canonical.parseEnvelopeJson(JSON.stringify("x".repeat(128 * 1024))),
    ).toThrow("ENVELOPE_TOO_LARGE");
    expect(() =>
      canonical.canonicalizeEnvelope("x".repeat(128 * 1024)),
    ).toThrow("ENVELOPE_TOO_LARGE");
    expect(() =>
      canonical.parseEnvelopeJson("[".repeat(65) + "0" + "]".repeat(65)),
    ).toThrow("JSON_DEPTH_EXCEEDED");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonical.canonicalizeEnvelope(cyclic)).toThrow(
      "CYCLIC_JSON_VALUE",
    );
    const value = Object.freeze({ b: 2, a: Object.freeze([1, null]) });
    expect(
      new TextDecoder().decode(canonical.canonicalizeEnvelope(value)),
    ).toBe('{"a":[1,null],"b":2}');
  });
});

describe("frozen caller and lineage contracts", () => {
  it("preserves exact content and accepts exactly one of direct content and upload handle", () => {
    expect(recovery.saveVersionInputSchema.parse(input).content).toBe(
      input.content,
    );
    const { content: _content, ...withoutContent } = input;
    expect(
      recovery.saveVersionInputSchema.safeParse({
        ...withoutContent,
        uploadHandle: "upload",
      }).success,
    ).toBe(true);
    expect(
      recovery.saveVersionInputSchema.safeParse(withoutContent).success,
    ).toBe(false);
    expect(
      recovery.saveVersionInputSchema.safeParse({
        ...input,
        uploadHandle: "upload",
      }).success,
    ).toBe(false);
    expect(
      recovery.saveVersionInputSchema.safeParse({
        ...input,
        content: undefined,
      }).success,
    ).toBe(false);
    expect(
      recovery.saveVersionInputSchema.safeParse({ ...input, content: null })
        .success,
    ).toBe(true);
    expect(_content).toBe(input.content);
  });
  it.each([
    "ownerId",
    "workspaceId",
    "actorId",
    "epochId",
    "sequence",
    "createdAt",
    "transactionId",
    "grantRevision",
  ])("rejects caller-issued server field %s", (field) => {
    expect(
      recovery.saveVersionInputSchema.safeParse({ ...input, [field]: "forged" })
        .success,
    ).toBe(false);
  });
  it("rejects duplicate references and malformed content without normalizing strings", () => {
    expect(
      recovery.saveVersionInputSchema.safeParse({
        ...input,
        expectedParentIds: ["a", "a"],
      }).success,
    ).toBe(false);
    expect(
      recovery.saveVersionInputSchema.safeParse({
        ...input,
        content: { text: "\ud800" },
      }).success,
    ).toBe(false);
    expect(
      recovery.saveVersionInputSchema.safeParse({
        ...input,
        content: { number: NaN },
      }).success,
    ).toBe(false);
  });
  it("validates manifest identity and high-precision sequence strings", () => {
    expect(recovery.versionManifestSchema.safeParse(manifest).success).toBe(
      true,
    );
    expect(
      recovery.versionManifestSchema.safeParse({
        ...manifest,
        sequence: "9007199254740993",
      }).success,
    ).toBe(true);
    expect(
      recovery.versionManifestSchema.safeParse({ ...manifest, sequence: 1 })
        .success,
    ).toBe(false);
    expect(
      recovery.versionManifestSchema.safeParse({ ...manifest, sequence: "01" })
        .success,
    ).toBe(false);
    expect(
      recovery.versionManifestSchema.safeParse({
        ...manifest,
        schemaVersion: 2,
      }).success,
    ).toBe(false);
  });
  it("rejects self-links, duplicate parents, implicit branches and locator mismatch", () => {
    for (const invalid of [
      { ...manifest, parentVersionIds: ["version"] },
      { ...manifest, sourceVersionIds: ["version"] },
      { ...manifest, parentVersionIds: ["parent", "parent"] },
      { ...manifest, parentVersionIds: ["a", "b"] },
      { ...manifest, branchRequested: true },
      { ...manifest, recoveryLocator: { ...locator, workspaceId: "other" } },
      { ...manifest, recoveryLocator: { ...locator, lineageId: "other" } },
    ]) {
      expect(() =>
        recovery.validateLineage(invalid as recovery.VersionManifest),
      ).toThrow("INVALID_LINEAGE");
    }
    expect(() =>
      recovery.validateLineage({
        ...manifest,
        parentVersionIds: ["a", "b"],
        branchRequested: true,
      } as recovery.VersionManifest),
    ).not.toThrow();
  });
  it("rejects recovery URLs, bearer material and paths outside the archive namespace", () => {
    for (const key of [
      "../outside",
      "/absolute",
      "https://evil.example/file",
      "file?token=secret",
      "a//b",
    ]) {
      expect(
        recovery.archiveObjectRefSchema.safeParse({
          provider: "primary",
          namespace: "recovery",
          key,
          versionId: null,
        }).success,
      ).toBe(false);
    }
    expect(
      recovery.recoveryLocatorSchema.safeParse({ ...locator, token: "secret" })
        .success,
    ).toBe(false);
  });
  it("keeps primary save and draft approval separate from independent protection", () => {
    const result = {
      versionId: "version",
      transactionId: "transaction",
      digest: "a".repeat(64),
      statusUrl: "/versions/version/protection",
      status: "saved_primary",
      protection: "protection_pending",
    };
    expect(recovery.saveVersionResultSchema.safeParse(result).success).toBe(
      true,
    );
    expect(
      recovery.saveVersionResultSchema.safeParse({
        ...result,
        protection: "verified_both",
      }).success,
    ).toBe(false);
    expect(
      recovery.protectionViewSchema.safeParse({
        versionId: "version",
        documentApproval: "draft",
        primarySave: "saved_primary",
        replication: "verified_both",
        integrity: "verified",
        retentionEvidence: [],
        lastCheckedAt: 1000,
        freshnessKnown: true,
      }).success,
    ).toBe(true);
  });
});

describe("standard JOSE purpose binding", () => {
  it("cannot validate a manifest signature as a commit and binds payload, key, algorithm and versions", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const value = { versionId: "version" };
    const binding = {
      schemaVersion: 1,
      canonicalizationVersion: "jcs-rfc8785-v1",
      hashAlgorithm: "sha256-domain-v1",
      purpose: "manifest",
      digest: await canonical.hashEnvelope("manifest", value),
    };
    const signature: recovery.RecoverySignature = {
      keyId: "test-key",
      algorithm: "ES256",
      jws: await new CompactSign(canonical.canonicalizeEnvelope(binding))
        .setProtectedHeader({
          alg: "ES256",
          kid: "test-key",
          typ: "job-stack-recovery+jws",
        })
        .sign(privateKey),
    };
    const trust = { keyId: "test-key", algorithm: "ES256" as const, publicKey };
    await expect(
      canonical.verifyRecoverySignature(signature, "manifest", value, trust),
    ).resolves.toBeUndefined();
    await expect(
      canonical.verifyRecoverySignature(signature, "commit", value, trust),
    ).rejects.toThrow("SIGNATURE_PURPOSE_MISMATCH");
    await expect(
      canonical.verifyRecoverySignature(
        signature,
        "manifest",
        { versionId: "altered" },
        trust,
      ),
    ).rejects.toThrow("SIGNATURE_DIGEST_MISMATCH");
    await expect(
      canonical.verifyRecoverySignature(signature, "manifest", value, {
        ...trust,
        keyId: "other",
      }),
    ).rejects.toThrow("SIGNATURE_POLICY_MISMATCH");
    await expect(
      canonical.verifyRecoverySignature(signature, "manifest", value, {
        ...trust,
        algorithm: "PS256",
      }),
    ).rejects.toThrow("SIGNATURE_POLICY_MISMATCH");
  });
});

const signatureFixture = {
  keyId: "test-key",
  algorithm: "ES256",
  jws: "a.b.c",
};
const resultFixture = {
  versionId: "version",
  transactionId: "transaction",
  digest: "a".repeat(64),
  statusUrl: "/versions/version/protection",
  status: "saved_primary",
  protection: "protection_pending",
};
const preparedFixture = {
  schemaVersion: 1,
  canonicalizationVersion: "jcs-rfc8785-v1",
  hashAlgorithm: "sha256-domain-v1",
  purpose: "preparation",
  workspace,
  epochId: "epoch",
  sequence: "1",
  previousTransactionDigest: null,
  transactionId: "transaction",
  requestKey: "request",
  requestDigest: "b".repeat(64),
  actorId: "owner",
  issuer: "control",
  audience: "job-stack",
  grant: {
    id: "grant",
    revision: "1",
    scopes: ["write"],
    resourceBounds: [{ kind: "resume", id: "resume" }],
    expiresAt: 2000,
  },
  createdAt: 1000,
  versions: [manifest],
  events: [],
  expectedHeads: [
    { lineageId: "lineage", parentVersionIds: [], branchRequested: false },
  ],
  objects: [],
  sourceDescriptors: [],
  packageObject: {
    provider: "primary",
    namespace: "recovery",
    key: "packages/transaction",
    versionId: null,
  },
  result: resultFixture,
  signature: signatureFixture,
};
const checkpointFixture = {
  schemaVersion: 1,
  canonicalizationVersion: "jcs-rfc8785-v1",
  hashAlgorithm: "sha256-domain-v1",
  workspace,
  epochId: "epoch",
  sequence: "1",
  transactionDigest: "a".repeat(64),
  inventoryDigest: "b".repeat(64),
  checkedAt: 1000,
};

describe("server-bound recovery evidence", () => {
  it("rejects prepared envelopes with inconsistent identity, heads or source closure", () => {
    expect(
      recovery.preparedEnvelopeSchema.safeParse(preparedFixture).success,
    ).toBe(true);
    for (const invalid of [
      { ...preparedFixture, workspace: { ...workspace, ownerId: "other" } },
      { ...preparedFixture, epochId: "other" },
      { ...preparedFixture, actorId: "other" },
      { ...preparedFixture, sequence: "0" },
      { ...preparedFixture, versions: [manifest, manifest] },
      { ...preparedFixture, expectedHeads: [] },
      { ...preparedFixture, untrustedField: [] },
      {
        ...preparedFixture,
        result: { ...resultFixture, transactionId: "other" },
      },
    ])
      expect(recovery.preparedEnvelopeSchema.safeParse(invalid).success).toBe(
        false,
      );
  });
  it("requires every artifact descriptor in the prepared closure", () => {
    const artifact = {
      schemaVersion: 1,
      hashAlgorithm: "sha256-domain-v1",
      digest: "c".repeat(64),
      sizeBytes: 3,
      mediaType: "text/plain",
      object: {
        provider: "primary",
        namespace: "recovery",
        key: "blobs/content",
        versionId: null,
      },
    };
    const withArtifact = {
      ...preparedFixture,
      versions: [{ ...manifest, artifacts: [artifact] }],
      objects: [artifact],
    };
    expect(
      recovery.preparedEnvelopeSchema.safeParse(withArtifact).success,
    ).toBe(true);
    expect(
      recovery.preparedEnvelopeSchema.safeParse({
        ...withArtifact,
        objects: [],
      }).success,
    ).toBe(false);
    expect(
      recovery.preparedEnvelopeSchema.safeParse({
        ...withArtifact,
        objects: [{ ...artifact, sizeBytes: 4 }],
      }).success,
    ).toBe(false);
  });
  it("requires independently bound receipt/checkpoint evidence from both destinations", () => {
    const receipt = {
      ...checkpointFixture,
      purpose: "receipt",
      verifiedAt: 1000,
      verifierId: "verifier",
      signature: signatureFixture,
      checkpoint: checkpointFixture,
      observations: ["primary", "replica"].map((provider) => ({
        object: {
          provider,
          namespace: "recovery",
          key: "blobs/content",
          versionId: null,
        },
        digest: "c".repeat(64),
        sizeBytes: 3,
        verifiedAt: 1000,
      })),
      retentionEvidence: [],
    };
    const { checkedAt: _checkedAt, ...withoutCheckedAt } = receipt;
    expect(
      recovery.protectionReceiptSchema.safeParse(withoutCheckedAt).success,
    ).toBe(true);
    expect(
      recovery.protectionReceiptSchema.safeParse({
        ...withoutCheckedAt,
        observations: receipt.observations.slice(0, 1),
      }).success,
    ).toBe(false);
    expect(
      recovery.protectionReceiptSchema.safeParse({
        ...withoutCheckedAt,
        checkpoint: { ...checkpointFixture, epochId: "other" },
      }).success,
    ).toBe(false);
    expect(
      recovery.protectionReceiptSchema.safeParse({
        ...withoutCheckedAt,
        observations: receipt.observations.map((observation) => ({
          ...observation,
          verifiedAt: 1001,
        })),
      }).success,
    ).toBe(false);
    expect(_checkedAt).toBe(1000);
  });
  it("rejects claims of complete restoration with gaps, quarantine or outbound effects", () => {
    const report = {
      runId: "run",
      restoredVersionCount: 1,
      restoredBlobCount: 1,
      restoredBytes: 3,
      unexplainedMissingCount: 0,
      suppressedVersionIds: [],
      quarantinedIds: [],
      checkpoint: checkpointFixture,
      freshnessKnown: true,
      startedAt: 1000,
      completedAt: 2000,
      status: "complete",
      outboundEffects: 0,
    };
    expect(recovery.recoveryReportSchema.safeParse(report).success).toBe(true);
    for (const invalid of [
      { ...report, unexplainedMissingCount: 1 },
      { ...report, quarantinedIds: ["version"] },
      { ...report, outboundEffects: 1 },
      { ...report, checkpoint: null },
    ])
      expect(recovery.recoveryReportSchema.safeParse(invalid).success).toBe(
        false,
      );
  });
  it("rejects content, secrets and uncontrolled provider errors in lifecycle audit", () => {
    const event = {
      ...checkpointFixture,
      eventId: "event",
      requestId: "request",
      transactionId: "transaction",
      actorId: "owner",
      grantId: "grant",
      grantRevision: "1",
      resourceIds: ["version"],
      operation: "save",
      serverTime: 1000,
      digests: ["a".repeat(64)],
      fromState: null,
      toState: "saved_primary",
      leaseOwner: null,
      fence: null,
      attempt: 0,
      providerRequestRef: null,
      errorCategory: null,
      verificationResult: "unchecked",
      restoreDecision: null,
      outcome: "saved_primary",
    };
    const {
      transactionDigest: _transactionDigest,
      inventoryDigest: _inventoryDigest,
      checkedAt: _checkedAt,
      ...valid
    } = event;
    expect(recovery.auditEventSchema.safeParse(valid).success).toBe(true);
    for (const extra of [
      { rawContent: "resume" },
      { token: "secret" },
      { errorCategory: "private\nerror" },
      { providerRequestRef: "https://provider/file?token=secret" },
    ])
      expect(
        recovery.auditEventSchema.safeParse({ ...valid, ...extra }).success,
      ).toBe(false);
    expect([_transactionDigest, _inventoryDigest, _checkedAt]).toHaveLength(3);
  });
  it("distinguishes archived pursuit approval from live resolved opportunity authority", () => {
    const approval = {
      approvalVersionId: "approval-version",
      opportunityId: "opportunity",
      approvedBy: "owner",
      approvedAt: 1000,
      decision: "pursue",
      scope: {
        correspondence: true,
        scheduling: true,
        conversationIds: ["conversation"],
        calendarIds: ["calendar"],
      },
      expiresAt: 2000,
      revokedAt: null,
    };
    expect(
      recovery.pursuitApprovalEvidenceSchema.safeParse(approval).success,
    ).toBe(true);
    expect(
      recovery.currentPursuitAuthorizationSchema.safeParse(approval).success,
    ).toBe(false);
    const current = {
      opportunityId: "opportunity",
      approvalVersionId: "approval-version",
      actorId: "owner",
      resolvedAt: 1100,
      validUntil: 2000,
      scope: approval.scope,
      authority: "current_resolver",
    };
    expect(
      recovery.currentPursuitAuthorizationSchema.safeParse(current).success,
    ).toBe(true);
    expect(
      recovery.currentPursuitAuthorizationSchema.safeParse({
        scopes: ["send", "schedule"],
        resourceBounds: [{ kind: "opportunity", id: "opportunity" }],
      }).success,
    ).toBe(false);
    expect(
      recovery.currentPursuitAuthorizationSchema.safeParse({
        providerReceiptId: "old-receipt",
        opportunityId: "opportunity",
      }).success,
    ).toBe(false);
    expect(
      recovery.currentPursuitAuthorizationSchema.safeParse({
        ...current,
        validUntil: 1000,
      }).success,
    ).toBe(false);
  });
});

describe("complete preparation and trusted context boundaries", () => {
  it("requires owner-bound source recovery descriptors for every referenced version", () => {
    const sourceManifest = {
      ...manifest,
      sourceVersionIds: ["source-version"],
    };
    const source = {
      versionId: "source-version",
      workspace,
      epochId: "epoch",
      lineageId: "source-lineage",
      manifestDigest: "d".repeat(64),
      recoveryLocator: { ...locator, lineageId: "source-lineage" },
    };
    const prepared = {
      ...preparedFixture,
      versions: [sourceManifest],
      sourceDescriptors: [source],
    };
    expect(recovery.preparedEnvelopeSchema.safeParse(prepared).success).toBe(
      true,
    );
    expect(
      recovery.preparedEnvelopeSchema.safeParse({
        ...prepared,
        sourceDescriptors: [],
      }).success,
    ).toBe(false);
    expect(
      recovery.preparedEnvelopeSchema.safeParse({
        ...prepared,
        sourceDescriptors: [
          { ...source, workspace: { ...workspace, ownerId: "other" } },
        ],
      }).success,
    ).toBe(false);
  });
  it("retains complete current host identity and rejects inconsistent grant times", () => {
    const context = {
      workspace,
      actor: { id: "owner", kind: "user", scopes: ["write"], expiresAt: 2000 },
      issuer: "https://control.example",
      audience: "job-stack",
      grant: preparedFixture.grant,
      chain: {
        epochId: "epoch",
        sequence: "0",
        previousTransactionDigest: null,
      },
      serverTime: 1000,
    };
    expect(
      recovery.authenticatedRecoveryContextSchema.safeParse(context).success,
    ).toBe(true);
    expect(
      recovery.authenticatedRecoveryContextSchema.safeParse({
        ...context,
        grant: { ...context.grant, expiresAt: 1000 },
      }).success,
    ).toBe(false);
    expect(
      recovery.authenticatedRecoveryContextSchema.safeParse({
        ...context,
        actor: { ...context.actor, expiresAt: 1000 },
      }).success,
    ).toBe(false);
    expect(
      recovery.authenticatedRecoveryContextSchema.safeParse({
        ...context,
        chain: { ...context.chain, sequence: "1" },
      }).success,
    ).toBe(false);
  });
  it("requires explicit format versions in signature bindings", () => {
    const binding = {
      schemaVersion: 1,
      canonicalizationVersion: "jcs-rfc8785-v1",
      hashAlgorithm: "sha256-domain-v1",
      purpose: "manifest",
      digest: "a".repeat(64),
    };
    expect(
      recovery.recoverySignatureBindingSchema.safeParse(binding).success,
    ).toBe(true);
    expect(
      recovery.recoverySignatureBindingSchema.safeParse({
        ...binding,
        canonicalizationVersion: "unknown",
      }).success,
    ).toBe(false);
  });
});

describe("JOSE canonical and trust policy rejection", () => {
  it("rejects correctly signed but noncanonical binding bytes", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const value = { id: "version" };
    const binding = {
      schemaVersion: 1,
      canonicalizationVersion: "jcs-rfc8785-v1",
      hashAlgorithm: "sha256-domain-v1",
      purpose: "manifest",
      digest: await canonical.hashEnvelope("manifest", value),
    };
    const jws = await new CompactSign(
      new TextEncoder().encode(JSON.stringify(binding, null, 2)),
    )
      .setProtectedHeader({
        alg: "ES256",
        kid: "test-key",
        typ: "job-stack-recovery+jws",
      })
      .sign(privateKey);
    await expect(
      canonical.verifyRecoverySignature(
        { keyId: "test-key", algorithm: "ES256", jws },
        "manifest",
        value,
        { keyId: "test-key", algorithm: "ES256", publicKey },
      ),
    ).rejects.toThrow("SIGNATURE_NONCANONICAL");
  });
  it("rejects wrong format, wrong key, altered signature and duplicate signed binding keys", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const other = await generateKeyPair("ES256");
    const value = { id: "version" };
    const binding = {
      schemaVersion: 1,
      canonicalizationVersion: "jcs-rfc8785-v1",
      hashAlgorithm: "sha256-domain-v1",
      purpose: "manifest",
      digest: await canonical.hashEnvelope("manifest", value),
    };
    const header = {
      alg: "ES256",
      kid: "test-key",
      typ: "job-stack-recovery+jws",
    };
    const trust = { keyId: "test-key", algorithm: "ES256" as const, publicKey };
    const sign = async (
      payload: Uint8Array,
    ): Promise<recovery.RecoverySignature> => ({
      keyId: "test-key",
      algorithm: "ES256",
      jws: await new CompactSign(payload)
        .setProtectedHeader(header)
        .sign(privateKey),
    });
    const signature = await sign(canonical.canonicalizeEnvelope(binding));
    await expect(
      canonical.verifyRecoverySignature(signature, "manifest", value, {
        ...trust,
        publicKey: other.publicKey,
      }),
    ).rejects.toThrow();
    const parts = signature.jws.split(".");
    const altered = {
      ...signature,
      jws: `${parts[0]}.${parts[1]}.${parts[2]?.startsWith("A") ? "B" : "A"}${parts[2]?.slice(1)}`,
    };
    await expect(
      canonical.verifyRecoverySignature(altered, "manifest", value, trust),
    ).rejects.toThrow();
    await expect(
      canonical.verifyRecoverySignature(
        await sign(
          canonical.canonicalizeEnvelope({ ...binding, schemaVersion: 2 }),
        ),
        "manifest",
        value,
        trust,
      ),
    ).rejects.toThrow("SIGNATURE_POLICY_MISMATCH");
    const duplicate = new TextEncoder().encode(
      '{"schemaVersion":1,"schemaVersion":1}',
    );
    await expect(
      canonical.verifyRecoverySignature(
        await sign(duplicate),
        "manifest",
        value,
        trust,
      ),
    ).rejects.toThrow("DUPLICATE_JSON_KEY");
    await expect(
      canonical.verifyRecoverySignature(signature, "manifest", value, {
        ...trust,
        publicKey: privateKey,
      }),
    ).rejects.toThrow("SIGNATURE_POLICY_MISMATCH");
  });
});

it("rejects duplicate keys in a valid standard JWS protected header", async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const value = { id: "version" };
  const payload = canonical.canonicalizeEnvelope({
    schemaVersion: 1,
    canonicalizationVersion: "jcs-rfc8785-v1",
    hashAlgorithm: "sha256-domain-v1",
    purpose: "manifest",
    digest: await canonical.hashEnvelope("manifest", value),
  });
  // Test-owned RFC 7515 ES256 signing input; production never receives this key.
  const header = base64url.encode(
    '{"alg":"ES256","alg":"ES256","kid":"test-key","typ":"job-stack-recovery+jws"}',
  );
  const signingInput = `${header}.${base64url.encode(payload)}`;
  const bytes = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  const jws = `${signingInput}.${base64url.encode(new Uint8Array(bytes))}`;
  await expect(
    canonical.verifyRecoverySignature(
      { keyId: "test-key", algorithm: "ES256", jws },
      "manifest",
      value,
      { keyId: "test-key", algorithm: "ES256", publicKey },
    ),
  ).rejects.toThrow("DUPLICATE_JSON_KEY");
});

const reviewArtifact = {
  schemaVersion: 1,
  hashAlgorithm: "sha256-domain-v1",
  digest: "c".repeat(64),
  sizeBytes: 3,
  mediaType: "text/plain",
  object: {
    provider: "primary",
    namespace: "recovery",
    key: "blobs/content",
    versionId: null,
  },
};
const reviewPrepared = {
  ...preparedFixture,
  versions: [{ ...manifest, artifacts: [reviewArtifact] }],
  objects: [reviewArtifact],
};
const reviewObservations = ["primary", "replica"].map((provider) => ({
  object: {
    provider,
    namespace: "recovery",
    key: "blobs/content",
    versionId: null,
  },
  digest: reviewArtifact.digest,
  sizeBytes: 3,
  verifiedAt: 1000,
}));
const reviewReceipt = {
  schemaVersion: 1,
  canonicalizationVersion: "jcs-rfc8785-v1",
  hashAlgorithm: "sha256-domain-v1",
  purpose: "receipt",
  workspace,
  epochId: "epoch",
  sequence: "1",
  transactionDigest: "a".repeat(64),
  inventoryDigest: "b".repeat(64),
  checkpoint: checkpointFixture,
  observations: reviewObservations,
  retentionEvidence: [],
  verifierId: "verifier",
  verifiedAt: 1000,
  signature: signatureFixture,
};

describe("review I1 primary package and artifact locations", () => {
  it.each([
    { provider: "replica", namespace: "recovery" },
    { provider: "primary", namespace: "unlisted" },
  ])(
    "rejects package location outside applicable primary archives: %j",
    (location) => {
      expect(
        recovery.preparedEnvelopeSchema.safeParse(reviewPrepared).success,
      ).toBe(true);
      expect(
        recovery.preparedEnvelopeSchema.safeParse({
          ...reviewPrepared,
          packageObject: { ...reviewPrepared.packageObject, ...location },
        }).success,
      ).toBe(false);
    },
  );
  it("rejects replica artifact references even when declared and present in package objects", () => {
    const artifact = {
      ...reviewArtifact,
      object: { ...reviewArtifact.object, provider: "replica" },
    };
    const version = {
      ...manifest,
      artifacts: [artifact],
      recoveryLocator: {
        ...locator,
        archives: [
          ...locator.archives,
          { provider: "replica", namespace: "recovery" },
        ],
      },
    };
    expect(
      recovery.preparedEnvelopeSchema.safeParse({
        ...preparedFixture,
        versions: [version],
        objects: [artifact],
      }).success,
    ).toBe(false);
  });
  it("requires the package namespace to be declared by every affected lineage", () => {
    const other = {
      ...manifest,
      versionId: "other-version",
      lineageId: "other-lineage",
      entityId: "other-entity",
      recoveryLocator: {
        ...locator,
        lineageId: "other-lineage",
        archives: [{ provider: "primary", namespace: "other-namespace" }],
      },
    };
    expect(
      recovery.preparedEnvelopeSchema.safeParse({
        ...preparedFixture,
        versions: [manifest, other],
        expectedHeads: [
          ...preparedFixture.expectedHeads,
          {
            lineageId: "other-lineage",
            parentVersionIds: [],
            branchRequested: false,
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("rejects undeclared package-only object locations", () => {
    const artifact = {
      ...reviewArtifact,
      object: { ...reviewArtifact.object, namespace: "unlisted" },
    };
    expect(
      recovery.preparedEnvelopeSchema.safeParse({
        ...preparedFixture,
        objects: [artifact],
      }).success,
    ).toBe(false);
  });
});

describe("review I2 immutable physical descriptor consistency", () => {
  it.each([
    { digest: "d".repeat(64) },
    { sizeBytes: 4 },
    { mediaType: "application/pdf" },
  ])(
    "rejects conflicting descriptors at the same exact reference: %j",
    (difference) => {
      const conflicting = { ...reviewArtifact, ...difference };
      expect(
        recovery.preparedEnvelopeSchema.safeParse({
          ...reviewPrepared,
          versions: [{ ...manifest, artifacts: [reviewArtifact, conflicting] }],
          objects: [reviewArtifact, conflicting],
        }).success,
      ).toBe(false);
    },
  );
  it("compares media type as part of the complete artifact descriptor", () => {
    expect(
      recovery.preparedEnvelopeSchema.safeParse({
        ...reviewPrepared,
        objects: [{ ...reviewArtifact, mediaType: "application/pdf" }],
      }).success,
    ).toBe(false);
  });
  it("accepts identical descriptor reuse without adding an extra physical object", () => {
    expect(
      recovery.preparedEnvelopeSchema.safeParse({
        ...reviewPrepared,
        versions: [
          { ...manifest, artifacts: [reviewArtifact, reviewArtifact] },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("review I3 exact deduplicated receipt inventories", () => {
  it.each([{ digest: "d".repeat(64) }, { sizeBytes: 4 }, { verifiedAt: 999 }])(
    "rejects contradictory observations of one exact physical reference: %j",
    (difference) => {
      const primary = { ...reviewObservations[0] };
      const replica = { ...reviewObservations[1] };
      expect(
        recovery.protectionReceiptSchema.safeParse({
          ...reviewReceipt,
          observations: [
            primary,
            { ...primary, ...difference },
            replica,
            {
              ...replica,
              ...difference,
              object: { ...reviewObservations[1]?.object, key: "blobs/other" },
            },
          ],
        }).success,
      ).toBe(false);
    },
  );
  it("rejects many-to-one provider matches with an unmatched replica artifact", () => {
    const primary = reviewObservations[0];
    const replica = reviewObservations[1];
    expect(
      recovery.protectionReceiptSchema.safeParse({
        ...reviewReceipt,
        observations: [
          primary,
          { ...primary, object: { ...primary?.object, key: "blobs/alias" } },
          replica,
          {
            ...replica,
            digest: "d".repeat(64),
            object: { ...replica?.object, key: "blobs/unmatched" },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("deduplicates repeated identical observations before comparing logical provider inventories", () => {
    expect(
      recovery.protectionReceiptSchema.safeParse({
        ...reviewReceipt,
        observations: [...reviewObservations, reviewObservations[0]],
      }).success,
    ).toBe(true);
  });
  it("accepts append-version copies of the same logical artifact with exact physical evidence", () => {
    const replica = reviewObservations[1];
    expect(
      recovery.protectionReceiptSchema.safeParse({
        ...reviewReceipt,
        observations: [
          ...reviewObservations,
          {
            ...replica,
            object: { ...replica?.object, versionId: "second-file-id" },
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("review I4 exact candidate/head bijection", () => {
  it("rejects two candidates in one lineage paired with an unrelated expected head", () => {
    expect(
      recovery.preparedEnvelopeSchema.safeParse({
        ...preparedFixture,
        versions: [manifest, { ...manifest, versionId: "second-version" }],
        expectedHeads: [
          ...preparedFixture.expectedHeads,
          {
            lineageId: "unrelated-lineage",
            parentVersionIds: [],
            branchRequested: false,
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("rejects duplicate expected heads even if both candidates match their repeated lineage", () => {
    expect(
      recovery.preparedEnvelopeSchema.safeParse({
        ...preparedFixture,
        versions: [manifest, { ...manifest, versionId: "second-version" }],
        expectedHeads: [
          ...preparedFixture.expectedHeads,
          ...preparedFixture.expectedHeads,
        ],
      }).success,
    ).toBe(false);
  });
  it("accepts one candidate per lineage with exactly one head predicate each", () => {
    const other = {
      ...manifest,
      versionId: "other-version",
      lineageId: "other-lineage",
      entityId: "other-entity",
      recoveryLocator: { ...locator, lineageId: "other-lineage" },
    };
    expect(
      recovery.preparedEnvelopeSchema.safeParse({
        ...preparedFixture,
        versions: [manifest, other],
        expectedHeads: [
          ...preparedFixture.expectedHeads,
          {
            lineageId: "other-lineage",
            parentVersionIds: [],
            branchRequested: false,
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("review I5 lossless shared principal provenance", () => {
  const actorIds = ["client:client123", "access-owner:owner@example.com"];
  it.each(actorIds)(
    "preserves the canonical actor %s through context, preparation and revision",
    (actorId) => {
      const actor = {
        id: actorId,
        kind: "user",
        scopes: ["write"],
        expiresAt: 2000,
      };
      const context = {
        workspace,
        actor,
        issuer: "https://control.example",
        audience: "job-stack",
        grant: preparedFixture.grant,
        chain: {
          epochId: "epoch",
          sequence: "0",
          previousTransactionDigest: null,
        },
        serverTime: 1000,
      };
      const parsed =
        recovery.authenticatedRecoveryContextSchema.safeParse(context);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.actor.id).toBe(actorId);
        expect(parsed.data.workspace.ownerId).toBe("owner");
      }
      const prepared = recovery.preparedEnvelopeSchema.safeParse({
        ...preparedFixture,
        actorId,
        versions: [{ ...manifest, actorId }],
      });
      expect(prepared.success).toBe(true);
      if (prepared.success) expect(prepared.data.actorId).toBe(actorId);
      expect(
        recovery.domainRevisionInputSchema.safeParse({
          requestKey: "request",
          kind: "resume",
          entityId: "resume",
          lineageId: "lineage",
          body: {},
          expectedRevision: null,
          actor,
        }).success,
      ).toBe(true);
    },
  );
  it("preserves distinct client actor and owner-issuer provenance in archived grant evidence", () => {
    const grant = {
      ...preparedFixture.grant,
      issuerPrincipalId: "access-owner:owner@example.com",
    };
    const parsed = recovery.preparedEnvelopeSchema.safeParse({
      ...preparedFixture,
      actorId: "client:client123",
      grant,
      versions: [{ ...manifest, actorId: "client:client123" }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.actorId).toBe("client:client123");
      expect(parsed.data.grant).toMatchObject({
        issuerPrincipalId: "access-owner:owner@example.com",
      });
    }
  });
  it.each(actorIds)(
    "accepts canonical actor %s in audit and opportunity authority provenance",
    (actorId) => {
      const audit = {
        schemaVersion: 1,
        canonicalizationVersion: "jcs-rfc8785-v1",
        hashAlgorithm: "sha256-domain-v1",
        workspace,
        eventId: "event",
        requestId: "request",
        transactionId: "transaction",
        actorId,
        grantId: "grant",
        grantRevision: "1",
        resourceIds: ["version"],
        operation: "save",
        serverTime: 1000,
        epochId: "epoch",
        sequence: "1",
        digests: [],
        fromState: null,
        toState: "saved_primary",
        leaseOwner: null,
        fence: null,
        attempt: 0,
        providerRequestRef: null,
        errorCategory: null,
        verificationResult: "unchecked",
        restoreDecision: null,
        outcome: "saved_primary",
      };
      expect(recovery.auditEventSchema.safeParse(audit).success).toBe(true);
      const scope = {
        correspondence: true,
        scheduling: false,
        conversationIds: [],
        calendarIds: [],
      };
      expect(
        recovery.currentPursuitAuthorizationSchema.safeParse({
          opportunityId: "opportunity",
          approvalVersionId: "approval",
          actorId,
          resolvedAt: 1000,
          validUntil: 2000,
          scope,
          authority: "current_resolver",
        }).success,
      ).toBe(true);
      expect(
        recovery.pursuitApprovalEvidenceSchema.safeParse({
          approvalVersionId: "approval",
          opportunityId: "opportunity",
          approvedBy: actorId,
          approvedAt: 1000,
          decision: "pursue",
          scope,
          expiresAt: 2000,
          revokedAt: null,
        }).success,
      ).toBe(true);
    },
  );
  it("keeps resource IDs narrow and malformed principal identities rejected", () => {
    // Reviewed shared-auth v1 CanonicalId preserves internal spaces losslessly.
    const canonicalActor = "client:a b";
    expect(
      recovery.versionManifestSchema.parse({
        ...manifest,
        actorId: canonicalActor,
      }).actorId,
    ).toBe(canonicalActor);
    for (const id of [
      "client:",
      "access-owner:invalid",
      "access-owner:Owner@example.com",
      "client:" + "x".repeat(300),
    ]) {
      expect(
        recovery.versionManifestSchema.safeParse({ ...manifest, actorId: id })
          .success,
      ).toBe(false);
    }
    expect(
      recovery.versionManifestSchema.safeParse({
        ...manifest,
        versionId: "client:client123",
      }).success,
    ).toBe(false);
  });
});

it("review M1 detaches Buffer content from its caller-owned backing memory", () => {
  const bytes = Buffer.from([1, 2, 3]);
  const parsed = recovery.saveVersionInputSchema.parse({
    ...input,
    content: bytes,
  });
  bytes[0] = 9;
  expect(parsed.content).toEqual(new Uint8Array([1, 2, 3]));
  expect(Buffer.isBuffer(parsed.content)).toBe(false);
});
