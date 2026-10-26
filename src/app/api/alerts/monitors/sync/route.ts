import { route } from "@/server/api";
import { syncAutoMonitors } from "@/server/monitors/auto";
import { invalidateMonitors } from "@/server/monitors/runner";

/** Re-read public addresses and apps now instead of waiting for the minute-by-minute sync. */
export const POST = route({ auth: "admin" }, async () => {
  const r = await syncAutoMonitors();
  invalidateMonitors();
  return r;
});
