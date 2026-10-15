import { PendingChanges, WriteAction } from "../../components/Actions";
import { CardsSkeleton, EmptyState, NotEnabled, Skeleton } from "../../components/Feedback";
import { BackLink, DetailHeading, PageHeader, ViewTabs } from "../../components/Layout";
import { QueryView } from "../../components/QueryView";
import { asTime, RecordBody, RecordIdentity } from "../../components/RecordBody";
import { RecordList } from "../../components/RecordList";
import { useRoute } from "../../app/context";
import { objectFields } from "../../lib/api";
import { firstText, formatTime } from "../../lib/format";
import { useQuery } from "../../lib/hooks";
import type { MutationSpec } from "../../lib/mutations";
import { anyOf, reads, recordDetail, recordKind } from "../../lib/queries";

type PrepareValues = { interviewId: string };
const interviewEntity = (id: string) => "interview:" + id;

export function prepareSpec(values: PrepareValues): MutationSpec<PrepareValues> {
  return {
    operation: "job_stack_prepare_interview",
    entity: interviewEntity(values.interviewId),
    label: "Build preparation sheet",
    values,
    body: (v) => ({ interviewId: v.interviewId }),
    // The pending entry is the optimistic state; the preparation record's identity comes from the server.
    invalidate: anyOf(recordKind("prep"), recordDetail("interview", values.interviewId)),
  };
}

export default function InterviewsPage() {
  const route = useRoute();
  const prep = route.view === "prep";
  if (route.record) return prep ? <PrepDetail entityId={route.record} /> : <InterviewDetail entityId={route.record} />;
  return (
    <>
      <PageHeader eyebrow="INTERVIEWS" title="Interviews">
        <p>Interviews recorded in this workspace and the preparation sheets built from your records.</p>
      </PageHeader>
      <ViewTabs label="Interview views" labels={{ interviews: "Interviews", prep: "Preparation" }} />
      <SchedulingNotEnabled />
      <KindList kind={prep ? "prep" : "interview"} />
    </>
  );
}

function SchedulingNotEnabled() {
  return (
    <NotEnabled title="Scheduling, rescheduling and cancelling interviews">
      These actions need calendar and email delivery, which are not enabled. The shared catalog has no scheduling operation, so
      this dashboard never books, moves or cancels an interview. Confirm times with your recruiter directly.
    </NotEnabled>
  );
}

function KindList({ kind }: { kind: "interview" | "prep" }) {
  const route = useRoute();
  const state = useQuery(reads.records(kind, route.cursor));
  return (
    <QueryView
      state={state}
      loading={<CardsSkeleton label={kind === "prep" ? "Loading preparation sheets…" : "Loading interviews…"} />}
      isEmpty={(page) => page.items.length === 0}
      empty={
        <EmptyState title={kind === "prep" ? "No preparation sheets yet" : "No interviews recorded"}>
          {kind === "prep" ? "Build a preparation sheet from an interview." : "Interviews appear here once they are recorded in this workspace."}
        </EmptyState>
      }
    >
      {(page) => (
        <RecordList
          page={page}
          label={kind === "prep" ? "Preparation sheets" : "Interviews"}
          linkTo={(item) => ({ ...route, record: item.entityId })}
          describe={(item, body) => ({
            title: firstText(body, ["title", "role"]) ?? item.entityId,
            detail: typeof body?.start === "number" ? formatTime(body.start) : null,
            badge: firstText(body, ["status"]),
          })}
        />
      )}
    </QueryView>
  );
}

function InterviewDetail({ entityId }: { entityId: string }) {
  const state = useQuery(reads.record("interview", entityId));
  return (
    <QueryView state={state} loading={<Skeleton label="Loading the selected interview…" />}>
      {(row) => {
        const body = row.bodyStatus === "available" ? objectFields(row.body) : {};
        return (
          <section className="panel detail">
            <BackLink>All interviews</BackLink>
            <DetailHeading eyebrow="INTERVIEW">{firstText(body, ["title"]) ?? row.entityId}</DetailHeading>
            <RecordIdentity row={row} />
            <RecordBody
              row={row}
              fields={[
                ["start", "Starts"],
                ["end", "Ends"],
                ["attendee", "Attendee"],
                ["status", "Status"],
                ["opportunityId", "Opportunity"],
              ]}
              formatters={{ start: asTime, end: asTime }}
            />
            {row.bodyStatus === "available" && (
              <div className="actions">
                <WriteAction<PrepareValues>
                  operation="job_stack_prepare_interview"
                  label="Build preparation sheet"
                  title="Build a preparation sheet"
                  description="Builds a preparation sheet from your records in this workspace. It contacts no one and claims no live intelligence."
                  overrides={{ interviewId: { fixed: row.entityId } }}
                  spec={prepareSpec}
                  submitLabel="Build sheet"
                />
              </div>
            )}
            <SchedulingNotEnabled />
            <PendingChanges entity={interviewEntity(row.entityId)} />
          </section>
        );
      }}
    </QueryView>
  );
}

function PrepDetail({ entityId }: { entityId: string }) {
  const state = useQuery(reads.record("prep", entityId));
  return (
    <QueryView state={state} loading={<Skeleton label="Loading the selected preparation sheet…" />}>
      {(row) => (
        <section className="panel detail">
          <BackLink>All preparation sheets</BackLink>
          <DetailHeading eyebrow="PREPARATION">{row.entityId}</DetailHeading>
          <RecordIdentity row={row} />
          <RecordBody row={row} fields={[["interviewId", "Interview"], ["status", "Status"]]} />
        </section>
      )}
    </QueryView>
  );
}
