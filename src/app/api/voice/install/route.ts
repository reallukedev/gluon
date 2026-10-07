import { z } from "zod";
import { route } from "@/server/api";
import { installDefaults, startVoiceInstall } from "@/server/voice/install";

/** Starting values for a new voice server, and the ports already taken. */
export const GET = route({ auth: "admin" }, () => installDefaults());

const body = z.object({
  name: z.string().trim().min(1, "Give it a name.").max(60, "Keep the name under 60 characters."),
  welcome: z.string().max(5000, "Keep the welcome message under 5,000 characters."),
  password: z.string().max(128).refine((v) => !/[\r\n]/.test(v), "Keep the password on one line."),
  port: z.number().int().min(1024, "Use a port from 1024 up.").max(65535, "Use a port up to 65535."),
});

/** Create the builder draft. The page publishes it (/api/custom-apps/<draftId>/publish), then calls ./finish. */
export const POST = route({ auth: "admin", recent: true, body }, ({ body, user, ip, zone }) => startVoiceInstall(body, user, { ip, zone }));
