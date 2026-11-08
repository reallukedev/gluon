import { Suspense } from "react";
import { requireUser } from "@/server/auth/session";
import { places } from "@/server/files/places";
import { Files } from "@/components/files/Files";
import { FilesSkeleton } from "@/components/files/FilesSkeleton";
import type { Places } from "@/lib/files-types";

export const metadata = { title: "Files" };

export default async function FilesPage({ searchParams }: { searchParams: Promise<{ view?: string; path?: string }> }) {
  const { user } = await requireUser();
  const sp = await searchParams;
  // Places reads the drives, so it isn't awaited here: the page's shape goes out first.
  return (
    <Suspense fallback={<FilesSkeleton screen={sp.view === "trash" ? "trash" : sp.path ? "browse" : "front"} />}>
      <FilesWithPlaces initial={places(user).catch(() => null)} />
    </Suspense>
  );
}

async function FilesWithPlaces({ initial }: { initial: Promise<Places | null> }) {
  return <Files initialPlaces={await initial} />;
}
