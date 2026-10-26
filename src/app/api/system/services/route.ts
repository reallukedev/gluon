import { z } from "zod";
import { route } from "@/server/api";
import { listServices } from "@/server/system/services";

/** Every systemd service with state, enabled, memory, PID and what Gluon allows for it. */
export const GET = route({ auth: "admin", query: z.object({ fresh: z.enum(["0", "1"]).optional() }) }, async ({ query }) => ({ services: await listServices({ fresh: query.fresh === "1" }) }));
