import { z } from "zod";
import { route } from "@/server/api";
import { AppError } from "@/server/errors";
import { hasRecentAuth } from "@/server/auth/session";
import { audit } from "@/server/audit";
import { CHANNEL_KINDS, defaultKinds } from "@/lib/alerts-types";
import { createChannel, listChannelsFor, viewChannel } from "@/server/notify/channels";
import { setSubscription } from "@/server/notify/subscriptions";

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

export const POST = route({ auth: "user", body }, async ({ user, session, body, ip, zone }) => {
  if (body.scope === "server" && !hasRecentAuth(session)) throw new AppError("reauth", "Confirm it's you to continue.", 403);
  const ch = await createChannel(user, body);
  audit(user, { action: "notify.channel_created", target: ch.id, summary: `Added ${body.scope === "server" ? "server-wide " : ""}${ch.kind} channel “${ch.name}”` }, { ip, zone });
  // A channel nobody subscribes to sends nothing: whoever adds one gets the default straight away.
  await setSubscription(user, ch.id, { kinds: defaultKinds(user.role) }).catch(() => undefined);
  return viewChannel(ch, user);
});
