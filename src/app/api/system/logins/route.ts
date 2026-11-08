import { route } from "@/server/api";
import { liveLogins } from "@/server/system/logins";

export const GET = route({ auth: "admin" }, () => liveLogins());
