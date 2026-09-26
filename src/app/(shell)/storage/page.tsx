import { requireAdmin } from "@/server/auth/session";
import { getInventory } from "@/server/storage/inventory";
import { StorageView, type StorageTab } from "@/components/storage/StorageView";

export const metadata = { title: "Storage" };

const TABS: StorageTab[] = ["disks", "space", "fstab", "changes"];

export default async function StoragePage({ searchParams }: { searchParams: Promise<{ tab?: string; usage?: string; job?: string }> }) {
  await requireAdmin();
  const [inventory, sp] = await Promise.all([getInventory(), searchParams]);
  const usage = typeof sp.usage === "string" && sp.usage.startsWith("/") ? sp.usage : null;
  const tab: StorageTab = usage ? "space" : TABS.includes(sp.tab as StorageTab) ? (sp.tab as StorageTab) : "disks";
  return <StorageView initial={inventory} tab={tab} usage={usage} />;
}
