import { requireAdmin } from "@/server/auth/session";
import { systemOverview } from "@/server/system/overview";
import { updatesStatus } from "@/server/system/updates";
import { listServices } from "@/server/system/services";
import { powerStatus } from "@/server/system/power";
import { liveLogins } from "@/server/system/logins";
import { memoryBreakdown } from "@/server/system/memory";
import { SystemView, type SystemTab, type SystemInitial } from "@/components/system/SystemView";
import { Seeded } from "@/lib/client/seed";

export const metadata = { title: "System" };

const TABS: SystemTab[] = ["overview", "updates", "services", "sign-ins", "power"];

export default async function SystemPage({ searchParams }: { searchParams: Promise<{ tab?: string; unit?: string }> }) {
  const at = Date.now();
  await requireAdmin();
  const sp = await searchParams;
  const tab: SystemTab = TABS.includes(sp.tab as SystemTab) ? (sp.tab as SystemTab) : "overview";
  // Not awaited and best effort, so the title and tabs go out at once and a slow host command can't blank the page.
  const soft = <T,>(p: Promise<T>) => p.catch(() => undefined);
  const initial: SystemInitial = {
    updates: soft(updatesStatus()),
    services: soft(listServices().then((list) => ({ services: list }))),
    overview: tab === "overview" ? soft(systemOverview()) : undefined,
    memory: tab === "overview" ? soft(memoryBreakdown()) : undefined,
    power: tab === "power" ? soft(powerStatus()) : undefined,
    logins: tab === "sign-ins" ? soft(liveLogins()) : undefined,
  };
  return <Seeded at={at}><SystemView tab={tab} unit={typeof sp.unit === "string" ? sp.unit : null} initial={initial} /></Seeded>;
}
