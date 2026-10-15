import { PendingChanges, Unavailable, WriteAction } from "../../components/Actions";
import { CardsSkeleton, EmptyState, NotEnabled, Skeleton } from "../../components/Feedback";
import { BackLink, DetailHeading, PageHeader, ViewTabs } from "../../components/Layout";
import { OpportunityChoices } from "../../components/Options";
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
  associateSpec,
  captureConversationSpec,
  questionEntity,
  saveDraftSpec,
  threadEntity,
  type AssociateValues,
  type CaptureConversationValues,
  type DraftValues,
} from "./specs";

export default function ConversationsPage() {
  const route = useRoute();
  const messages = route.view === "messages";
  if (route.record) return messages ? <MessageDetail entityId={route.record} /> : <ThreadDetail entityId={route.record} />;
  return (
    <>
      <PageHeader eyebrow="RECRUITING CONVERSATIONS" title="Conversations" actions={<CaptureConversation />}>
        <p>Conversations you captured, drafts you saved and recruiting messages waiting to be associated. Nothing is sent from this dashboard.</p>
      </PageHeader>
      <ViewTabs label="Conversation views" labels={{ threads: "Conversations", messages: "Messages to associate" }} />
      {messages ? <MessageList /> : <ThreadList />}
    </>
  );
}

export function SendingNotEnabled() {
  return (
    <NotEnabled title="Sending replies">
      Sending is not enabled. The shared catalog has no send operation, so this dashboard cannot deliver email. Saved drafts stay in
      this workspace and are never sent to a recipient.
    </NotEnabled>
  );
}

function CaptureConversation() {
  return (
    <WriteAction<CaptureConversationValues>
      operation="job_stack_capture_conversation"
      label="Capture conversation"
      title="Capture a recruiting conversation"
      description="Records a message you received. It does not grant permission to reply or contact anyone."
      overrides={{ message: { widget: "textarea" } }}
      Loader={OpportunityChoices}
      spec={captureConversationSpec}
      primary
      submitLabel="Capture"
    />
  );
}

function ThreadList() {
  const route = useRoute();
  const state = useQuery(reads.records("thread", route.cursor));
  return (
    <QueryView
      state={state}
      loading={<CardsSkeleton label="Loading conversations…" />}
      isEmpty={(page) => page.items.length === 0}
      empty={<EmptyState title="No conversations yet">Capture a recruiting message to keep its thread, drafts and opportunity together.</EmptyState>}
    >
      {(page) => (
        <RecordList
          page={page}
          label="Conversations"
          linkTo={(item) => ({ ...route, record: item.entityId })}
          describe={(item, body) => ({
            title: firstText(body, ["subject"]) ?? item.entityId,
            detail: firstText(body, ["recipient"]),
            badge: firstText(body, ["status"]),
          })}
        />
      )}
    </QueryView>
  );
}

function MessageList() {
  const route = useRoute();
  const state = useQuery(reads.records("question", route.cursor));
  return (
    <QueryView
      state={state}
      loading={<CardsSkeleton label="Loading recruiting messages…" />}
      isEmpty={(page) => page.items.length === 0}
      empty={<EmptyState title="Nothing to associate">Recruiting messages that need an opportunity will appear here.</EmptyState>}
    >
      {(page) => (
        <RecordList
          page={page}
          label="Recruiting messages and questions"
          linkTo={(item) => ({ ...route, record: item.entityId })}
          describe={(item, body) => ({
            title: firstText(body, ["subject", "field"]) ?? item.entityId,
            detail: firstText(body, ["preview", "nextAction"]),
            badge: firstText(body, ["status"]),
          })}
        />
      )}
    </QueryView>
  );
}

function ThreadDetail({ entityId }: { entityId: string }) {
  const state = useQuery(reads.record("thread", entityId));
  return (
    <QueryView state={state} loading={<Skeleton label="Loading the selected conversation…" />}>
      {(row) => {
        const body = row.bodyStatus === "available" ? objectFields(row.body) : {};
        return (
          <section className="panel detail">
            <BackLink>All conversations</BackLink>
            <DetailHeading eyebrow="CONVERSATION">{firstText(body, ["subject"]) ?? row.entityId}</DetailHeading>
            <RecordIdentity row={row} />
            <RecordBody
              row={row}
              fields={[
                ["recipient", "Recruiter"],
                ["status", "Status"],
                ["opportunityId", "Opportunity"],
                ["draft", "Saved draft"],
              ]}
            />
            <div className="actions">
              <SaveDraft row={row} />
            </div>
            <SendingNotEnabled />
            <PendingChanges entity={threadEntity(row.entityId)} />
          </section>
        );
      }}
    </QueryView>
  );
}

function SaveDraft({ row }: { row: ReadRecord }) {
  const revision = recordRevision(row);
  if (row.origin !== "domain_record" || row.bodyStatus !== "available" || revision === null)
    return <Unavailable label="Save draft reply" reason="this conversation has no available body or current revision." />;
  const body = objectFields(row.body);
  return (
    <WriteAction<DraftValues>
      operation="job_stack_save_draft"
      label="Save draft reply"
      title="Draft a reply"
      description="Drafts are stored in this workspace only. Sending is not enabled."
      overrides={{ threadId: { fixed: row.entityId }, revision: { fixed: revision }, body: { widget: "textarea" } }}
      initial={{ body: typeof body.draft === "string" ? body.draft : "" }}
      spec={saveDraftSpec}
      submitLabel="Save draft"
    />
  );
}

function MessageDetail({ entityId }: { entityId: string }) {
  const route = useRoute();
  const state = useQuery(reads.record("question", entityId));
  return (
    <QueryView state={state} loading={<Skeleton label="Loading the selected message…" />}>
      {(row) => {
        const body = row.bodyStatus === "available" ? objectFields(row.body) : {};
        const conflict = body.type === "profile_conflict";
        return (
          <section className="panel detail">
            <BackLink>All messages</BackLink>
            <DetailHeading eyebrow="RECRUITING MESSAGE">{firstText(body, ["subject", "field"]) ?? row.entityId}</DetailHeading>
            <RecordIdentity row={row} />
            <RecordBody
              row={row}
              fields={[
                ["preview", "Preview"],
                ["status", "Status"],
                ["opportunityId", "Opportunity"],
              ]}
            />
            {conflict ? (
              <p className="notice">
                This is a profile conflict.{" "}
                <RouteLink to={pageRoute(route.grant, "profile", { view: "conflicts", record: row.entityId })}>Resolve it in Profile &amp; evidence</RouteLink>.
              </p>
            ) : body.status === "associated" ? (
              <p className="muted">Associated with an opportunity.</p>
            ) : row.bodyStatus === "available" ? (
              <div className="actions">
                <WriteAction<AssociateValues>
                  operation="job_stack_associate_conversation"
                  label="Associate with opportunity"
                  title="Associate this message"
                  overrides={{ questionId: { fixed: row.entityId } }}
                  Loader={OpportunityChoices}
                  spec={associateSpec}
                  submitLabel="Associate"
                />
              </div>
            ) : null}
            <PendingChanges entity={questionEntity(row.entityId)} />
          </section>
        );
      }}
    </QueryView>
  );
}
