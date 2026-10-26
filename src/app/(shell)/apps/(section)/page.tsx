import { requireAdmin } from "@/server/auth/session";
import { listApps } from "@/server/docker/apps";
import { activePlatform } from "@/server/platform";
import { AppsView } from "@/components/apps/AppsView";

export const metadata = { title: "Apps" };

export default async function AppsPage({ searchParams }: { searchParams: Promise<{ sort?: string; filter?: string }> }) {
  await requireAdmin();
  const [apps, sp, platform] = await Promise.all([listApps(), searchParams, activePlatform().catch(() => "none" as const)]);
  return <AppsView initial={apps} platform={platform} initialSort={sp.sort === "memory" || sp.sort === "cpu" ? sp.sort : "name"} initialFilter={sp.filter === "problems" || sp.filter === "public" || sp.filter === "stopped" ? sp.filter : "all"} />;
}
