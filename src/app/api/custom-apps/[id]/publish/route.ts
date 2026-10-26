import { z } from "zod";
import { route } from "@/server/api";
import { startPublish } from "@/server/appstore/service";
import { isRunning, streamJob } from "@/server/appstore/jobs";

/**
 * Publish (install or update) the app, streaming progress as NDJSON. The work carries on if the
 * page closes; GET /job re-attaches. A second POST while it runs attaches instead of starting over.
 */
export const POST = route({ auth: "admin", recent: true, body: z.object({ rebuild: z.boolean().optional() }) }, async ({ params, body, user, ip, zone, req }) => {
  const id = String(params.id);
  if (!isRunning(id)) await startPublish(id, user, { ip, zone }, { rebuild: body.rebuild });
  return streamJob(id, req.signal);
});
