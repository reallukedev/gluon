import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { answerReport, deleteReport } from "@/server/people/household";

const patch = z
  .object({
    /** Reply shown to (and sent to) the reporter; null clears it. */
    reply: z.string().trim().max(1000, "Keep the reply under 1000 characters.").nullable().optional(),
    /** true = resolved, false = reopen. */
    resolved: z.boolean().optional(),
    /** true = the admin has seen it (the reporter sees "Seen by …"); false = back to unseen. */
    acknowledged: z.boolean().optional(),
  })
  .refine((v) => v.reply !== undefined || v.resolved !== undefined || v.acknowledged !== undefined, "Nothing to change.");

export const PATCH = route({ auth: "admin", body: patch }, async ({ user, params, body, ip, zone }) => {
  const r = await answerReport(user, String(params.id), body);
  const what =
    [body.reply ? "Replied to" : null, body.resolved === true ? "resolved" : body.resolved === false ? "reopened" : null].filter(Boolean).join(" and ") ||
    (body.acknowledged === false ? "Marked as unseen" : "Marked as seen");
  audit(user, { action: "household.report_answered", target: r.appId, summary: `${what.charAt(0).toUpperCase()}${what.slice(1)} ${r.userName ?? "someone"}'s problem report` }, { ip, zone });
  return r;
});

/** Reporter: withdraw an open report. Admin: delete any report. */
export const DELETE = route({ auth: "user" }, ({ user, params, ip, zone }) => {
  const r = deleteReport(user, String(params.id));
  audit(user, { action: "household.report_deleted", target: r.app_id, summary: user.role === "admin" && r.user_id !== user.id ? "Deleted a problem report" : "Withdrew a problem report" }, { ip, zone });
  return { ok: true };
});
