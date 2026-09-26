import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { getSetting, setSetting } from "@/server/settings";

const body = z.object({
  auto: z.boolean(),
  channel: z.enum(["releases", "main"]),
  hour: z.number().int().min(0).max(23),
  method: z.enum(["github", "umbrel", "casaos"]),
});

/** Automatic updates install code from the internet as root, so changing them asks for the password again. */
export const PUT = route({ auth: "admin", body, recent: true }, ({ user, body, ip, zone }) => {
  const before = getSetting("updates");
  setSetting("updates", body);
  const what = body.auto !== before.auto ? (body.auto ? "Turned on automatic updates" : "Turned off automatic updates") : "Changed how Gluon updates";
  audit(user, { action: "gluon.update.settings", target: "gluon", summary: what, detail: { before, after: body } }, { ip, zone });
  return body;
});
