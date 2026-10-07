import { route } from "@/server/api";
import { isRunning, streamJob } from "@/server/appstore/jobs";
import { manageJobKey, startRemoveEnvPassword } from "@/server/voice/service";

/** Take the join password out of the compose file (restarts the app), streaming progress. */
export const POST = route({ auth: "admin", recent: true }, async ({ params, user, ip, zone, req }) => {
  const id = decodeURIComponent(String(params.id));
  if (!isRunning(manageJobKey(id))) await startRemoveEnvPassword(id, user, { ip, zone });
  return streamJob(manageJobKey(id), req.signal);
});
