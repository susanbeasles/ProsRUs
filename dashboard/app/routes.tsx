import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { PageId } from "./router";

/** One lazily loaded chunk per feature. */
export const ROUTES: Readonly<Record<PageId, LazyExoticComponent<ComponentType>>> = {
  overview: lazy(() => import("../features/overview/OverviewPage")),
  opportunities: lazy(() => import("../features/opportunities/OpportunitiesPage")),
  conversations: lazy(() => import("../features/conversations/ConversationsPage")),
  interviews: lazy(() => import("../features/interviews/InterviewsPage")),
  profile: lazy(() => import("../features/profile-evidence/ProfileEvidencePage")),
  packets: lazy(() => import("../features/packets/PacketsPage")),
  activity: lazy(() => import("../features/activity/ActivityPage")),
  settings: lazy(() => import("../features/settings/SettingsPage")),
  history: lazy(() => import("../features/history/HistoryPage")),
};
