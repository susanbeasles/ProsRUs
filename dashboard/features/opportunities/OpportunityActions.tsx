import { PendingChanges, Unavailable, WriteAction } from "../../components/Actions";
import { NotEnabled } from "../../components/Feedback";
import { label, type ReadRecord } from "../../lib/api";
import { useWorkspace } from "../../lib/hooks";
import { actionableOpportunity, allowedTransitions, requiresConfirmation } from "../../lib/opportunity";
import type { Overrides } from "../../lib/schemaForm";
import { CreatePacketAction, RecordSubmissionAction } from "../packets/PacketActions";
import { assessSpec, offerSpec, opportunityEntity, transitionSpec, type AssessValues, type OfferValues, type TransitionValues } from "./specs";

export const TERM_OVERRIDES: Overrides = {
  "terms.baseUsd": { label: "Base salary (USD)", help: "Leave blank while compensation is undisclosed." },
  "terms.hourlyUsd": { label: "Hourly rate (USD)", help: "Leave blank while the rate is undisclosed." },
};

/** Domain actions for a tracked opportunity; imported observations and archives stay read-only. */
export function OpportunityActions({ row }: { row: ReadRecord }) {
  const workspace = useWorkspace();
  const opportunity = actionableOpportunity(row);
  if (!opportunity)
    return (
      <NotEnabled title="Changes to this record">
        {row.origin === "legacy_import"
          ? "Imported observations are read-only evidence. Capture a tracked opportunity to assess terms, move it through the pipeline or record an application."
          : row.origin === "generic_archive"
            ? "Archived versions are immutable."
            : "This record has no available body or current revision, so no change can be prepared against it."}
      </NotEnabled>
    );
  const { entityId, revision, state } = opportunity;
  const next = state ? allowedTransitions(state) : [];
  const transitionOverrides: Overrides = {
    id: { fixed: entityId },
    revision: { fixed: revision },
    state: { options: next.map((value) => ({ value, label: label(value) })) },
    evidence: { widget: "textarea", help: "What happened and where it is recorded. Required for every transition." },
    confirmed: { label: "I confirm this change", help: "Required when withdrawing or declining." },
  };
  return (
    <section className="actions-panel" aria-labelledby={"actions-" + entityId}>
      <h3 id={"actions-" + entityId}>Actions</h3>
      <div className="actions">
        {state === null ? (
          <Unavailable label="Move to another state" reason="the current state of this record is not a recognized opportunity state." />
        ) : next.length === 0 ? (
          <p className="muted">No further transitions are allowed from {label(state)}.</p>
        ) : (
          <WriteAction<TransitionValues>
            operation="job_stack_transition_opportunity"
            label="Move to another state"
            title={`Move from ${label(state)}`}
            description={`Only transitions allowed from ${label(state)} are offered.`}
            overrides={transitionOverrides}
            validate={(v): Record<string, string> =>
              requiresConfirmation(v.state) && !v.confirmed ? { confirmed: "Confirmation is required to withdraw or decline." } : {}
            }
            spec={transitionSpec}
            submitLabel="Move"
            primary
          />
        )}
        <WriteAction<AssessValues>
          operation="job_stack_assess_opportunity"
          label="Assess terms"
          title="Assess employment terms"
          description="Unknown stays unknown: leave values blank or unknown until verified."
          overrides={{ id: { fixed: entityId }, revision: { fixed: revision }, ...TERM_OVERRIDES }}
          initial={{ terms: opportunity.body.terms }}
          spec={assessSpec}
        />
        <WriteAction<OfferValues>
          operation="job_stack_record_offer"
          label="Record offer"
          title="Record an offer"
          description="Records the written offer you received. It does not accept or decline anything."
          overrides={{ opportunityId: { fixed: entityId }, notes: { widget: "textarea" } }}
          spec={offerSpec}
        />
        <CreatePacketAction opportunityId={entityId} />
        <RecordSubmissionAction opportunityId={entityId} now={workspace.services.now()} />
      </div>
      <PendingChanges entity={opportunityEntity(entityId)} />
    </section>
  );
}
