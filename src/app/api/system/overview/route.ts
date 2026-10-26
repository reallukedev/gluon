import { route } from "@/server/api";
import { systemOverview } from "@/server/system/overview";

/** Hostname, OS, kernel, hardware, uptime, time sync, temperatures, versions, reboot status. */
export const GET = route({ auth: "admin" }, () => systemOverview());
