/** Old addresses (/alerts, /activity, /people, /status?tab=…) redirect here; build new links with these. */
export const ALERTS_TABS = ["watching", "notifications", "history"] as const;
export type AlertsTab = (typeof ALERTS_TABS)[number];

export const PEOPLE_TABS = ["people", "access", "reports", "announcements", "defaults"] as const;
export type PeopleTab = (typeof PEOPLE_TABS)[number];

type Params = Record<string, string | null | undefined>;

function build(path: string, params: Params, hash?: string): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const qs = q.toString();
  return `${path}${qs ? `?${qs}` : ""}${hash ? `#${encodeURIComponent(hash)}` : ""}`;
}

/** Watching (monitors) is the first tab, so it needs no `tab`. */
export function alertsHref(tab: AlertsTab = "watching", params: { monitor?: string | null; channel?: string | null } = {}): string {
  return build("/settings/alerts", { tab: tab === "watching" ? null : tab, ...params });
}

export function activityHref(params: { target?: string | null; user?: string | null } = {}): string {
  return build("/settings/activity", params);
}

export function peopleHref(params: { tab?: PeopleTab | null; person?: string | null; report?: string | null } = {}): string {
  const { tab, ...rest } = params;
  return build("/settings/people", { tab: tab === "people" ? null : tab, ...rest });
}

/** One problem in Home's Needs you widget (its id is the list item's anchor). */
export function problemHref(findingId?: string): string {
  return build("/", {}, findingId);
}

export function fromOldAlertsTab(tab: string | undefined): AlertsTab | "home" {
  switch (tab) {
    case "monitors":
      return "watching";
    case "channels":
    case "sent":
      return "notifications";
    case "history":
      return "history";
    default:
      return "home";
  }
}
