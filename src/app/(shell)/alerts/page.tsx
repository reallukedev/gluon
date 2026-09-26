import { requireAdmin } from "@/server/auth/session";
import { listAllOpen } from "@/server/findings";
import { AlertsView, type AlertsTab } from "@/components/alerts/AlertsView";

export const metadata = { title: "Alerts" };

const TABS: AlertsTab[] = ["open", "history", "monitors", "channels", "sent"];

export default async function AlertsPage({ searchParams }: { searchParams: Promise<{ tab?: string; monitor?: string; channel?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const tab = TABS.includes(sp.tab as AlertsTab) ? (sp.tab as AlertsTab) : "open";
  return <AlertsView tab={tab} initialFindings={listAllOpen()} monitorId={sp.monitor ?? null} channelId={sp.channel ?? null} />;
}
