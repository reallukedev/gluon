import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { notFound } from "@/server/errors";
import { resolve } from "@/server/findings";
import { canSee, deleteChannel, getChannel, updateChannel, viewChannel } from "@/server/notify/channels";

export const GET = route({ auth: "user" }, ({ user, params }) => {
  const ch = getChannel(String(params.id));
  if (!ch || !canSee(user, ch)) throw notFound("That channel");
  return viewChannel(ch, user);
});

const patch = z.object({
  name: z.string().trim().min(1, "Give it a name.").max(60).optional(),
  enabled: z.boolean().optional(),
  /** Only the fields you change; secrets left out (or sent back masked) are kept. */
  config: z.record(z.string(), z.unknown()).optional(),
});

export const PATCH = route({ auth: "user", body: patch }, async ({ user, params, body, ip, zone }) => {
  const ch = await updateChannel(user, String(params.id), body);
  if (body.enabled === false) resolve(`notify.channel:${ch.id}`, `Alerts to “${ch.name}” were turned off`);
  const what = body.config ? "Changed settings of" : body.enabled === false ? "Turned off" : body.enabled === true ? "Turned on" : "Renamed";
  audit(user, { action: "notify.channel_updated", target: ch.id, summary: `${what} channel “${ch.name}”` }, { ip, zone });
  return viewChannel(ch, user);
});

export const DELETE = route({ auth: "user" }, ({ user, params, ip, zone }) => {
  const ch = deleteChannel(user, String(params.id));
  resolve(`notify.channel:${ch.id}`, `Channel “${ch.name}” was removed`);
  audit(user, { action: "notify.channel_deleted", target: ch.id, summary: `Removed channel “${ch.name}”` }, { ip, zone });
  return { ok: true };
});
