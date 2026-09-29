import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { getSetting, setSetting } from "@/server/settings";
import { forgetCheck, reconsider, status } from "@/server/updates";
import { CHANNEL_NAME, normalizeChannel } from "@/lib/updates-types";

const body = z.object({
  auto: z.boolean(),
  /** "stable" | "nightly" ("releases" / "main" from older pages still accepted). */
  channel: z.preprocess(normalizeChannel, z.enum(["stable", "nightly"])),
  hour: z.number().int().min(0).max(23),
  method: z.enum(["github", "umbrel", "casaos"]),
  nightlyTiming: z.enum(["asap", "hour"]).default("hour"),
});

/**
 * Save how Gluon updates, and answer with the fresh status (UpdatesStatus). Switching channel
 * forgets the last check and asks GitHub again straight away. Automatic updates install code from
 * the internet as root, so changing any of this asks for the password again.
 */
export const PUT = route({ auth: "admin", body, recent: true }, async ({ user, body, ip, zone }) => {
  const before = getSetting("updates");
  const after = setSetting("updates", body);
  const switched = after.channel !== before.channel;
  if (switched) forgetCheck();

  const said: string[] = [];
  if (switched) said.push(`Switched Gluon updates to ${CHANNEL_NAME[after.channel]}`);
  if (after.auto !== before.auto) said.push(after.auto ? "Turned on automatic updates" : "Turned off automatic updates");
  if (!said.length) said.push("Changed how Gluon updates");
  audit(user, { action: switched ? "gluon.update.channel" : "gluon.update.settings", target: "gluon", summary: said.join("; "), detail: { before, after } }, { ip, zone });

  const fresh = await status(switched);
  if (switched) reconsider();
  return fresh;
});
