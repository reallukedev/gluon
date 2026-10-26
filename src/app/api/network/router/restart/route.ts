import { route } from "@/server/api";
import { restartRouter } from "@/server/router/service";

/** Restart the router. Answers once the button is pressed; the overview reports when it's back. */
export const POST = route({ auth: "admin", recent: true, burst: { limit: 2, windowMs: 5 * 60_000 } }, async ({ user, ip, zone }) => restartRouter(user, { ip, zone }));
