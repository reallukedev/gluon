import { route } from "@/server/api";
import { addGamePort } from "@/server/games/service";
import { gamePortBody } from "./schema";

/** Add a game port: a game that needs a port of its own, forwarded from the internet. */
export const POST = route({ auth: "admin", body: gamePortBody, burst: { limit: 20, windowMs: 60_000 } }, async ({ body, user, ip, zone }) => addGamePort(user, { ip, zone }, body));
