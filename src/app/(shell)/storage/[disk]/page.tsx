import { notFound } from "next/navigation";
import { currentAuth, requireAdmin } from "@/server/auth/session";
import { getInventoryState, findDisk } from "@/server/storage/inventory";
import { smartDetail, smartFor } from "@/server/storage/smart";
import { DiskDetailView } from "@/components/storage/DiskDetailView";

export async function generateMetadata({ params }: { params: Promise<{ disk: string }> }) {
  // Metadata can render before the page's own admin check: never describe a disk to anyone else.
  const auth = await currentAuth();
  if (auth?.user.role !== "admin") return { title: "Disk" };
  const id = decodeURIComponent((await params).disk);
  const disk = findDisk(await getInventoryState(), id);
  return { title: disk ? `${disk.title}${disk.model ? ` · ${disk.model}` : ""}` : "Disk" };
}

export default async function DiskPage({ params }: { params: Promise<{ disk: string }> }) {
  await requireAdmin();
  const id = decodeURIComponent((await params).disk);
  const disk = findDisk(await getInventoryState(), id);
  if (!disk) notFound();
  const view = { ...disk, smart: smartFor(disk.id) };
  return <DiskDetailView initial={{ disk: view, smart: smartDetail(disk.id) }} />;
}
