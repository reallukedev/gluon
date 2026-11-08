import { Suspense } from "react";
import { requireAdmin } from "@/server/auth/session";
import { listImages } from "@/server/dockerx/images";
import { AppError } from "@/server/errors";
import { ImagesView } from "@/components/docker/ImagesView";
import AppsTabLoading from "../loading";

export const metadata = { title: "Docker images" };

export default async function ImagesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  // Docker answers quickly unless it's busy or restarting; then the tab's place waits, not the page.
  return (
    <Suspense fallback={<AppsTabLoading />}>
      <Images query={typeof sp.q === "string" ? sp.q.slice(0, 200) : ""} />
    </Suspense>
  );
}

async function Images({ query }: { query: string }) {
  const result = await listImages().then(
    (data) => ({ data, error: null }),
    (e: unknown) => ({ data: null, error: e instanceof AppError ? { code: e.code, message: e.message } : { code: "internal", message: "Couldn't load images." } }),
  );
  return <ImagesView initial={result.data} initialError={result.error} initialQuery={query} />;
}
