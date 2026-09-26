import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { getChannel } from "@/server/notify/channels";
import { listSubscriptions, quietState, removeSubscription, setSubscription } from "@/server/notify/subscriptions";
import type { SubscriptionView } from "@/lib/alerts-types";

/** The viewer's own subscriptions, the channels they may use, and app choices for the subjects picker. */
export const GET = route({ auth: "user" }, ({ user }) => listSubscriptions(user));

const put = z.object({
  channelId: z.string().min(1).max(64),
  /** See subscriptionFilterSchema in lib/alerts-types (validated server-side; members are narrowed). */
  filter: z.record(z.string(), z.unknown()).default({}),
});

export const PUT = route({ auth: "user", body: put }, async ({ user, body, ip, zone }): Promise<SubscriptionView> => {
  const filter = await setSubscription(user, body.channelId, body.filter);
  const ch = getChannel(body.channelId)!;
  audit(user, { action: "notify.subscription_set", target: ch.id, summary: `Changed which alerts go to “${ch.name}”` }, { ip, zone });
  return { channelId: ch.id, channelName: ch.name, channelKind: ch.kind, filter, quietNow: quietState(filter, Date.now()).quiet };
});

const del = z.object({ channelId: z.string().min(1).max(64) });

export const DELETE = route({ auth: "user", body: del }, ({ user, body, ip, zone }) => {
  removeSubscription(user, body.channelId);
  const ch = getChannel(body.channelId);
  audit(user, { action: "notify.subscription_removed", target: body.channelId, summary: `Stopped alerts to “${ch?.name ?? "a channel"}”` }, { ip, zone });
  return { ok: true };
});
