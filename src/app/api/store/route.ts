import { route } from "@/server/api";
import { activePlatform } from "@/server/platform";
import { umbrelApps, umbrelStores } from "@/server/platform/umbrel";

/**
 * The app store for the platform Gluon works with. Umbrel: its official store plus any community
 * stores, each app marked with what's installed and whether an update is waiting.
 */
export const GET = route({ auth: "admin" }, async () => {
  const platform = await activePlatform();
  if (platform !== "umbrel") return { platform, stores: [], installed: {} };
  const [stores, apps] = await Promise.all([umbrelStores(), umbrelApps(0)]);
  const installed: Record<string, { state: string; version: string }> = {};
  for (const a of apps) installed[a.id] = { state: a.state, version: a.version };
  return { platform, stores, installed };
});
