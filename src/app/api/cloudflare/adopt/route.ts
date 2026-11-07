import { z } from "zod";
import { route } from "@/server/api";
import { adopt } from "@/server/cloudflare/service";

/** Let Gluon change records it didn't make, at these names. */
export const POST = route({ auth: "admin", recent: true, body: z.object({ names: z.array(z.string().trim().min(1).max(253)).min(1).max(200) }) }, ({ user, body, ip, zone }) => adopt(user, { ip, zone }, body.names));
