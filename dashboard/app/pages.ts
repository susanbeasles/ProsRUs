import type { PageId } from "./router";

export const PAGE_TITLES: Readonly<Record<PageId, string>> = {
  overview: "Overview",
  opportunities: "Opportunities",
  conversations: "Conversations",
  interviews: "Interviews",
  profile: "Profile & evidence",
  packets: "Packets",
  activity: "Activity",
  settings: "Settings",
  history: "History",
};
export const NAV_ORDER: readonly PageId[] = [
  "overview",
  "opportunities",
  "conversations",
  "interviews",
  "profile",
  "packets",
  "activity",
  "settings",
  "history",
];
