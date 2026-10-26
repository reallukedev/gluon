import { route } from "@/server/api";
import { editGamePort, removeGamePort } from "@/server/games/service";
import { gamePortBody } from "../schema";

const idOf = (p: Record<string, string | string[]>) => String(p.id).slice(0, 16);

export const PATCH = route({ auth: "admin", body: gamePortBody }, async ({ body, params, user, ip, zone }) => editGamePort(user, { ip, zone }, idOf(params), body));

/** Remove a game port. Its forward on the router stays until it's stopped in Port forwarding. */
export const DELETE = route({ auth: "admin", recent: true }, async ({ params, user, ip, zone }) => removeGamePort(user, { ip, zone }, idOf(params)));
