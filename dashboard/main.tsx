import { StrictMode, useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  createReadClient,
  type ReadRecord,
  type ReadSummary,
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
  };
}
function App() {
  const active = useRef(new Set<AbortController>());
  const detailController = useRef<AbortController | null>(null);
  function clearDetail() {
    detailController.current?.abort();
    setCurrent(null);
    setVersions([]);
    setVersion(null);
    setProtection(null);
  }
  function fail(message: string) {
    for (const controller of active.current) controller.abort();
    setRecords([]);
    setCurrent(null);
    setVersions([]);
    setVersion(null);
    setProtection(null);
    setComplete(false);
    setError(message);
  }

  const [selection, setSelection] = useState(locationState),
    [records, setRecords] = useState<ReadRecord[]>([]),
    [current, setCurrent] = useState<ReadRecord | null>(null),
    [error, setError] = useState(""),
    [complete, setComplete] = useState(false),
    [total, setTotal] = useState(0),
    [refresh, setRefresh] = useState(0),
    [all, setAll] = useState(false),
    [query, setQuery] = useState(""),
    [version, setVersion] = useState<unknown>(null),
    [protection, setProtection] = useState<ProtectionState | null>(null),
    [versions, setVersions] = useState<
      { versionId: string; createdAt: number }[]
    >([]);
  const selectionRef = useRef(selection);
  function selectLocation(url?: URL) {
    const next = locationState(url?.search ?? location.search);
    const previous = selectionRef.current;
    if (
      next.grant === previous.grant &&
      next.record === previous.record &&
      next.history === previous.history &&
      next.versionId === previous.versionId
    )
      return;
    clearDetail();
    selectionRef.current = next;
    if (url) window.history.pushState({}, "", url);
    setSelection(next);
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
    const controller = new AbortController(),
      client = createReadClient(selection.grant, controller.signal);
    active.current.add(controller);
    setRecords([]);
    setCurrent(null);
    setProtection(null);
    setComplete(false);
    setTotal(0);
    setError("");
    let expiry: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        if (!selection.grant)
          throw Error(
            "Select an existing workspace grant to view observations.",
          );
        const session = await client.session();
        if (controller.signal.aborted) return;
        expiry = setTimeout(
          () => {
            fail("Workspace grant expired. Select a current grant.");
          },
          Math.max(0, session.expiresAtMs - Date.now()),
        );
        const summaries: ReadSummary[] = [];
        let cursor: string | null = null;
        const seen = new Set<string>();
        do {
          const page = await client.page("opportunity", cursor);
          if (controller.signal.aborted) return;
          for (const row of page.items) {
            if (seen.has(row.entityId))
              throw Error("Duplicate record in pagination");
            seen.add(row.entityId);
            summaries.push(row);
          }
          cursor = page.nextCursor;
        } while (cursor && !controller.signal.aborted);
        setTotal(summaries.length);
        for (let i = 0; i < summaries.length; i += 4) {
          const detail = await Promise.all(
            summaries
              .slice(i, i + 4)
              .map((row) => client.detail(row.kind, row.entityId)),
          );
          if (controller.signal.aborted) return;
          if (detail.some((row) => row === null))
            throw Error("Record changed while loading. Refresh the workspace.");
          setRecords((previous) => [
            ...previous,
            ...detail.filter((row): row is ReadRecord => row !== null),
          ]);
        }
        if (!controller.signal.aborted) setComplete(true);
      } catch (e) {
        if (!controller.signal.aborted) {
          fail(e instanceof Error ? e.message : "Workspace read failed");
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      active.current.delete(controller);
      if (expiry) clearTimeout(expiry);
    };
  }, [selection.grant, refresh]);
  useEffect(() => {
    setCurrent(null);
    setVersions([]);
    setVersion(null);
    setProtection(null);
    const selectedRecord = selection.record;
    if (!selectedRecord || !selection.grant) return;
    const controller = new AbortController(),
      client = createReadClient(selection.grant, controller.signal);
    active.current.add(controller);
    detailController.current = controller;
    void (async () => {
      try {
        const row = await client.detail("opportunity", selectedRecord);
        if (!row) throw Error("Observation no longer available.");
        if (controller.signal.aborted) return;
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
          } while (cursor && !controller.signal.aborted);
          if (!controller.signal.aborted) setVersions(found);
          if (selection.versionId) {
            const selected = await client.version(selection.versionId);
            if (
              selected.lineageId !== row.lineageId ||
              selected.entityId !== row.entityId
            )
              throw Error("Version does not belong to the selected record.");
            if (controller.signal.aborted) return;
            setVersion(selected);
            protectionVersion = selected.versionId;
          }
        }
        if (controller.signal.aborted) return;
        if (protectionVersion) {
          setProtection({ status: "loading", versionId: protectionVersion });
          try {
            const view = await client.protection(protectionVersion);
            if (controller.signal.aborted) return;
            setProtection({ status: "available", view });
          } catch (e) {
            throw Error(
              "Protection unavailable or denied. " +
                (e instanceof Error ? e.message : "Read failed"),
            );
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          fail(e instanceof Error ? e.message : "Read denied");
        }
      }
    })();
    return () => {
      controller.abort();
      active.current.delete(controller);
    };
  }, [
    selection.grant,
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
      </aside>
      <main>
        <header className="topbar">
          <span>WORKSPACE / PIPELINE</span>
          <button
            onClick={() => {
              clearDetail();
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
              query={query}
              setQuery={setQuery}
              all={all}
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
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
