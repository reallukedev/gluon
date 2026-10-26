import { z } from "zod";
import { route } from "@/server/api";
import { deleteSite, renameSite, siteDetail } from "@/server/sites/service";
import { siteId } from "../_shared";

export const GET = route({ auth: "admin" }, ({ params }) => siteDetail(siteId(params)));

export const PATCH = route({ auth: "admin", body: z.object({ name: z.string().max(200) }) }, ({ user, params, body, ip, zone }) => renameSite(user, { ip, zone }, siteId(params), body.name));

/** The site, its address, every published version and the draft. */
export const DELETE = route({ auth: "admin", recent: true }, ({ user, params, ip, zone }) => deleteSite(user, { ip, zone }, siteId(params)));
