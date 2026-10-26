import { z } from "zod";
import { route } from "@/server/api";
import { startRemove } from "@/server/appstore/service";
import { isRunning, streamJob } from "@/server/appstore/jobs";
import { getAppRow } from "@/server/appstore/db";

/**
 * Remove a published app from where it runs. `keepData` moves its data folder aside first;
 * `forget` also deletes the app from Gluon (otherwise it goes back to being a draft).
 */
export const POST = route({ auth: "admin", recent: true, body: z.object({ keepData: z.boolean(), forget: z.boolean() }) }, async ({ params, body, user, ip, zone, req }) => {
  const id = String(params.id);
  const row = getAppRow(id);
  if (row && row.status !== "published") {
    await startRemove(id, user, { ip, zone }, body);
    return { ok: true, deleted: body.forget };
  }
  if (!isRunning(id)) await startRemove(id, user, { ip, zone }, body);
  return streamJob(id, req.signal);
});
