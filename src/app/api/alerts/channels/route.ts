import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { CHANNEL_KINDS } from "@/lib/alerts-types";
import { createChannel, listChannelsFor, viewChannel } from "@/server/notify/channels";

/** Channels the viewer can see: admins every channel, members their own. */
export const GET = route({ auth: "user" }, ({ user }) => listChannelsFor(user));

const body = z.object({
  kind: z.enum(CHANNEL_KINDS),
  name: z.string().trim().min(1, "Give it a name.").max(60),
  /** "server" = server-wide (admins only); "personal" = only the creator's alerts. */
  scope: z.enum(["server", "personal"]).default("personal"),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()),
});

export const POST = route({ auth: "user", body }, async ({ user, body, ip, zone }) => {
  const ch = await createChannel(user, body);
  audit(user, { action: "notify.channel_created", target: ch.id, summary: `Added ${body.scope === "server" ? "server-wide " : ""}${ch.kind} channel “${ch.name}”` }, { ip, zone });
  return viewChannel(ch, user);
});
