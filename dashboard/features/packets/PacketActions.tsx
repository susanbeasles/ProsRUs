import { WriteAction } from "../../components/Actions";
import { ClaimChoices, combineLoaders, OpportunityChoices, PacketChoices } from "../../components/Options";
import type { Overrides } from "../../lib/schemaForm";
import { createPacketSpec, recordSubmissionSpec, type CreatePacketValues, type SubmissionValues } from "./specs";

const OpportunityAndClaimChoices = combineLoaders(OpportunityChoices, ClaimChoices);
const OpportunityAndPacketChoices = combineLoaders(OpportunityChoices, PacketChoices);

export function CreatePacketAction({ opportunityId, primary = false }: { opportunityId?: string; primary?: boolean }) {
  return (
    <WriteAction<CreatePacketValues>
      operation="job_stack_create_packet"
      label="Create packet"
      title="Create an application packet"
      description="A packet assembles permitted claims into a résumé and cover note inside this workspace. Nothing is sent."
      overrides={opportunityId ? { opportunityId: { fixed: opportunityId } } : undefined}
      Loader={opportunityId ? ClaimChoices : OpportunityAndClaimChoices}
      spec={createPacketSpec}
      primary={primary}
      submitLabel="Create packet"
    />
  );
}

export function RecordSubmissionAction({
  opportunityId,
  packetId,
  now,
}: {
  opportunityId?: string;
  packetId?: string;
  now: number;
}) {
  const overrides: Overrides = {
    ...(opportunityId ? { opportunityId: { fixed: opportunityId } } : {}),
    ...(packetId ? { packetId: { fixed: packetId } } : {}),
    receipt: { widget: "textarea", help: "Confirmation number, portal text or the receipt email you received." },
    submittedAt: { widget: "datetime" },
    confirmed: {
      label: "I submitted this application myself",
      help: "Recording a submission stores your receipt; it does not submit anything to an employer.",
    },
  };
  return (
    <WriteAction<SubmissionValues>
      operation="job_stack_record_submission"
      label="Record submission"
      title="Record an application you submitted"
      overrides={overrides}
      initial={{ submittedAt: now }}
      Loader={packetId ? (opportunityId ? undefined : OpportunityChoices) : opportunityId ? PacketChoices : OpportunityAndPacketChoices}
      spec={recordSubmissionSpec}
      submitLabel="Record submission"
    />
  );
}
