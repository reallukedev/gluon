import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { createReport, listReports } from "@/server/people/household";

/** Members: their own reports (with replies). Admins: everyone's. */
export const GET = route({ auth: "user", query: z.object({ status: z.enum(["open", "resolved", "all"]).default("all"), limit: z.coerce.number().int().min(1).max(500).optional() }) }, ({ user, query }) =>
  listReports(user, query),
);

const body = z.object({
  appId: z.string().max(200).nullable().optional(),
  message: z.string().trim().min(1, "Say what's wrong.").max(1000, "Keep it under 1000 characters."),
});

/** "Something's wrong": raises an item for the admins and notifies them. Rate-limited per person. */
export const POST = route({ auth: "user", body }, async ({ user, body, ip, zone }) => {
  const r = await createReport(user, body);
  audit(user, { action: "household.report", target: r.appId, summary: r.appName ? `Reported a problem with ${r.appName}` : "Reported a problem" }, { ip, zone });
  return r;
});
