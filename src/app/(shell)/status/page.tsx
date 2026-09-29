import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { statusFor } from "@/server/status";
import { getSetting } from "@/server/settings";
import { listAllOpen } from "@/server/findings";
import { activityHref, alertsHref } from "@/lib/settings-links";
import { StatusView } from "@/components/status/StatusView";

export const metadata = { title: "Status" };

type Search = Promise<Record<string, string | string[] | undefined>>;
const str = (v: string | string[] | undefined, max: number) => (typeof v === "string" && v ? v.slice(0, max) : undefined);

/** Is everything working? Admins get what needs them and the machine; members get a calm page. */
export default async function StatusPage({ searchParams }: { searchParams: Search }) {
  const { user } = await requireUser();
  if (user.role !== "admin" && !getSetting("householdCanSeeStatus")) redirect("/");
  const sp = await searchParams;
  // Status briefly had tabs for these; they live in Settings now.
  if (user.role === "admin") {
    const tab = str(sp.tab, 40);
    if (tab === "watching" || tab === "notifications" || tab === "history") redirect(alertsHref(tab, { monitor: str(sp.monitor, 200), channel: str(sp.channel, 200) }));
    if (tab === "activity") redirect(activityHref({ target: str(sp.target, 500), user: str(sp.user, 64) }));
  }
  const initial = await statusFor(user);
  if (user.role !== "admin") return <StatusView initial={initial} />;
  // The open findings are among all of them: hand over the same objects so the page carries each once.
  const allFindings = listAllOpen();
  const byId = new Map(allFindings.map((f) => [f.id, f]));
  return <StatusView initial={{ ...initial, findings: initial.findings.map((f) => byId.get(f.id) ?? f) }} allFindings={allFindings} />;
}
