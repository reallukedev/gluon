import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { AppError } from "@/server/errors";
import { listTimezones, setNtp, setTimezone, timeStatus } from "@/server/system/time";

/** Clock status plus the list of timezones for the picker. */
export const GET = route({ auth: "admin" }, async () => {
  const [status, timezones] = await Promise.all([timeStatus(), listTimezones().catch(() => [] as string[])]);
  return { ...status, timezones };
});

const body = z.object({
  timezone: z.string().min(1).max(64).regex(/^[A-Za-z0-9_+\-/]+$/, "Choose a timezone from the list.").optional(),
  ntp: z.boolean().optional(),
});

export const PUT = route({ auth: "admin", body }, async ({ body, user, ip, zone }) => {
  if (body.timezone === undefined && body.ntp === undefined) throw new AppError("invalid", "Nothing to change.", 400);
  const before = await timeStatus();
  if (body.timezone !== undefined && body.timezone !== before.timezone) {
    await setTimezone(body.timezone);
    audit(user, { action: "system.timezone", target: "server", summary: `Changed the timezone to ${body.timezone}`, detail: { from: before.timezone, to: body.timezone } }, { ip, zone });
  }
  if (body.ntp !== undefined && body.ntp !== before.ntp) {
    await setNtp(body.ntp);
    audit(user, { action: "system.ntp", target: "server", summary: body.ntp ? "Turned on automatic time" : "Turned off automatic time" }, { ip, zone });
  }
  return timeStatus();
});
