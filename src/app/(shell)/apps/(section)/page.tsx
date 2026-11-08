import { Suspense } from "react";
import { requireAdmin } from "@/server/auth/session";
import { listApps } from "@/server/docker/apps";
import { activePlatform } from "@/server/platform";
import { AppsView } from "@/components/apps/AppsView";
import AppsTabLoading from "./loading";

export const metadata = { title: "Apps" };

type Sort = "name" | "memory" | "cpu";
type Filter = "all" | "problems" | "public" | "stopped";

export default async function AppsPage({ searchParams }: { searchParams: Promise<{ sort?: string; filter?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const sort: Sort = sp.sort === "memory" || sp.sort === "cpu" ? sp.sort : "name";
  const filter: Filter = sp.filter === "problems" || sp.filter === "public" || sp.filter === "stopped" ? sp.filter : "all";
  // Docker answers quickly unless it's busy or restarting; then the list's place waits, not the page.
  return (
    <Suspense fallback={<AppsTabLoading />}>
      <Apps sort={sort} filter={filter} />
    </Suspense>
  );
}

async function Apps({ sort, filter }: { sort: Sort; filter: Filter }) {
  const [apps, platform] = await Promise.all([listApps(), activePlatform().catch(() => "none" as const)]);
  return <AppsView initial={apps} platform={platform} initialSort={sort} initialFilter={filter} />;
}
