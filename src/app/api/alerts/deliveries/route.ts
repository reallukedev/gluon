import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { listDeliveries, retryDelivery } from "@/server/notify/log";
import { DELIVERY_EVENTS } from "@/lib/alerts-types";

/** Sent history (and queued/failed messages). Admins see all; members their own channels. */
const query = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  channel: z.string().max(64).optional(),
  status: z.enum(["pending", "sent", "failed", "cancelled"]).optional(),
  event: z.enum(DELIVERY_EVENTS).optional(),
  finding: z.string().max(300).optional(),
});

export const GET = route({ auth: "user", query }, ({ user, query }) => listDeliveries(user, query));

const body = z.object({ op: z.literal("retry"), id: z.number().int().positive() });

export const POST = route({ auth: "user", body }, ({ user, body, ip, zone }) => {
  const entry = retryDelivery(user, body.id);
  audit(user, { action: "notify.retry", target: entry.channelId, summary: `Sent “${entry.title}” to ${entry.channelName} again` }, { ip, zone });
  return entry;
});
