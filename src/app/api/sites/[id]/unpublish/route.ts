import { route } from "@/server/api";
import { unpublishSite } from "@/server/sites/service";
import { siteId } from "../../_shared";

/** Turn the address off and keep everything else. */
export const POST = route({ auth: "admin" }, ({ user, params, ip, zone }) => unpublishSite(user, { ip, zone }, siteId(params)));
