import { Suspense } from "react";
import { requireAdmin } from "@/server/auth/session";
import { listCustomApps, storeStatus } from "@/server/appstore/service";
import { CustomAppsView } from "@/components/builder/CustomAppsView";
import type { CustomAppsResponse } from "@/lib/builder-types";
import AppsTabLoading from "../loading";
import { Seeded } from "@/lib/client/seed";

export const metadata = { title: "Custom apps" };

export default async function CustomAppsPage() {
  await requireAdmin();
  return (
    <Suspense fallback={<AppsTabLoading />}>
      <CustomApps />
    </Suspense>
  );
}

async function CustomApps() {
  const at = Date.now();
  // Umbrel can be slow to answer (or restarting): after a moment, let the page fill in on its own.
  const initial = await Promise.race([
    Promise.all([storeStatus(), listCustomApps()]).then(([store, apps]): CustomAppsResponse => ({ store, apps })),
    new Promise<null>((r) => setTimeout(() => r(null), 1500)),
  ]).catch(() => null);
  return <Seeded at={at}><CustomAppsView initial={initial} /></Seeded>;
}
