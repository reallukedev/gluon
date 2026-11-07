import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { activityHref, alertsHref } from "@/lib/settings-links";

type Search = Promise<Record<string, string | string[] | undefined>>;
const str = (v: string | string[] | undefined, max: number) => (typeof v === "string" && v ? v.slice(0, max) : undefined);

/**
 * Status was removed: its problem list is Home's Needs you widget and its live use by app is on Diagnostics.
 * Old links (emails, bookmarks) land on Home, where a #problem anchor survives; its old tabs keep going to Settings.
 */
export default async function StatusRedirect({ searchParams }: { searchParams: Search }) {
  const { user } = await requireUser();
  if (user.role === "admin") {
    const sp = await searchParams;
    const tab = str(sp.tab, 40);
    if (tab === "watching" || tab === "notifications" || tab === "history") redirect(alertsHref(tab, { monitor: str(sp.monitor, 200), channel: str(sp.channel, 200) }));
    if (tab === "activity") redirect(activityHref({ target: str(sp.target, 500), user: str(sp.user, 64) }));
  }
  redirect("/");
}
