import { z } from "zod";
import { route } from "@/server/api";
import { startUpdate } from "@/server/updates";

const body = z.object({ method: z.enum(["github", "umbrel", "casaos"]) });

/** Start updating Gluon. It restarts itself when the new version is ready. */
export const POST = route({ auth: "admin", body, recent: true }, ({ user, body, ip, zone }) => startUpdate({ method: body.method, user, auto: false, where: { ip, zone } }));
