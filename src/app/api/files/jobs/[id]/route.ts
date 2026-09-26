import { route } from "@/server/api";
import { cancelJob, getJob } from "@/server/files/jobs";

export const GET = route({ auth: "user" }, ({ user, params }) => getJob(user, String(params.id)));

/** Cancel a queued or running task. */
export const DELETE = route({ auth: "user" }, ({ user, params }) => cancelJob(user, String(params.id)));
