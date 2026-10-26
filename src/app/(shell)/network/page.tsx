import { requireAdmin } from "@/server/auth/session";
import { routesResponse } from "@/server/network/routes-service";
import { NetworkView, type Landing } from "@/components/network/NetworkView";
import type { HopId } from "@/components/network/model";

export const metadata = { title: "Network" };

const HOPS: HopId[] = ["dns", "router", "caddy"];

type Params = { tab?: string; hop?: string; publish?: string; route?: string };

/**
 * Deep links, old and new:
 *  ?publish=<appId>   opens "Put an app on the internet" with that app picked
 *  ?route=<id>        opens that address (any of an app's addresses, or __fallback__)
 *  ?hop=dns|router|caddy   opens that hop of the map
 *  ?tab=dns           (older links) the DNS hop; ?tab=exposure / ?tab=addresses land on the app list
 */
function landing(sp: Params): Landing | null {
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null);
  const publish = str(sp.publish);
  if (publish) return { kind: "publish", appId: publish };
  const route = str(sp.route);
  if (route) return { kind: "route", id: route };
  const hop = str(sp.hop) ?? (sp.tab === "dns" ? "dns" : null);
  if (hop && HOPS.includes(hop as HopId)) return { kind: "hop", hop: hop as HopId };
  if (sp.tab === "exposure" || sp.tab === "addresses") return { kind: "list" };
  return null;
}

export default async function NetworkPage({ searchParams }: { searchParams: Promise<Params> }) {
  await requireAdmin();
  const sp = await searchParams;
  // Best effort: if routes.json can't be read the client shows why (and retries).
  const initial = await routesResponse().catch(() => null);
  return <NetworkView initial={initial} landing={landing(sp)} />;
}
