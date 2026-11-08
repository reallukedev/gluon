import { requireAdmin } from "@/server/auth/session";
import { listSites } from "@/server/sites/service";
import { SitesView } from "@/components/sites/SitesView";
import { Seeded } from "@/lib/client/seed";

export const metadata = { title: "Sites" };

export default async function SitesPage() {
  const at = Date.now();
  await requireAdmin();
  return <Seeded at={at}><SitesView initial={listSites()} /></Seeded>;
}
