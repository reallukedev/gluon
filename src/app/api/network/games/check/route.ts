import { route } from "@/server/api";
import { gamesStatus } from "@/server/games/service";

/** Ping every address through mc-router and look up their DNS again, now. */
export const POST = route({ auth: "admin", burst: { limit: 6, windowMs: 60_000 } }, async () => gamesStatus({ force: true }));
