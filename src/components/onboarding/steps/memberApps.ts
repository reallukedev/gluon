import type { HomeLayout } from "@/lib/home";

/** What /api/apps gives a household member. */
export interface MemberApp {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  urls: { home: string | null; away: string | null };
}

export const APPS_URL = "/api/apps";
export const HOME_URL = "/api/me/home";

/** Apps a person can actually open (the Apps widget on Home only shows these). */
export const openable = (apps: MemberApp[]) => apps.filter((a) => a.urls.home || a.urls.away);

/** How many apps a person's Home shows: the app cards on it for apps they can still open. */
export function appsOnHome(layout: HomeLayout, apps: MemberApp[]): number {
  const list = openable(apps);
  return list.filter((a) => layout.items.some((i) => i.type === "app" && i.config.appId === a.id)).length;
}
