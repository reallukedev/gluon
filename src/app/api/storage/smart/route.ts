import { z } from "zod";
import { route } from "@/server/api";
import { notFound } from "@/server/errors";
import { getInventoryState, findDisk } from "@/server/storage/inventory";
import { refreshSmart, smartCheckedAt } from "@/server/storage/smart";

/**
 * POST /api/storage/smart { disk? } — read SMART now instead of waiting for the 30-minute pass.
 * Sleeping hard drives are still skipped (reported as asleep), never woken.
 */
export const POST = route({ auth: "admin", body: z.object({ disk: z.string().max(256).optional() }) }, async ({ body }) => {
  const s = await getInventoryState();
  let targets = s.smartTargets;
  if (body.disk) {
    const d = findDisk(s, body.disk);
    if (!d) throw notFound("That disk");
    targets = targets.filter((t) => t.id === d.id);
  }
  await refreshSmart(targets);
  return { checkedAt: smartCheckedAt() };
});
