import { z } from "zod";
import { route } from "@/server/api";
import { runRemedy, remedyNeedsRecentAuth } from "@/server/alerts/engine";
import { hasRecentAuth } from "@/server/auth/session";
import { AppError } from "@/server/errors";

const body = z.object({
  action: z.string().min(1).max(80),
  params: z.record(z.string(), z.unknown()).default({}),
  findingId: z.string().max(300).nullable().default(null),
});

export const POST = route({ auth: "admin", body }, async ({ body, user, session, ip, zone }) => {
  if (remedyNeedsRecentAuth(body.action) && !hasRecentAuth(session)) throw new AppError("reauth", "Confirm it's you to continue.", 403);
  return runRemedy(user, body.action, body.params, body.findingId, { ip, zone });
});
