import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { refreshLists } from "@/server/system/apt";
import { updatesStatus } from "@/server/system/updates";

/** "Check now": apt-get update (up to a few minutes), then the new list. */
export const POST = route({ auth: "admin" }, async ({ user, ip, zone }) => {
  const r = await refreshLists({ reason: "manual", user });
  audit(user, { action: "system.updates.refresh", target: "apt", summary: r.ok ? "Checked for updates" : `Checked for updates: ${r.summary}`, outcome: r.ok ? "ok" : "failed" }, { ip, zone });
  return { result: r, status: await updatesStatus() };
});
