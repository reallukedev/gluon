import "server-only";
import { activityLimit, type HomeLayout } from "@/lib/home";
import type { User } from "./auth/users";
import { getSetting } from "./settings";
import { statusFor } from "./status";
import { appsFor } from "./apps/listing";
import { monitorsFor } from "./monitors/ranged";
import { internetFor } from "./widgets/internet";
import { spaceData } from "./widgets/space";
import { activityPage } from "./audit";

/**
 * The answers Home's widgets would fetch right after hydration, keyed by the URL each one asks for, so Home's
 * first paint is the finished page instead of skeletons that fill in a moment later. Only what's cheap and local:
 * anything that asks another machine (the router) still loads on the client.
 */
export async function homePrefetch(user: User, layout: HomeLayout): Promise<Record<string, unknown>> {
  const admin = user.role === "admin";
  const status = admin || getSetting("householdCanSeeStatus");
  const loads = new Map<string, () => unknown>();
  for (const item of layout.items) {
    switch (item.type) {
      case "status":
      case "storage":
      case "server.busy":
        if (status) loads.set("/api/status", () => statusFor(user));
        break;
      case "app":
        loads.set("/api/apps", () => appsFor(user));
        if (admin) loads.set("/api/status", () => statusFor(user));
        break;
      case "household.internet":
        loads.set("/api/widgets/internet", () => internetFor(user));
        break;
      case "server.uptime":
        if (admin) loads.set("/api/alerts/monitors?range=24h", () => monitorsFor("24h"));
        break;
      case "server.space":
        if (admin) loads.set("/api/widgets/space", () => spaceData());
        break;
      case "server.activity":
        if (admin) {
          const limit = activityLimit(item.size);
          loads.set(`/api/activity?limit=${limit}`, () => activityPage({ limit }));
        }
        break;
    }
  }
  // Best effort: a widget whose data fails here loads (and shows its error) on the client as before. The JSON
  // round trip hands over exactly what the API would, so the client's first fetch finds nothing to change.
  const json = async (load: () => unknown) => JSON.parse(JSON.stringify(await load())) as unknown;
  const settled = await Promise.all([...loads].map(async ([url, load]) => [url, await json(load).catch(() => undefined)] as const));
  return Object.fromEntries(settled.filter(([, v]) => v !== undefined));
}
