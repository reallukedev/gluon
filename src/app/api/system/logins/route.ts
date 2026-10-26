import { route } from "@/server/api";
import { liveLogins } from "@/server/system/logins";

/** Who is signed in right now (SSH and console) and how SSH is set up. */
export const GET = route({ auth: "admin" }, () => liveLogins());
