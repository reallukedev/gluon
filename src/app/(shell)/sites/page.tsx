import { requireAdmin } from "@/server/auth/session";
import { listSites } from "@/server/sites/service";
import { SitesView } from "@/components/sites/SitesView";

export const metadata = { title: "Sites" };

export default async function SitesPage() {
  await requireAdmin();
  return <SitesView initial={listSites()} />;
}
