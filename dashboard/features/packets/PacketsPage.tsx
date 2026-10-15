import { PendingChanges } from "../../components/Actions";
import { CardsSkeleton, EmptyState, Skeleton } from "../../components/Feedback";
import { BackLink, DetailHeading, PageHeader } from "../../components/Layout";
import { QueryView } from "../../components/QueryView";
import { RecordBody, RecordIdentity } from "../../components/RecordBody";
import { RecordList } from "../../components/RecordList";
import { useRoute } from "../../app/context";
import { objectFields } from "../../lib/api";
import { firstText } from "../../lib/format";
import { useQuery, useWorkspace } from "../../lib/hooks";
import { reads } from "../../lib/queries";
import { CreatePacketAction, RecordSubmissionAction } from "./PacketActions";
import { opportunityEntity } from "./specs";

export default function PacketsPage() {
  const route = useRoute();
  if (route.record) return <PacketDetail entityId={route.record} />;
  return (
    <>
      <PageHeader eyebrow="APPLICATIONS" title="Packets" actions={<CreatePacketAction primary />}>
        <p>Application packets assembled from permitted claims, and the submissions you recorded. Nothing is sent from here.</p>
      </PageHeader>
      <PacketList />
    </>
  );
}

function PacketList() {
  const route = useRoute();
  const state = useQuery(reads.records("packet", route.cursor));
  return (
    <QueryView
      state={state}
      loading={<CardsSkeleton label="Loading packets…" />}
      isEmpty={(page) => page.items.length === 0}
      empty={<EmptyState title="No packets yet">Create a packet from confirmed, permitted claims for one opportunity.</EmptyState>}
    >
      {(page) => (
        <RecordList
          page={page}
          label="Packets"
          linkTo={(item) => ({ ...route, record: item.entityId })}
          describe={(item, body) => ({
            title: firstText(body, ["role", "company"]) ?? item.entityId,
            detail: firstText(body, ["company"]),
            badge: firstText(body, ["status"]),
          })}
        />
      )}
    </QueryView>
  );
}

function PacketDetail({ entityId }: { entityId: string }) {
  const workspace = useWorkspace();
  const state = useQuery(reads.record("packet", entityId));
  return (
    <QueryView state={state} loading={<Skeleton label="Loading the selected packet…" />}>
      {(row) => {
        const body = row.bodyStatus === "available" ? objectFields(row.body) : {};
        const opportunityId = typeof body.opportunityId === "string" ? body.opportunityId : undefined;
        return (
          <section className="panel detail">
            <BackLink>All packets</BackLink>
            <DetailHeading eyebrow="PACKET">{firstText(body, ["role"]) ?? row.entityId}</DetailHeading>
            <RecordIdentity row={row} />
            <RecordBody
              row={row}
              fields={[
                ["company", "Company"],
                ["opportunityId", "Opportunity"],
                ["status", "Status"],
                ["resume", "Résumé"],
                ["coverNote", "Cover note"],
              ]}
            />
            {row.bodyStatus === "available" && (
              <div className="actions">
                <RecordSubmissionAction packetId={row.entityId} opportunityId={opportunityId} now={workspace.services.now()} />
              </div>
            )}
            {opportunityId && <PendingChanges entity={opportunityEntity(opportunityId)} />}
          </section>
        );
      }}
    </QueryView>
  );
}
