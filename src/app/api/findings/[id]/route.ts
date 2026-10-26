import { z } from "zod";
import { route } from "@/server/api";
import { dismiss, getFinding, snooze, undismiss } from "@/server/findings";
import { notFound } from "@/server/errors";
import { audit } from "@/server/audit";

const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("snooze"), hours: z.number().min(1).max(24 * 30) }),
  z.object({ op: z.literal("dismiss") }),
  z.object({ op: z.literal("restore") }),
]);

export const POST = route({ auth: "admin", body }, ({ params, body, user, ip, zone }) => {
  const id = decodeURIComponent(String(params.id));
  const f = getFinding(id);
  if (!f) throw notFound("That item");
  if (body.op === "snooze") {
    snooze(id, Date.now() + body.hours * 3_600_000);
    audit(user, { action: "finding.snoozed", target: f.subject, summary: `Snoozed “${f.title}” for ${body.hours < 24 ? `${body.hours} h` : `${Math.round(body.hours / 24)} days`}` }, { ip, zone });
  } else if (body.op === "dismiss") {
    dismiss(id, user.id);
    audit(user, { action: "finding.dismissed", target: f.subject, summary: `Marked “${f.title}” as not a problem` }, { ip, zone });
  } else {
    undismiss(id);
  }
  return getFinding(id);
});
