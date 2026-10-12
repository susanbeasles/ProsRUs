import { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  createReadClient,
  type ReadRecord,
  type PipelineSummary,
  type PipelinePage,
  type ProtectionState,
} from "./api";
import { Opportunities } from "./pages/Opportunities";
import "./style.css";
function locationState(search = location.search) {
  const query = new URLSearchParams(search);
  return {
    grant: query.get("grant") ?? "",
    record: query.get("record"),
    history: query.get("history") === "1",
    versionId: query.get("version"),
    view:
      query.get("view") === "all"
        ? ("all" as const)
        : ("relationships" as const),
    cursor: query.get("cursor"),
  };
}
function App() {
  const active = useRef(new Set<AbortController>());
  const navigationGeneration = useRef(0);
  const pageTrail = useRef<(string | null)[]>([]);
  const detailController = useRef<AbortController | null>(null);
  function clearDetail() {
    detailController.current?.abort();
    setCurrent(null);
    setVersions([]);
    setVersion(null);
    setProtection(null);
  }
  function invalidateReads() {
    navigationGeneration.current++;
    for (const controller of active.current) controller.abort();
    clearDetail();
    setRecords([]);
    setPage(null);
    setTotal(0);
    setComplete(false);
  }
  function fail(message: string) {
    invalidateReads();
    setError(message);
  }
  function requestCurrent(
    generation: number,
    captured: ReturnType<typeof locationState>,
    controller: AbortController,
  ) {
    return (
      !controller.signal.aborted &&
      navigationGeneration.current === generation &&
      selectionRef.current === captured
    );
  }

  const [selection, setSelection] = useState(locationState),
    [records, setRecords] = useState<PipelineSummary[]>([]),
    [page, setPage] = useState<PipelinePage | null>(null),
    [current, setCurrent] = useState<ReadRecord | null>(null),
    [error, setError] = useState(""),
    [complete, setComplete] = useState(false),
    [total, setTotal] = useState(0),
    [refresh, setRefresh] = useState(0),
    [query, setQuery] = useState(""),
    [version, setVersion] = useState<unknown>(null),
    [protection, setProtection] = useState<ProtectionState | null>(null),
    [versions, setVersions] = useState<
      { versionId: string; createdAt: number }[]
    >([]);
  const selectionRef = useRef(selection);
  const renderedGeneration = navigationGeneration.current;
  function selectLocation(url?: URL) {
    const next = locationState(url?.search ?? location.search);
    const previous = selectionRef.current;
    if (
      next.grant === previous.grant &&
      next.record === previous.record &&
      next.history === previous.history &&
      next.versionId === previous.versionId &&
      next.view === previous.view &&
      next.cursor === previous.cursor
    )
      return;
    invalidateReads();
    setError("");
    if (next.grant !== previous.grant || next.view !== previous.view)
      pageTrail.current = [];
    else if (!url && next.cursor !== previous.cursor) {
      const found = pageTrail.current.lastIndexOf(next.cursor);
      pageTrail.current = found >= 0 ? pageTrail.current.slice(0, found) : [];
    }
    selectionRef.current = next;
    if (url) window.history.pushState({}, "", url);
    setSelection(next);
  }
  function setAll(all: boolean) {
    if (selectionRef.current.view === (all ? "all" : "relationships")) return;
    const url = new URL(location.href);
    url.searchParams.set("view", all ? "all" : "relationships");
    url.searchParams.delete("cursor");
    url.searchParams.delete("record");
    url.searchParams.delete("history");
    url.searchParams.delete("version");
    selectLocation(url);
  }
  function setPageCursor(cursor: string | null) {
    const url = new URL(location.href);
    if (cursor) url.searchParams.set("cursor", cursor);
    else url.searchParams.delete("cursor");
    selectLocation(url);
  }
  function nextPage() {
    if (selectionRef.current !== selection) return;
    if (page?.status !== "available" || !page.nextCursor) return;
    pageTrail.current.push(selectionRef.current.cursor);
    setPageCursor(page.nextCursor);
  }
  function previousPage() {
    if (selectionRef.current !== selection) return;
    setPageCursor(pageTrail.current.pop() ?? null);
  }
  useEffect(() => {
    const pop = () => {
      selectLocation();
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  function selectVersion(versionId: string | null) {
    const url = new URL(location.href);
    if (versionId) url.searchParams.set("version", versionId);
    else url.searchParams.delete("version");
    selectLocation(url);
  }
  function select(record: string | null, history = false) {
    const url = new URL(location.href);
    if (record) url.searchParams.set("record", record);
    else url.searchParams.delete("record");
    if (history) url.searchParams.set("history", "1");
    else url.searchParams.delete("history");
    url.searchParams.delete("version");
    selectLocation(url);
  }
  useEffect(() => {
    if (selectionRef.current !== selection || navigationGeneration.current !== renderedGeneration) return;
    if (selection.record) return;
    const controller = new AbortController(),
      client = createReadClient(selection.grant, controller.signal);
    const generation = renderedGeneration,
      captured = selection;
    const current = () => requestCurrent(generation, captured, controller);
    active.current.add(controller);
    setRecords([]);
    setPage(null);
    setComplete(false);
    setTotal(0);
    setError("");
    let expiry: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        if (!selection.grant)
          throw Error(
            "Select an existing workspace grant to view observations.",
          );
        const session = await client.session();
        if (!current()) return;
        if (session.expiresAtMs <= Date.now())
          throw Error("Workspace grant expired. Select a current grant.");
        expiry = setTimeout(() => {
          if (current())
            fail("Workspace grant expired. Select a current grant.");
        }, session.expiresAtMs - Date.now());
        const result = await client.pipelinePage(
          selection.view,
          selection.cursor,
        );
        if (!current()) return;
        setPage(result);
        if (result.status === "available") {
          setRecords([...result.items]);
          setTotal(result.totalObservations);
        }
        setComplete(true);
      } catch (e) {
        if (current())
          fail(e instanceof Error ? e.message : "Workspace read failed");
      }
    })();
    return () => {
      controller.abort();
      active.current.delete(controller);
      if (expiry) clearTimeout(expiry);
    };
  }, [
    selection.grant,
    selection.view,
    selection.cursor,
    selection.record,
    selection.history,
    selection.versionId,
    refresh,
  ]);
  useEffect(() => {
    if (selectionRef.current !== selection || navigationGeneration.current !== renderedGeneration) return;
    setCurrent(null);
    setVersions([]);
    setVersion(null);
    setProtection(null);
    const selectedRecord = selection.record;
    if (!selectedRecord) return;
    if (!selection.grant) {
      fail("Select an existing workspace grant to view observations.");
      return;
    }
    const controller = new AbortController(),
      client = createReadClient(selection.grant, controller.signal);
    const generation = renderedGeneration,
      captured = selection;
    const current = () => requestCurrent(generation, captured, controller);
    let expiry: ReturnType<typeof setTimeout> | undefined;
    setError("");
    active.current.add(controller);
    detailController.current = controller;
    void (async () => {
      try {
        const session = await client.session();
        if (!current()) return;
        if (session.expiresAtMs <= Date.now())
          throw Error("Workspace grant expired. Select a current grant.");
        expiry = setTimeout(() => {
          if (current())
            fail("Workspace grant expired. Select a current grant.");
        }, session.expiresAtMs - Date.now());
        const row = await client.detail("opportunity", selectedRecord);
        if (!row) throw Error("Observation no longer available.");
        if (!current()) return;
        setCurrent(row);
        let protectionVersion =
          row.history === "versioned" ? row.versionId : null;
        if (selection.history && row.history === "versioned") {
          const found: { versionId: string; createdAt: number }[] = [];
          let cursor: string | null = null;
          do {
            const page = await client.versions(row.lineageId, cursor);
            found.push(...page.items);
            cursor = page.nextCursor;
          } while (cursor && current());
          if (current()) setVersions(found);
          if (selection.versionId) {
            const selected = await client.version(selection.versionId);
            if (
              selected.versionId !== selection.versionId ||
              selected.lineageId !== row.lineageId ||
              selected.entityId !== row.entityId
            )
              throw Error("Version does not belong to the selected record.");
            if (!current()) return;
            setVersion(selected);
            protectionVersion = selected.versionId;
          }
        }
        if (!current()) return;
        if (protectionVersion) {
          setProtection({ status: "loading", versionId: protectionVersion });
          try {
            const view = await client.protection(protectionVersion);
            if (!current()) return;
            setProtection({ status: "available", view });
          } catch (e) {
            throw Error(
              "Protection unavailable or denied. " +
                (e instanceof Error ? e.message : "Read failed"),
            );
          }
        }
      } catch (e) {
        if (current()) {
          fail(e instanceof Error ? e.message : "Read denied");
        }
      }
    })();
    return () => {
      controller.abort();
      active.current.delete(controller);
      if (expiry) clearTimeout(expiry);
    };
  }, [
    selection.grant,
    selection.view,
    selection.cursor,
    selection.record,
    selection.history,
    selection.versionId,
    refresh,
  ]);
  return (
    <div className="app">
      <aside>
        <div className="brand">
          Job Stack<span className="edition">READ ONLY</span>
        </div>
        <p>Recruiting observations</p>
        <p className="muted">
          Dated source evidence, with every role and prior state retained.
        </p>
        <a href="/owner/job-stack">Choose workspace grant</a>
        <a href="/owner">Personal Control</a>
      </aside>
      <main>
        <header className="topbar">
          <span>WORKSPACE / PIPELINE</span>
          <button
            onClick={() => {
              invalidateReads();
              setError("");
              setRefresh((x) => x + 1);
            }}
          >
            Refresh authorized reads
          </button>
        </header>
        <div className="content">
          <div className="heading">
            <div>
              <p className="eyebrow">YOUR RECRUITING PIPELINE</p>
              <h1>Facts before next steps.</h1>
              <p>
                Historical contact is not current permission. No actions are
                enabled.
              </p>
            </div>
          </div>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : (
            <Opportunities
              records={records}
              current={current}
              selected={selection.record}
              complete={complete}
              loaded={records.length}
              total={total}
              historicalRelationships={
                page?.status === "available" ? page.historicalRelationships : 0
              }
              range={
                page?.status === "available" ? page.range : { start: 0, end: 0 }
              }
              nextCursor={page?.status === "available" ? page.nextCursor : null}
              canPrevious={selection.cursor !== null}
              next={nextPage}
              previous={previousPage}
              unavailable={page?.status === "unavailable" ? page.reason : null}
              query={query}
              setQuery={setQuery}
              all={selection.view === "all"}
              setAll={setAll}
              select={select}
              history={selection.history}
              versions={versions}
              version={version}
              selectedVersion={selection.versionId}
              protection={protection}
              selectVersion={selectVersion}
            />
          )}
        </div>
      </main>
    </div>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
