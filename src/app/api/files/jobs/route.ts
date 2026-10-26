import { route } from "@/server/api";
import { listJobs } from "@/server/files/jobs";

/** Recent file tasks (admins: everyone's; members: their own). */
export const GET = route({ auth: "user" }, ({ user }) => listJobs(user));
