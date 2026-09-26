import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { createAnnouncement, listAnnouncements } from "@/server/people/household";

/** Banners for everyone. `all=1` (admins) includes ended ones. */
export const GET = route({ auth: "user", query: z.object({ all: z.enum(["0", "1"]).optional() }) }, ({ user, query }) => listAnnouncements(user, query.all === "1"));

const body = z.object({
  message: z.string().trim().min(1, "Write the announcement.").max(500, "Keep it under 500 characters."),
  appId: z.string().max(200).nullable().optional(),
  /** ms timestamp; null = until removed. */
  until: z.number().int().positive().nullable().optional(),
});

export const POST = route({ auth: "admin", body }, async ({ user, body, ip, zone }) => {
  const a = await createAnnouncement(user, body);
  audit(user, { action: "household.announcement", target: a.appId, summary: `Posted an announcement: “${a.message.slice(0, 80)}”` }, { ip, zone });
  return a;
});
