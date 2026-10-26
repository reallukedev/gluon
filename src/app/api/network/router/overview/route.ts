import { route } from "@/server/api";
import { overview } from "@/server/router/monitor";

/**
 * Everything the router says about the internet connection, devices, Wi-Fi and firewall, from
 * Gluon's cache. Asking also tells Gluon someone is looking, so it reads more often for a while.
 */
export const GET = route({ auth: "admin" }, async () => overview({ waitMs: 4000 }));
