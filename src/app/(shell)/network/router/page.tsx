import { Suspense } from "react";
import { requireAdmin } from "@/server/auth/session";
import { overview } from "@/server/router/monitor";
import { RouterView, RouterSkeleton } from "@/components/router/RouterView";
import { Seeded } from "@/lib/client/seed";

export const metadata = { title: "Router" };

export default async function RouterPage() {
  const at = Date.now();
  await requireAdmin();
  return (
    <Seeded at={at}>
      <Suspense fallback={<RouterSkeleton />}>
        <Router />
      </Suspense>
    </Seeded>
  );
}

async function Router() {
  // From Gluon's cache. Only the very first visit waits, briefly, for the router's status pages.
  // A hover renders this page too, so it doesn't mark the router as watched; the page's own poll does.
  const initial = await overview({ waitMs: 2500, watch: false }).catch(() => null);
  return <RouterView initial={initial} />;
}
