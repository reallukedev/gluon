import { route } from "@/server/api";
import { publishSite } from "@/server/sites/service";
import { publishSchema, siteId } from "../../_shared";

export const POST = route({ auth: "admin", recent: true, body: publishSchema }, ({ user, params, body, ip, zone }) => publishSite(user, { ip, zone }, siteId(params), body));
