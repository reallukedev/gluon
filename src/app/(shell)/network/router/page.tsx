import { requireAdmin } from "@/server/auth/session";
import { overview } from "@/server/router/monitor";
import { RouterView } from "@/components/router/RouterView";

export const metadata = { title: "Router" };

export default async function RouterPage() {
  await requireAdmin();
  // From Gluon's cache. Only the very first visit waits, briefly, for the router's status pages.
  const initial = await overview({ waitMs: 2500 }).catch(() => null);
  return <RouterView initial={initial} />;
}
