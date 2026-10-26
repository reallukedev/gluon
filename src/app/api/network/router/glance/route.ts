import { route } from "@/server/api";
import { glance } from "@/server/router/monitor";

/** For Home: is broadband up, how many devices are online, whole-home traffic now. Nothing identifying. */
export const GET = route({ auth: "user" }, async () => glance());
