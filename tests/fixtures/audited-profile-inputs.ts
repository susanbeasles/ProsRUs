import { createHash } from "node:crypto";
export const fixtureWorkspace = {
  ownerId: "fixture_profile_owner",
  workspaceId: "fixture_profile_workspace",
};
export const fixtureProfile = {
  format: "audited-source-profile-v1",
  identityMode: "profile-v2",
  workspace: fixtureWorkspace,
  seriesId: "fixture_profile_series",
  sources: {
    main: { label: "fixture-main.json" },
    outreach: { label: "fixture-contact-ledger.json" },
    coordination: { label: "fixture-coordination.json" },
    notes: { label: "fixture-notes.json" },
    recruiter_supplement: { label: "fixture-reply.json" },
  },
  sourceOrder: [
    "main",
    "outreach",
    "coordination",
    "notes",
    "recruiter_supplement",
  ],
  expectedCounts: {
    direct_opportunities: 12,
    digest_listings: 119,
    excluded_already_engaged: 4,
    post_cutoff_new_leads: 2,
    otherClassifications: 3,
  },
  recordIds: {
    strategy: "original-id-and-post-sequence-v1",
    recordPrefix: "fixture_records",
    postCutoffPrefix: "FXPOST",
    postCutoffStart: 1,
    postCutoffPadWidth: 3,
  },
  inventoryFormats: {
    base: "fixture-base-inventory-v1",
    supplement: "fixture-reply-inventory-v1",
  },
  supplementAssociation: {
    roleSourceId: "FXD003",
    originalThreadId: "fixture-original-thread",
    messages: [
      { id: "fixture-message-reply", threadId: "fixture-original-thread" },
      { id: "fixture-message-invite", threadId: "fixture-invitation-thread" },
    ],
    retrievedAt: "2020-02-03T04:00:00Z",
    displayDecision: "approval_pending",
    booking: "not_confirmed",
    specificJobDescription: "not_supplied_in_reply",
    specificCompensation: "not_supplied_in_reply",
    publicRoleMatch: "unconfirmed",
  },
};
export function fixtureSource(name: string, value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
  return {
    name,
    bytes,
    receipt: {
      name,
      rawSha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
      fixtureEvidence: { retainedUnknown: true },
    },
  };
}
export function fixtureInputs() {
  const row = (id: string) => ({
    id,
    company: "Independent fixture company",
    role: "Fixture engineering role",
    unknown: { retain: true },
  });
  const rows = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) =>
      row(prefix + String(i + 1).padStart(3, "0")),
    );
  const direct = rows("FXD", 12).map((value, i) => ({
    ...value,
    ...(i === 2
      ? {
          after_cutoff_outreach: {
            thread_id: "fixture-original-thread",
            sent_message_id: "fixture-outbound",
          },
        }
      : {}),
  }));
  return [
    fixtureSource(fixtureProfile.sources.main.label, {
      cutoff: "2020-02-01T00:00:00Z",
      direct_opportunities: direct,
      digest_listings: rows("FXL", 119),
      excluded_already_engaged: rows("FXE", 4),
      post_cutoff_new_leads: [
        { employer: "Fixture post one" },
        { employer: "Fixture post two" },
      ],
      other_classifications: [{ context: 1 }, { context: 2 }, { context: 3 }],
      coordination_runs: [
        {
          as_of: "2020-02-02T00:00:00Z",
          updates: Array.from({ length: 7 }, (_, i) => ({
            opportunity_id: "FXD" + String(i + 1).padStart(3, "0"),
            status: i === 0 ? "closed" : "Fixture historical observation",
          })),
        },
      ],
      extraRoot: { preserved: true },
    }),
    fixtureSource(fixtureProfile.sources.outreach.label, {
      actions: [],
      bookings: [],
      coordination_runs: [],
    }),
    fixtureSource(fixtureProfile.sources.coordination.label, {
      updates: [],
      new_low_priority_leads: [],
    }),
    fixtureSource(fixtureProfile.sources.notes.label, { call_notes: [] }),
  ];
}
export function fixtureSupplementedInputs() {
  const association = fixtureProfile.supplementAssociation;
  const source = fixtureSource(
    fixtureProfile.sources.recruiter_supplement.label,
    {
      retrieved_at: association.retrievedAt,
      source: "connected Gmail read_email_thread",
      purpose: "Independent synthetic fixture",
      messages: association.messages.map((message, i) => ({
        id: message.id,
        thread_id: message.threadId,
        internal_date: String(Date.parse("2020-02-03T03:00:00Z") + i * 60000),
        headers: [],
        parts: [
          {
            mime_type: i === 0 ? "text/plain" : "text/html",
            body:
              i === 0
                ? "Fixture reply"
                : '<img src="https://invalid.example/fixture"><a href="https://invalid.example/invite">Fixture invitation</a>',
          },
        ],
      })),
      interpretation: {
        approval: "Pending",
        role_match: "Unknown",
        scheduling: "Unconfirmed",
      },
    },
  );
  return [
    ...fixtureInputs(),
    {
      ...source,
      receipt: { ...source.receipt, supplementBinding: association },
    },
  ];
}
