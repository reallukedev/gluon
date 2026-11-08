import { Suspense } from "react";
import { requireAdmin } from "@/server/auth/session";
import { listNetworks } from "@/server/dockerx/networks";
import { AppError } from "@/server/errors";
import { NetworksView } from "@/components/docker/NetworksView";
import AppsTabLoading from "../loading";
import { Seeded } from "@/lib/client/seed";

export const metadata = { title: "Docker networks" };

export default async function NetworksPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const at = Date.now();
  await requireAdmin();
  const sp = await searchParams;
  // Docker answers quickly unless it's busy or restarting; then the tab's place waits, not the page.
  return (
    <Seeded at={at}>
      <Suspense fallback={<AppsTabLoading />}>
        <Networks query={typeof sp.q === "string" ? sp.q.slice(0, 200) : ""} />
      </Suspense>
    </Seeded>
  );
}

async function Networks({ query }: { query: string }) {
  const result = await listNetworks().then(
    (data) => ({ data, error: null }),
    (e: unknown) => ({ data: null, error: e instanceof AppError ? { code: e.code, message: e.message } : { code: "internal", message: "Couldn't load networks." } }),
  );
  return <NetworksView initial={result.data} initialError={result.error} initialQuery={query} />;
}
