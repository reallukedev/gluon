import { requireAdmin } from "@/server/auth/session";
import { listImages } from "@/server/dockerx/images";
import { AppError } from "@/server/errors";
import { ImagesView } from "@/components/docker/ImagesView";

export const metadata = { title: "Docker images" };

export default async function ImagesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAdmin();
  const [sp, result] = await Promise.all([
    searchParams,
    listImages().then(
      (data) => ({ data, error: null }),
      (e: unknown) => ({ data: null, error: e instanceof AppError ? { code: e.code, message: e.message } : { code: "internal", message: "Couldn't load images." } }),
    ),
  ]);
  return <ImagesView initial={result.data} initialError={result.error} initialQuery={typeof sp.q === "string" ? sp.q.slice(0, 200) : ""} />;
}
