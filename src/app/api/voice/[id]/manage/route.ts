import { route } from "@/server/api";
import { isRunning, streamJob } from "@/server/appstore/jobs";
import { manageJobKey, managePlan, startManage } from "@/server/voice/service";

export const GET = route({ auth: "admin" }, ({ params }) => managePlan(decodeURIComponent(String(params.id))));

/** Carries on if the page closes; a second POST attaches. */
export const POST = route({ auth: "admin", recent: true }, async ({ params, user, ip, zone, req }) => {
  const id = decodeURIComponent(String(params.id));
  if (!isRunning(manageJobKey(id))) await startManage(id, user, { ip, zone });
  return streamJob(manageJobKey(id), req.signal);
});
