import { useState } from "react";
import { WriteAction } from "../../components/Actions";
import { CardsSkeleton, EmptyState, ErrorState, errorMessage, Skeleton } from "../../components/Feedback";
import { PageHeader, ViewTabs } from "../../components/Layout";
import { QueryView } from "../../components/QueryView";
import { RecordList } from "../../components/RecordList";
import { useNavigationFocus, useRoute, useRouter } from "../../app/context";
import type { ProtectionState } from "../../lib/api";
import { firstText } from "../../lib/format";
import { useEntityMutations, useQuery } from "../../lib/hooks";
import { reads } from "../../lib/queries";
import { ObservationDetail } from "./ObservationDetail";
import { OpportunityActions, TERM_OVERRIDES } from "./OpportunityActions";
import { PipelineList } from "./PipelineList";
import { captureSpec, opportunityEntity, type CaptureValues } from "./specs";

export default function OpportunitiesPage() {
  const route = useRoute();
  return route.record ? <OpportunityDetail entityId={route.record} /> : <OpportunityLists />;
}

function CaptureAction() {
  return (
    <WriteAction<CaptureValues>
      operation="job_stack_capture_opportunity"
      label="Capture opportunity"
      title="Capture a tracked opportunity"
      description="Captures a listing you found. Source text never grants pursuit, sending or approval."
      overrides={{ ...TERM_OVERRIDES, description: { widget: "textarea" } }}
      spec={captureSpec}
      primary
      submitLabel="Capture"
    />
  );
}

function OpportunityLists() {
  const route = useRoute();
  const [query, setQuery] = useState("");
  const pipelineView = route.view === "all" ? "all" : "relationships";
  const pipeline = useQuery(route.view === "tracked" ? null : reads.pipeline(pipelineView, route.cursor));
  const page = pipeline.data?.status === "available" ? pipeline.data : null;
  const ready = pipeline.data !== undefined;
  const count = (value: number | undefined) => (ready && pipeline.data?.status === "available" ? value : "…");
  return (
    <>
      <PageHeader eyebrow="YOUR RECRUITING PIPELINE" title="Facts before next steps." actions={<CaptureAction />}>
        <p>Historical contact is not current permission. Imported observations are read-only evidence; tracked opportunities accept local changes.</p>
      </PageHeader>
      <ViewTabs
        label="Opportunity views"
        labels={{
          relationships: <>Historical relationships {route.view === "tracked" ? "" : count(page?.historicalRelationships)}</>,
          all: <>All observations {route.view === "tracked" ? "" : count(page?.totalObservations)}</>,
          tracked: "Tracked opportunities",
        }}
      />
      {route.view === "tracked" ? <TrackedOpportunities /> : <PipelineConnected query={query} setQuery={setQuery} />}
    </>
  );
}

function PipelineConnected({ query, setQuery }: { query: string; setQuery: (value: string) => void }) {
  const route = useRoute();
  const router = useRouter();
  const view = route.view === "all" ? "all" : "relationships";
  const state = useQuery(reads.pipeline(view, route.cursor));
  const page = state.data;
  if (state.status === "error" && !page) return <ErrorState message={errorMessage(state.error)} onRetry={state.refetch} />;
  return (
    <PipelineList
      records={page?.status === "available" ? page.items : []}
      complete={page !== undefined}
      total={page?.status === "available" ? page.totalObservations : 0}
      historicalRelationships={page?.status === "available" ? page.historicalRelationships : 0}
      range={page?.status === "available" ? page.range : { start: 0, end: 0 }}
      nextCursor={page?.status === "available" ? page.nextCursor : null}
      canPrevious={route.cursor !== null}
      next={() => {
        if (page?.status === "available" && page.nextCursor) router.nextPage(page.nextCursor);
      }}
      previous={() => router.previousPage()}
      unavailable={page?.status === "unavailable" ? page.reason : null}
      query={query}
      setQuery={setQuery}
      select={(entityId) => router.navigate((r) => ({ ...r, record: entityId, history: false, versionId: null }))}
    />
  );
}

function TrackedOpportunities() {
  const route = useRoute();
  const state = useQuery(reads.records("opportunity", route.cursor));
  return (
    <QueryView
      state={state}
      loading={<CardsSkeleton label="Loading opportunity records…" />}
      isEmpty={(page) => page.items.length === 0}
      empty={
        <EmptyState title="No opportunity records yet" action={<CaptureAction />}>
          Capture a listing to assess the fit, build a truthful application and track what happens next.
        </EmptyState>
      }
    >
      {(page) => (
        <RecordList
          page={page}
          label="Opportunity records"
          linkTo={(item) => ({ ...route, record: item.entityId, history: false, versionId: null })}
          describe={(item, body) => ({
            title: firstText(body, ["role"]) ?? item.entityId,
            detail: firstText(body, ["company"]),
            badge: firstText(body, ["state"]),
          })}
        />
      )}
    </QueryView>
  );
}

function OpportunityDetail({ entityId }: { entityId: string }) {
  const route = useRoute();
  const router = useRouter();
  const headingRef = useNavigationFocus<HTMLHeadingElement>("detail-heading");
  const record = useQuery(reads.record("opportunity", entityId));
  const row = record.data;
  const versioned = row?.history === "versioned" ? row : null;
  const versions = useQuery(route.history && versioned ? reads.versions(versioned.lineageId) : null);
  const version = useQuery(route.history && route.versionId && versioned ? reads.version(route.versionId, versioned) : null);
  const protectionVersion = versioned
    ? route.history && route.versionId
      ? version.data
        ? route.versionId
        : null
      : versioned.versionId
    : null;
  const protection = useQuery(protectionVersion ? reads.protection(protectionVersion) : null);
  const mutations = useEntityMutations(opportunityEntity(entityId));
  const pendingState = mutations.some(
    (m) => m.operation === "job_stack_transition_opportunity" && (m.status === "queued" || m.status === "running"),
  );
  const protectionState: ProtectionState | null = protection.data
    ? { status: "available", view: protection.data }
    : protectionVersion && protection.status !== "error"
      ? { status: "loading", versionId: protectionVersion }
      : null;
  return (
    <QueryView state={record} loading={<Skeleton label="Loading the selected record…" />}>
      {(current) => (
        <ObservationDetail
          current={current}
          history={route.history}
          versions={versions.data?.items ?? []}
          versionsTruncated={versions.data?.truncated ?? false}
          versionsError={versions.status === "error" ? errorMessage(versions.error) : null}
          version={version.data ?? null}
          versionError={version.status === "error" ? errorMessage(version.error) : null}
          selectedVersion={route.versionId}
          protection={protectionState}
          headingRef={headingRef}
          pendingState={pendingState}
          select={(id, history = false) =>
            router.navigate((r) => ({ ...r, record: id, history: id ? history : false, versionId: null }))
          }
          selectVersion={(versionId) => router.navigate((r) => ({ ...r, versionId }))}
          actions={<OpportunityActions row={current} />}
        />
      )}
    </QueryView>
  );
}
