import { route } from "@/server/api";
import { interfaces } from "@/server/diagnostics/interfaces";

/** Host network interfaces with addresses, state, speed and byte counters. */
export const GET = route({ auth: "admin" }, async () => ({ interfaces: await interfaces() }));
