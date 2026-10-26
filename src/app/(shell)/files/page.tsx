import { Suspense } from "react";
import { requireUser } from "@/server/auth/session";
import { places } from "@/server/files/places";
import { Files } from "@/components/files/Files";

export const metadata = { title: "Files" };

export default async function FilesPage() {
  const { user } = await requireUser();
  const initial = await places(user).catch(() => null);
  return (
    <Suspense>
      <Files initialPlaces={initial} />
    </Suspense>
  );
}
