import { route } from "@/server/api";
import { gamesStatus } from "@/server/games/service";

/** Minecraft addresses through mc-router, Crafty's servers, and game ports, with the latest checks. */
export const GET = route({ auth: "admin" }, async () => gamesStatus());
