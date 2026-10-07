import { z } from "zod";
import { route } from "@/server/api";
import { param } from "@/app/api/docker/params";
import { AppError } from "@/server/errors";
import { audit } from "@/server/audit";
import { createInvite, revokeInvite, USERNAME_RE } from "@/server/chat/prosody";
import { targetAndHost } from "@/server/chat/service";

const post = z.object({
  host: z.string().min(1).max(253),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(USERNAME_RE, "Use lowercase letters, numbers, dots, dashes or underscores.")
    .nullish()
    .or(z.literal("").transform(() => null)),
  role: z.enum(["member", "admin"]).default("member"),
  days: z.number().int().min(1).max(90).default(7),
  /** One link several people can use until it expires. */
  reusable: z.boolean().default(false),
});

export const POST = route({ auth: "admin", recent: true, body: post, burst: { limit: 30, windowMs: 60_000 } }, async ({ params, body, user, ip, zone }) => {
  const appId = param(params.app);
  // A shared link that leaks would let anyone make admin accounts until it expires.
  if (body.reusable && body.role === "admin") throw new AppError("invalid", "Links for several people can only make members. Invite admins one at a time.", 400, { field: "role" });
  const { t } = await targetAndHost(appId, body.host);
  const invite = await createInvite(t, { host: body.host, username: body.username ?? null, role: body.role, days: body.days, reusable: body.reusable });
  audit(
    user,
    {
      action: "chat.invite.create",
      target: appId,
      summary: `Made ${body.reusable ? "a shared" : "an"} invite link for ${body.username ? `${body.username}@${body.host}` : body.host}, valid ${body.days} day${body.days === 1 ? "" : "s"}`,
    },
    { ip, zone },
  );
  return invite;
});

const del = z.object({ host: z.string().min(1).max(253), token: z.string().min(8).max(200).regex(/^[A-Za-z0-9_-]+$/) });

export const DELETE = route({ auth: "admin", recent: true, body: del }, async ({ params, body, user, ip, zone }) => {
  const appId = param(params.app);
  const { t } = await targetAndHost(appId, body.host);
  await revokeInvite(t, body);
  audit(user, { action: "chat.invite.revoke", target: appId, summary: `Cancelled an invite link for ${body.host}` }, { ip, zone });
  return { ok: true };
});
