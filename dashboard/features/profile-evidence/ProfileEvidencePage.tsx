import { PendingChanges, Unavailable, WriteAction } from "../../components/Actions";
import { CardsSkeleton, EmptyState, NotEnabled, Skeleton } from "../../components/Feedback";
import { BackLink, DetailHeading, PageHeader, ViewTabs } from "../../components/Layout";
import { QueryView } from "../../components/QueryView";
import { RecordBody, RecordIdentity } from "../../components/RecordBody";
import { RecordList } from "../../components/RecordList";
import { RouteLink, useRoute } from "../../app/context";
import { pageRoute } from "../../app/router";
import { objectFields, type ReadRecord } from "../../lib/api";
import { firstText } from "../../lib/format";
import { useQuery } from "../../lib/hooks";
import { recordRevision } from "../../lib/opportunity";
import { reads } from "../../lib/queries";
import {
  addClaimSpec,
  claimEntity,
  resolveConflictSpec,
  reviewClaimSpec,
  type AddClaimValues,
  type ResolveConflictValues,
  type ReviewClaimValues,
} from "./specs";

const PROFILE_RECORD = /^([a-z_]{1,40}):([A-Za-z0-9_-]{1,100})$/;

export default function ProfileEvidencePage() {
  const route = useRoute();
  if (route.record) {
    if (route.view === "conflicts") return <ConflictDetail entityId={route.record} />;
    if (route.view === "profile") {
      const match = PROFILE_RECORD.exec(route.record);
      return match?.[1] && match[2] ? <ProfileRecordDetail kind={match[1]} entityId={match[2]} /> : <ClaimDetail entityId={route.record} />;
    }
    return <ClaimDetail entityId={route.record} />;
  }
  return (
    <>
      <PageHeader eyebrow="PROFILE & EVIDENCE" title="Claims before applications." actions={<AddClaim />}>
        <p>Claims begin unverified. Review source conflicts before allowing a claim in an application.</p>
      </PageHeader>
      <ViewTabs label="Profile views" labels={{ claims: "Claims", profile: "Profile records", conflicts: "Conflicts" }} />
      {route.view === "profile" ? <ProfileList /> : route.view === "conflicts" ? <ConflictList /> : <ClaimList />}
      <NotEnabled title="Profile export">
        Export is not enabled in this dashboard. It requires a reviewed profile change set and the private-export path, which this
        dashboard does not invoke.
      </NotEnabled>
    </>
  );
}

function AddClaim() {
  return (
    <WriteAction<AddClaimValues>
      operation="job_stack_add_claim"
      label="Add claim"
      title="Add a career claim"
      description="Write the exact claim. It starts unverified and is not used in applications until reviewed and permitted."
      overrides={{
        field: { help: "For example: achievement, phone, education or employment dates." },
        text: { widget: "textarea" },
        sourceIds: { help: "Evidence record IDs, one per line. Leave empty if there is no evidence yet." },
      }}
      spec={addClaimSpec}
      primary
      submitLabel="Add claim"
    />
  );
}

function ClaimList() {
  const route = useRoute();
  const state = useQuery(reads.records("claim", route.cursor));
  return (
    <QueryView
      state={state}
      loading={<CardsSkeleton label="Loading claims…" />}
      isEmpty={(page) => page.items.length === 0}
      empty={<EmptyState title="No claims yet">Add the exact claims you are prepared to stand behind.</EmptyState>}
    >
      {(page) => (
        <RecordList
          page={page}
          label="Claims"
          linkTo={(item) => ({ ...route, record: item.entityId })}
          describe={(item, body) => ({
            title: firstText(body, ["field"]) ?? item.entityId,
            detail: firstText(body, ["text"]),
            badge: firstText(body, ["status"]),
          })}
        />
      )}
    </QueryView>
  );
}

function ProfileList() {
  const route = useRoute();
  const state = useQuery(reads.profile(route.cursor));
  return (
    <QueryView
      state={state}
      loading={<CardsSkeleton label="Loading profile records…" />}
      isEmpty={(page) => page.items.length === 0}
      empty={<EmptyState title="No profile records">Profile sources, evidence and snapshots appear here once imported.</EmptyState>}
    >
      {(page) => (
        <RecordList
          page={page}
          label="Profile records"
          linkTo={(item) => ({ ...route, record: item.kind + ":" + item.entityId })}
          describe={(item, body) => ({
            title: firstText(body, ["name", "field", "title"]) ?? item.entityId,
            detail: item.kind.replaceAll("_", " "),
            badge: firstText(body, ["status"]),
          })}
        />
      )}
    </QueryView>
  );
}

function ConflictList() {
  const route = useRoute();
  const state = useQuery(reads.records("question", route.cursor));
  return (
    <QueryView
      state={state}
      loading={<CardsSkeleton label="Loading questions…" />}
      isEmpty={(page) => page.items.length === 0}
      empty={<EmptyState title="No open questions">Profile conflicts found in your sources appear here.</EmptyState>}
    >
      {(page) => (
        <RecordList
          page={page}
          label="Questions and profile conflicts"
          linkTo={(item) => ({ ...route, record: item.entityId })}
          describe={(item, body) => ({
            title: firstText(body, ["field", "subject"]) ?? item.entityId,
            detail: body?.type === "profile_conflict" ? "Profile conflict" : null,
            badge: firstText(body, ["status"]),
          })}
        />
      )}
    </QueryView>
  );
}

function ClaimDetail({ entityId }: { entityId: string }) {
  const state = useQuery(reads.record("claim", entityId));
  return (
    <QueryView state={state} loading={<Skeleton label="Loading the selected claim…" />}>
      {(row) => {
        const body = row.bodyStatus === "available" ? objectFields(row.body) : {};
        return (
          <section className="panel detail">
            <BackLink>All claims</BackLink>
            <DetailHeading eyebrow="CLAIM">{firstText(body, ["field"]) ?? row.entityId}</DetailHeading>
            <RecordIdentity row={row} />
            <RecordBody
              row={row}
              fields={[
                ["text", "Exact claim"],
                ["status", "Evidence status"],
                ["permitted", "Permitted in applications"],
                ["sourceIds", "Evidence IDs"],
                ["flags", "Review flags"],
              ]}
            />
            <div className="actions">
              <ReviewClaim row={row} />
            </div>
            <PendingChanges entity={claimEntity(row.entityId)} />
          </section>
        );
      }}
    </QueryView>
  );
}

function ReviewClaim({ row }: { row: ReadRecord }) {
  const revision = recordRevision(row);
  if (row.origin !== "domain_record" || row.bodyStatus !== "available" || revision === null)
    return <Unavailable label="Review claim" reason="this claim has no available body or current revision." />;
  const body = objectFields(row.body);
  return (
    <WriteAction<ReviewClaimValues>
      operation="job_stack_review_claim"
      label="Review claim"
      title="Review this claim"
      description="Mark how the claim is supported and whether it may appear in applications."
      overrides={{ id: { fixed: row.entityId }, revision: { fixed: revision } }}
      initial={{ status: body.status, permitted: body.permitted }}
      spec={reviewClaimSpec}
      submitLabel="Save review"
    />
  );
}

function ConflictDetail({ entityId }: { entityId: string }) {
  const route = useRoute();
  const state = useQuery(reads.record("question", entityId));
  return (
    <QueryView state={state} loading={<Skeleton label="Loading the selected question…" />}>
      {(row) => {
        const body = row.bodyStatus === "available" ? objectFields(row.body) : {};
        const conflict = body.type === "profile_conflict";
        return (
          <section className="panel detail">
            <BackLink>All questions</BackLink>
            <DetailHeading eyebrow={conflict ? "PROFILE CONFLICT" : "QUESTION"}>{firstText(body, ["field", "subject"]) ?? row.entityId}</DetailHeading>
            <RecordIdentity row={row} />
            <RecordBody row={row} fields={[["values", "Conflicting values"], ["status", "Status"]]} />
            {conflict ? (
              <div className="actions">
                <WriteAction<ResolveConflictValues>
                  operation="job_stack_resolve_profile_conflict"
                  label="Confirm correct value"
                  title="Resolve this profile conflict"
                  overrides={{ questionId: { fixed: row.entityId }, value: { widget: "textarea" }, reason: { widget: "textarea" } }}
                  spec={resolveConflictSpec}
                  submitLabel="Resolve"
                />
              </div>
            ) : (
              <p className="notice">
                This is not a profile conflict.{" "}
                <RouteLink to={pageRoute(route.grant, "conversations", { view: "messages", record: row.entityId })}>
                  Associate it in Conversations
                </RouteLink>
                .
              </p>
            )}
            <PendingChanges entity={"question:" + row.entityId} />
          </section>
        );
      }}
    </QueryView>
  );
}

function ProfileRecordDetail({ kind, entityId }: { kind: string; entityId: string }) {
  const state = useQuery(reads.record(kind, entityId));
  return (
    <QueryView state={state} loading={<Skeleton label="Loading the selected profile record…" />}>
      {(row) => (
        <section className="panel detail">
          <BackLink>All profile records</BackLink>
          <DetailHeading eyebrow={kind.replaceAll("_", " ").toUpperCase()}>{row.entityId}</DetailHeading>
          <RecordIdentity row={row} />
          <RecordBody row={row} fields={[["name", "Name"], ["status", "Status"]]} />
        </section>
      )}
    </QueryView>
  );
}
