import { useEffect, useState, type ReactNode } from "react";
import { ElevationNotice } from "../components/Actions";
import { useMutationRecords, useWorkspace } from "../lib/hooks";
import { RouteLink, useRoute, useRouter } from "./context";
import { NAV_ORDER, PAGE_TITLES } from "./pages";
import { pageRoute } from "./router";

export function Shell({ children }: { children: ReactNode }) {
  const route = useRoute();
  const router = useRouter();
  const workspace = useWorkspace();
  const records = useMutationRecords();
  const pending = records.filter((record) => record.status === "queued" || record.status === "running").length;
  const title = PAGE_TITLES[route.page];
  const [announcement, setAnnouncement] = useState("");
  useEffect(
    () =>
      router.subscribe(() => {
        const next = router.route();
        setAnnouncement(PAGE_TITLES[next.page] + (next.record ? ": record selected" : ""));
      }),
    [router],
  );
  useEffect(() => {
    document.title = title + " · Job Stack";
  }, [title]);
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <aside className="sidebar">
        <div className="brand">
          Job Stack<span className="edition">OWNER</span>
        </div>
        <p className="sidebar-note">Recruiting workspace. Dated source evidence, with every role and prior state retained.</p>
        <nav aria-label="Workspace sections">
          <ul>
            {NAV_ORDER.map((page) => (
              <li key={page}>
                <RouteLink
                  to={pageRoute(route.grant, page)}
                  className={page === route.page ? "active" : undefined}
                  aria-current={page === route.page ? "page" : undefined}
                >
                  {PAGE_TITLES[page]}
                </RouteLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="sidebar-links">
          <a href="/owner/job-stack">Choose workspace grant</a>
          <a href="/owner">Personal Control</a>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <span className="crumb">WORKSPACE / {title.toUpperCase()}</span>
          <span className="topbar-actions">
            {pending > 0 && (
              <span className="saving" role="status">
                {pending === 1 ? "1 change saving" : `${pending} changes saving`}
              </span>
            )}
            <button type="button" onClick={() => workspace.refresh()}>
              Refresh authorized reads
            </button>
          </span>
        </header>
        <main id="main" tabIndex={-1}>
          <ElevationNotice />
          {children}
        </main>
      </div>
      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
