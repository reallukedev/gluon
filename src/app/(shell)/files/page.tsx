import { Suspense } from "react";
import { requireUser } from "@/server/auth/session";
import { places } from "@/server/files/places";
import { FilesView } from "@/components/files/FilesView";

export const metadata = { title: "Files" };

export default async function FilesPage() {
  const { user } = await requireUser();
  const initial = await places(user).catch(() => null);
  // Where to start when no ?path= is given: a pinned folder, else the first drive or share.
  const firstPin = initial?.pins.find((p) => !p.missing)?.path;
  const firstPlace = initial?.places.find((p) => !p.missing && (p.kind === "drive" ? !!p.fs : true) && p.kind !== "root")?.path;
  const defaultPath = firstPin ?? firstPlace ?? "/";
  return (
    <Suspense>
      <FilesView initialPlaces={initial} defaultPath={defaultPath} />
    </Suspense>
  );
}
