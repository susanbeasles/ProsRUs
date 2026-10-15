import { describe, expect, it } from "vitest";
import { COMMAND_REGISTRY } from "../src/application/commands/registry";
import { operationById } from "../integration/shared-contract.mjs";
import {
  captureBody,
  commandHarness,
  legacyOpportunity,
  settingsBody,
} from "./fixtures/command-harness";

type Harness = Awaited<ReturnType<typeof commandHarness>>;
type Saved = { entityId: string; save: { transactionId: string } };
const CAPTURE = "job-stack.opportunity.capture.v1";
async function capture(h: Harness) {
  return (await h.invoke(CAPTURE, {
    requestKey: "setup-capture",
    body: captureBody,
  })) as Saved;
}
/** Commits any prerequisite baseline (one invocation) so the measured call is
 * the single public mutation batch. */
async function baselined(h: Harness, operationId: string, input: object) {
  await expect(h.invoke(operationId, input as never)).rejects.toThrow(
    "domain-baseline-committed-retry",
  );
}
const interview = {
  id: "interview-1",
  opportunityId: "legacy-op",
  threadId: "thread-1",
  start: 10000,
  end: 13600,
  title: "Interview",
  attendee: "recruiter@example.com",
  eventId: "event-1",
  status: "scheduled",
  calendarId: "calendar",
};
type Case = Readonly<{
  operationId: string;
  setup: (h: Harness) => Promise<Record<string, unknown>>;
}>;
const cases: Case[] = [
  {
    operationId: "job-stack.claim.add.v1",
    setup: async () => ({
      body: { field: "experience", text: "Built", sourceIds: [], permitted: true },
    }),
  },
  {
    operationId: "job-stack.claim.review.v1",
    setup: async (h) => {
      const claim = (await h.invoke("job-stack.claim.add.v1", {
        requestKey: "setup-claim",
        body: { field: "experience", text: "Built", sourceIds: [], permitted: true },
      })) as Saved;
      return {
        body: {
          id: claim.entityId,
          revision: 1,
          status: "user_confirmed",
          permitted: true,
        },
      };
    },
  },
  {
    operationId: "job-stack.profile.conflict.resolve.v1",
    setup: async (h) => {
      h.seed("question", "conflict-1", {
        type: "profile_conflict",
        field: "phone",
        values: [],
        status: "unresolved",
        nextAction: "Confirm",
      });
      const input = {
        body: { questionId: "conflict-1", value: "confirmed", reason: "Owner" },
      };
      await baselined(h, "job-stack.profile.conflict.resolve.v1", {
        requestKey: "measured",
        ...input,
      });
      return input;
    },
  },
  {
    operationId: CAPTURE,
    setup: async () => ({ body: captureBody }),
  },
  {
    operationId: "job-stack.opportunity.assess.v1",
    setup: async (h) => ({
      body: {
        id: (await capture(h)).entityId,
        revision: 1,
        terms: { ...captureBody.terms, remote: false },
      },
    }),
  },
  {
    operationId: "job-stack.opportunity.transition.v1",
    setup: async (h) => ({
      body: {
        id: (await capture(h)).entityId,
        revision: 1,
        state: "qualified",
        evidence: "Verified",
        confirmed: false,
      },
    }),
  },
  {
    operationId: "job-stack.conversation.capture.v1",
    setup: async (h) => ({
      body: {
        opportunityId: (await capture(h)).entityId,
        recipient: "recruiter@example.com",
        subject: "Role",
        message: "Hello",
      },
    }),
  },
  {
    operationId: "job-stack.conversation.associate.v1",
    setup: async (h) => {
      const op = await capture(h);
      h.seed("question", "mail-1", {
        providerThreadId: "provider-thread",
        recipient: "recruiter@example.com",
        subject: "Interview",
        preview: "Hello",
        flags: [],
        status: "unassociated",
      });
      const input = { body: { questionId: "mail-1", opportunityId: op.entityId } };
      await baselined(h, "job-stack.conversation.associate.v1", {
        requestKey: "measured",
        ...input,
      });
      return input;
    },
  },
  {
    operationId: "job-stack.conversation.draft.save.v1",
    setup: async (h) => {
      const thread = (await h.invoke("job-stack.conversation.capture.v1", {
        requestKey: "setup-thread",
        body: {
          opportunityId: (await capture(h)).entityId,
          recipient: "recruiter@example.com",
          subject: "Role",
          message: "Hello",
        },
      })) as Saved;
      return { body: { threadId: thread.entityId, revision: 1, body: "Draft" } };
    },
  },
  {
    operationId: "job-stack.interview.prepare.v1",
    setup: async (h) => {
      h.seed("opportunity", "legacy-op", legacyOpportunity("legacy-op", "interviewing"));
      h.seed("interview", "interview-1", interview);
      const input = { body: { interviewId: "interview-1" } };
      await baselined(h, "job-stack.interview.prepare.v1", {
        requestKey: "measured",
        ...input,
      });
      return input;
    },
  },
  {
    operationId: "job-stack.offer.record.v1",
    setup: async (h) => {
      h.seed("opportunity", "legacy-op", legacyOpportunity("legacy-op", "interviewing"));
      const input = {
        body: {
          opportunityId: "legacy-op",
          baseUsd: 1,
          bonusUsd: 0,
          equityUsd: 0,
          equityType: "none",
          notes: "Written offer",
        },
      };
      await baselined(h, "job-stack.offer.record.v1", {
        requestKey: "measured",
        ...input,
      });
      return input;
    },
  },
  {
    operationId: "job-stack.settings.update.v1",
    setup: async () => ({ body: { ...settingsBody, revision: 0 } }),
  },
  {
    operationId: "job-stack.version.save.v1",
    setup: async () => ({
      lineageId: "lineage-resume",
      entityId: "resume-1",
      kind: "resume",
      expectedParentIds: [],
      sourceVersionIds: [],
      branchRequested: false,
      content: { text: "Synthetic" },
    }),
  },
];
function counts(h: Harness) {
  return {
    recovery_transactions: h.sqlite.count("recovery_transactions"),
    recovery_outbox: h.sqlite.count("recovery_outbox"),
    recovery_request_results: h.sqlite.count("recovery_request_results"),
    records: h.sqlite.count("records"),
    audit: h.sqlite.count("audit"),
  };
}

describe("every committed local-write is captured for backup", () => {
  it("covers exactly the enabled local-write commands", () => {
    const enabled = Object.entries(COMMAND_REGISTRY)
      .filter(
        ([id, decision]) =>
          decision.state === "available" &&
          operationById(id)?.effect === "local-write",
      )
      .map(([id]) => id)
      .sort();
    expect(cases.map((c) => c.operationId).sort()).toEqual(enabled);
  });

  it.each(cases)(
    "$operationId: before-ack denial leaves no transaction; success adds exactly one transaction and its outbox job in one batch",
    async ({ operationId, setup }) => {
      const h = await commandHarness();
      const input = { requestKey: "measured", ...(await setup(h)) };
      const before = counts(h),
        batches = h.sqlite.batches.length;
      h.control.setDeny(({ stage }) => stage === "before-ack");
      await expect(h.invoke(operationId, input)).rejects.toThrow(
        "operation-denied",
      );
      expect(counts(h)).toEqual(before);
      expect(
        h.sqlite.batches
          .slice(batches)
          .some((b) => b.some((sql) => sql.includes("recovery_transactions"))),
      ).toBe(false);
      h.control.reset();
      const result = (await h.invoke(operationId, input)) as
        | Saved
        | { transactionId: string };
      expect(h.control.violations).toEqual([]);
      const after = counts(h);
      expect(after.recovery_transactions).toBe(before.recovery_transactions + 1);
      expect(after.recovery_outbox).toBe(before.recovery_outbox + 1);
      expect(after.recovery_request_results).toBe(
        before.recovery_request_results + 1,
      );
      const transactionId =
        "save" in result ? result.save.transactionId : result.transactionId;
      expect(
        h.rows(
          "SELECT t.transaction_id,o.job_id,o.stage,o.state,r.request_key FROM recovery_transactions t JOIN recovery_outbox o ON o.owner=t.owner AND o.workspace_id=t.workspace_id AND o.transaction_id=t.transaction_id JOIN recovery_request_results r ON r.owner=t.owner AND r.workspace_id=t.workspace_id AND r.transaction_id=t.transaction_id WHERE t.transaction_id=?",
          transactionId,
        ),
      ).toEqual([
        {
          transaction_id: transactionId,
          job_id: transactionId,
          stage: "primary_journal",
          state: "pending",
          request_key: "measured",
        },
      ]);
      const commits = h.sqlite.batches
        .slice(batches)
        .filter((b) =>
          b.some((sql) => sql.startsWith("INSERT INTO recovery_transactions")),
        );
      expect(commits).toHaveLength(1);
      const [batch = []] = commits;
      expect(batch.some((sql) => sql.startsWith("INSERT INTO recovery_outbox"))).toBe(true);
      expect(
        batch.some((sql) => sql.startsWith("INSERT INTO recovery_request_results")),
      ).toBe(true);
      if (operationId !== "job-stack.version.save.v1")
        expect(
          batch.some(
            (sql) =>
              sql.startsWith("INSERT INTO records") ||
              sql.startsWith("UPDATE records"),
          ),
        ).toBe(true);
      // The request ledger agrees with the authoritative recovery result.
      const [ledger] = h.rows(
        "SELECT state,result FROM command_requests WHERE request_key='measured'",
      );
      const [recovery] = h.rows(
        "SELECT result FROM recovery_request_results WHERE request_key='measured'",
      );
      expect(ledger?.state).toBe("committed");
      const released = JSON.parse(String(ledger?.result));
      expect("save" in released ? released.save : released).toEqual(
        JSON.parse(String(recovery?.result)),
      );
    },
  );
});
