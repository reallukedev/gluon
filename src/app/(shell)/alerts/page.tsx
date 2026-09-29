import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { alertsHref, fromOldAlertsTab } from "@/lib/settings-links";

type Search = Promise<Record<string, string | string[] | undefined>>;
const str = (v: string | string[] | undefined, max: number) => (typeof v === "string" && v ? v.slice(0, max) : undefined);

/**
 * Alerts moved. Open problems are on Status; monitors, notifications and past problems are in
 * Settings → Alerts. Old links (bookmarks, emails, stored remedies) land in the right place with
 * their monitor or channel; a #problem anchor survives the redirect.
 */
export default async function AlertsRedirect({ searchParams }: { searchParams: Search }) {
  const { user } = await requireUser();
  // Only admins keep watch; anyone else lands on their start page instead of a "not found".
  if (user.role !== "admin") redirect("/");
  const sp = await searchParams;
  const to = fromOldAlertsTab(str(sp.tab, 40));
  redirect(to === "status" ? "/status" : alertsHref(to, { monitor: str(sp.monitor, 200), channel: str(sp.channel, 200) }));
}
