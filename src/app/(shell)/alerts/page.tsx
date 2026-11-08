import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { alertsHref, fromOldAlertsTab } from "@/lib/settings-links";

type Search = Promise<Record<string, string | string[] | undefined>>;
const str = (v: string | string[] | undefined, max: number) => (typeof v === "string" && v ? v.slice(0, max) : undefined);

/** Old Alerts links. Their monitor, channel and #problem anchor survive the redirect. */
export default async function AlertsRedirect({ searchParams }: { searchParams: Search }) {
  const { user } = await requireUser();
  // Members go to their start page rather than a "not found".
  if (user.role !== "admin") redirect("/");
  const sp = await searchParams;
  const to = fromOldAlertsTab(str(sp.tab, 40));
  redirect(to === "home" ? "/" : alertsHref(to, { monitor: str(sp.monitor, 200), channel: str(sp.channel, 200) }));
}
