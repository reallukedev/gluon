import { requireAdmin } from "@/server/auth/session";
import { systemOverview } from "@/server/system/overview";
import { updatesStatus } from "@/server/system/updates";
import { listServices } from "@/server/system/services";
import { powerStatus } from "@/server/system/power";
import { liveLogins } from "@/server/system/logins";
import { SystemView, type SystemTab, type SystemInitial } from "@/components/system/SystemView";

export const metadata = { title: "System" };

const TABS: SystemTab[] = ["overview", "updates", "services", "sign-ins", "power"];

export default async function SystemPage({ searchParams }: { searchParams: Promise<{ tab?: string; unit?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const tab: SystemTab = TABS.includes(sp.tab as SystemTab) ? (sp.tab as SystemTab) : "overview";
  // Each is best effort: a slow or failing host command shouldn't blank the page; the client retries.
  const soft = <T,>(p: Promise<T>) => p.catch(() => undefined);
  const [updates, services, overview, power, logins] = await Promise.all([
    soft(updatesStatus()),
    soft(listServices().then((list) => ({ services: list }))),
    tab === "overview" ? soft(systemOverview()) : undefined,
    tab === "power" ? soft(powerStatus()) : undefined,
    tab === "sign-ins" ? soft(liveLogins()) : undefined,
  ]);
  const initial: SystemInitial = { updates, services, overview, power, logins };
  return <SystemView tab={tab} unit={typeof sp.unit === "string" ? sp.unit : null} initial={initial} />;
}
