import { z } from "zod";
import { route } from "@/server/api";
import { rollbackSite } from "@/server/sites/service";
import { SITE_VERSION_RE } from "@/server/caddy/routes";
import { siteId } from "../../_shared";

/** Make an earlier version live again. */
export const POST = route({ auth: "admin", recent: true, body: z.object({ version: z.string().regex(SITE_VERSION_RE, "Choose a version.") }) }, ({ user, params, body, ip, zone }) => rollbackSite(user, { ip, zone }, siteId(params), body.version));
