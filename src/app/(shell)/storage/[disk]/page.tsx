import { Suspense } from "react";
import { notFound } from "next/navigation";
import { currentAuth, requireAdmin } from "@/server/auth/session";
import { getInventoryState, findDisk } from "@/server/storage/inventory";
import { smartDetail, smartFor } from "@/server/storage/smart";
import { DiskDetailView, DiskDetailSkeleton } from "@/components/storage/DiskDetailView";
import { Seeded } from "@/lib/client/seed";

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
  // Reading the drives runs host commands: the page's shape goes out first.
  return (
    <Suspense fallback={<DiskDetailSkeleton />}>
      <Disk id={id} />
    </Suspense>
  );
}

async function Disk({ id }: { id: string }) {
  const at = Date.now();
  const disk = findDisk(await getInventoryState(), id);
  if (!disk) notFound();
  const view = { ...disk, smart: smartFor(disk.id) };
  return <Seeded at={at}><DiskDetailView initial={{ disk: view, smart: smartDetail(disk.id) }} /></Seeded>;
}
