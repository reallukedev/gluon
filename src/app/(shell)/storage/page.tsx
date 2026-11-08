import { requireAdmin } from "@/server/auth/session";
import { getInventory } from "@/server/storage/inventory";
import { StorageView, type StorageTab } from "@/components/storage/StorageView";
import { Seeded } from "@/lib/client/seed";

export const metadata = { title: "Storage" };

const TABS: StorageTab[] = ["disks", "space", "fstab", "changes"];

export default async function StoragePage({ searchParams }: { searchParams: Promise<{ tab?: string; usage?: string; job?: string }> }) {
  const at = Date.now();
  await requireAdmin();
  const sp = await searchParams;
  const usage = typeof sp.usage === "string" && sp.usage.startsWith("/") ? sp.usage : null;
  const tab: StorageTab = usage ? "space" : TABS.includes(sp.tab as StorageTab) ? (sp.tab as StorageTab) : "disks";
  // Reading the drives runs host commands, so it isn't awaited: the title and tabs go out first.
  return <Seeded at={at}><StorageView initial={getInventory()} tab={tab} usage={usage} /></Seeded>;
}
