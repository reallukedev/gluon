import { Suspense } from "react";
import { requireAdmin } from "@/server/auth/session";
import { listVolumes } from "@/server/dockerx/volumes";
import { AppError } from "@/server/errors";
import { VolumesView } from "@/components/docker/VolumesView";
import AppsTabLoading from "../loading";

export const metadata = { title: "Docker volumes" };

export default async function VolumesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  // Docker answers quickly unless it's busy or restarting; then the tab's place waits, not the page.
  return (
    <Suspense fallback={<AppsTabLoading />}>
      <Volumes query={typeof sp.q === "string" ? sp.q.slice(0, 200) : ""} />
    </Suspense>
  );
}

async function Volumes({ query }: { query: string }) {
  const result = await listVolumes().then(
    (data) => ({ data, error: null }),
    (e: unknown) => ({ data: null, error: e instanceof AppError ? { code: e.code, message: e.message } : { code: "internal", message: "Couldn't load volumes." } }),
  );
  return <VolumesView initial={result.data} initialError={result.error} initialQuery={query} />;
}
