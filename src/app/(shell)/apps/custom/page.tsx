import { requireAdmin } from "@/server/auth/session";
import { listCustomApps, storeStatus } from "@/server/appstore/service";
import { CustomAppsView } from "@/components/builder/CustomAppsView";
import type { CustomAppsResponse } from "@/lib/builder-types";

export const metadata = { title: "Your apps" };

export default async function CustomAppsPage() {
  await requireAdmin();
  // Umbrel can be slow to answer (or restarting): render straight away and let the page fill in.
  const initial = await Promise.race([
    Promise.all([storeStatus(), listCustomApps()]).then(([store, apps]): CustomAppsResponse => ({ store, apps })),
    new Promise<null>((r) => setTimeout(() => r(null), 1500)),
  ]).catch(() => null);
  return <CustomAppsView initial={initial} />;
}
