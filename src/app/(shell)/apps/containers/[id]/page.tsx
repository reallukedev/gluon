import { requireAdmin } from "@/server/auth/session";
import { inspectContainer } from "@/server/dockerx/containers";
import { AppError } from "@/server/errors";
import { ContainerView } from "@/components/docker/ContainerView";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Container ${decodeURIComponent(id).slice(0, 40)}` };
}

export default async function ContainerPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const id = decodeURIComponent((await params).id).slice(0, 200);
  const result = await inspectContainer(id).then(
    (data) => ({ data, error: null }),
    (e: unknown) => ({ data: null, error: e instanceof AppError ? { code: e.code, message: e.message } : { code: "internal", message: "Couldn't load the container." } }),
  );
  return <ContainerView id={id} initial={result.data} initialError={result.error} />;
}
