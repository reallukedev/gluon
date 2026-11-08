import { route } from "@/server/api";
import { listJobs } from "@/server/files/jobs";

/** Admins see everyone's tasks; members their own. */
export const GET = route({ auth: "user" }, ({ user }) => listJobs(user));
