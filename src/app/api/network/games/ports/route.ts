import { route } from "@/server/api";
import { addGamePort } from "@/server/games/service";
import { gamePortBody } from "./schema";

export const POST = route({ auth: "admin", body: gamePortBody, burst: { limit: 20, windowMs: 60_000 } }, async ({ body, user, ip, zone }) => addGamePort(user, { ip, zone }, body));
