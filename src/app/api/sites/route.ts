import { z } from "zod";
import { route } from "@/server/api";
import { createSite, listSites } from "@/server/sites/service";

export const GET = route({ auth: "admin" }, () => listSites());

export const POST = route({ auth: "admin", body: z.object({ name: z.string().max(200), start: z.enum(["starter", "empty"]) }) }, ({ user, body, ip, zone }) => createSite(user, { ip, zone }, body));
