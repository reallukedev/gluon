import { requireAdmin } from "@/server/auth/session";
import { zoneRecords } from "@/server/cloudflare/service";
import { DomainView } from "@/components/network/DomainView";

export async function generateMetadata({ params }: { params: Promise<{ zone: string }> }) {
  return { title: `${decodeURIComponent((await params).zone)} DNS` };
}

export default async function DomainPage({ params }: { params: Promise<{ zone: string }> }) {
  await requireAdmin();
  const zone = decodeURIComponent((await params).zone).toLowerCase();
  // Not awaited, so the title goes out before Cloudflare answers. The page shows why if it can't be read.
  return <DomainView zone={zone} initial={zoneRecords(zone).catch(() => null)} />;
}
