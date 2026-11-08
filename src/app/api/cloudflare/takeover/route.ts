import { route } from "@/server/api";
import { takeover } from "@/server/cloudflare/service";

/** Take over every name cloudflare-ddns keeps, so it can be stopped. */
export const POST = route({ auth: "admin", recent: true }, ({ user, ip, zone }) => takeover(user, { ip, zone }));
