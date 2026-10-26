import { z } from "zod";
import { route } from "@/server/api";
import { createSite, listSites } from "@/server/sites/service";

/** Every site with its address and state. */
export const GET = route({ auth: "admin" }, () => listSites());

/** A new site, from the starter page or empty (to upload into). */
export const POST = route({ auth: "admin", body: z.object({ name: z.string().max(200), start: z.enum(["starter", "empty"]) }) }, ({ user, body, ip, zone }) => createSite(user, { ip, zone }, body));
