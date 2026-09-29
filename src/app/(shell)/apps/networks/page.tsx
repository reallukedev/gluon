import { requireAdmin } from "@/server/auth/session";
import { listNetworks } from "@/server/dockerx/networks";
import { AppError } from "@/server/errors";
import { NetworksView } from "@/components/docker/NetworksView";

export const metadata = { title: "Networks" };

export default async function NetworksPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAdmin();
  const [sp, result] = await Promise.all([
    searchParams,
    listNetworks().then(
      (data) => ({ data, error: null }),
      (e: unknown) => ({ data: null, error: e instanceof AppError ? { code: e.code, message: e.message } : { code: "internal", message: "Couldn't load networks." } }),
    ),
  ]);
  return <NetworksView initial={result.data} initialError={result.error} initialQuery={typeof sp.q === "string" ? sp.q.slice(0, 200) : ""} />;
}
