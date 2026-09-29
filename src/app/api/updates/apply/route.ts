import { z } from "zod";
import { route } from "@/server/api";
import { startUpdate } from "@/server/updates";

const body = z.object({
  method: z.enum(["github", "umbrel", "casaos"]),
  /** Allow going back to the newest Stable release from a build ahead of it (GitHub only). */
  allowOlder: z.boolean().optional(),
});

/** Start updating Gluon. It restarts itself when the new version is ready. */
export const POST = route({ auth: "admin", body, recent: true }, ({ user, body, ip, zone }) =>
  startUpdate({ method: body.method, allowOlder: body.allowOlder === true, user, auto: false, where: { ip, zone } }),
);
