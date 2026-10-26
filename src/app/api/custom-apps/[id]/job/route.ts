import { route } from "@/server/api";
import { clearJob, streamJob } from "@/server/appstore/jobs";

/** Re-attach to the app's running (or just finished) operation. */
export const GET = route({ auth: "admin" }, ({ params, req }) => streamJob(String(params.id), req.signal));

/** Dismiss a finished operation's result. */
export const DELETE = route({ auth: "admin" }, ({ params }) => {
  clearJob(String(params.id));
  return { ok: true };
});
