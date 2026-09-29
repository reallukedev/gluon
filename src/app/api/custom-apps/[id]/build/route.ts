import { route } from "@/server/api";
import { startBuild } from "@/server/appstore/service";
import { isRunning, streamJob } from "@/server/appstore/jobs";

/** Build the app's images from the newest commit, without publishing. */
export const POST = route({ auth: "admin", recent: true }, ({ params, user, ip, zone, req }) => {
  const id = String(params.id);
  if (!isRunning(id)) startBuild(id, user, { ip, zone });
  return streamJob(id, req.signal);
});
