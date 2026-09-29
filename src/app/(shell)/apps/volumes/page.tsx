import { requireAdmin } from "@/server/auth/session";
import { listVolumes } from "@/server/dockerx/volumes";
import { AppError } from "@/server/errors";
import { VolumesView } from "@/components/docker/VolumesView";

export const metadata = { title: "Docker volumes" };

export default async function VolumesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAdmin();
  const [sp, result] = await Promise.all([
    searchParams,
    listVolumes().then(
      (data) => ({ data, error: null }),
      (e: unknown) => ({ data: null, error: e instanceof AppError ? { code: e.code, message: e.message } : { code: "internal", message: "Couldn't load volumes." } }),
    ),
  ]);
  return <VolumesView initial={result.data} initialError={result.error} initialQuery={typeof sp.q === "string" ? sp.q.slice(0, 200) : ""} />;
}
