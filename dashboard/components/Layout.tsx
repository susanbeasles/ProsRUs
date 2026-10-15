import type { ReactNode } from "react";
import { RouteLink, useNavigationFocus, useRoute } from "../app/context";
import { pageRoute, PAGE_VIEWS, type Route } from "../app/router";

export function PageHeader({
  eyebrow,
  title,
  children,
  actions,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const ref = useNavigationFocus<HTMLHeadingElement>("page-heading");
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1 tabIndex={-1} ref={ref}>
          {title}
        </h1>
        {children}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function DetailHeading({ children, eyebrow }: { children: ReactNode; eyebrow?: string }) {
  const ref = useNavigationFocus<HTMLHeadingElement>("detail-heading");
  return (
    <>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h2 className="detail-title" tabIndex={-1} ref={ref}>
        {children}
      </h2>
    </>
  );
}

/** Sub-view links for the current page (sub-view changes reset selection and pagination). */
export function ViewTabs({ labels, label }: { labels: Readonly<Record<string, ReactNode>>; label: string }) {
  const route = useRoute();
  const views = PAGE_VIEWS[route.page];
  return (
    <nav className="tabs" aria-label={label}>
      {views.map((view) => (
        <RouteLink
          key={view}
          to={pageRoute(route.grant, route.page, { view })}
          className={route.view === view ? "tab active" : "tab"}
          aria-current={route.view === view ? "page" : undefined}
        >
          {labels[view] ?? view}
        </RouteLink>
      ))}
    </nav>
  );
}

/** Back to the list the current record was opened from (sub-view and page cursor kept). */
export function BackLink({ children }: { children: ReactNode }) {
  const route = useRoute();
  const to: Route = { ...route, record: null, history: false, versionId: null };
  return (
    <RouteLink className="back-link" to={to}>
      ← {children}
    </RouteLink>
  );
}
