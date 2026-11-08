import { route } from "@/server/api";
import { overview } from "@/server/router/monitor";

/** Asking also tells Gluon someone is looking, so it reads the router more often for a while. */
export const GET = route({ auth: "admin" }, async () => overview({ waitMs: 4000 }));
