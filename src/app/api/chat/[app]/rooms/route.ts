import { z } from "zod";
import { route } from "@/server/api";
import { param } from "@/app/api/docker/params";
import { audit } from "@/server/audit";
import { AppError } from "@/server/errors";
import { createRoom, destroyRoom, prosodyFor } from "@/server/chat/prosody";

const post = z.object({
  service: z.string().regex(/^[a-z0-9.-]{1,253}$/),
  room: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "Use lowercase letters, numbers, dots, dashes or underscores."),
  name: z.string().trim().min(1, "Give the group chat a name.").max(80),
  description: z.string().trim().max(400).nullish(),
  public: z.boolean().default(false),
  membersOnly: z.boolean().default(false),
  owner: z.string().max(300).nullish(),
});

export const POST = route({ auth: "admin", recent: true, body: post, burst: { limit: 30, windowMs: 60_000 } }, async ({ params, body, user, ip, zone }) => {
  const appId = param(params.app);
  const t = await prosodyFor(appId);
  if (body.owner && !/^[^@/\s]+@[a-z0-9.-]+$/.test(body.owner)) throw new AppError("invalid", "The owner must be a chat address like you@example.com.", 400, { field: "owner" });
  const r = await createRoom(t, { ...body, description: body.description || null, owner: body.owner || null });
  audit(user, { action: "chat.room.create", target: appId, summary: `Created group chat ${r.jid}` }, { ip, zone });
  return r;
});

const del = z.object({ jid: z.string().regex(/^[^@/\s]+@[a-z0-9.-]+$/), reason: z.string().trim().max(300).nullish() });

export const DELETE = route({ auth: "admin", recent: true, body: del }, async ({ params, body, user, ip, zone }) => {
  const appId = param(params.app);
  const t = await prosodyFor(appId);
  await destroyRoom(t, { jid: body.jid, reason: body.reason || null });
  audit(user, { action: "chat.room.delete", target: appId, summary: `Closed group chat ${body.jid}` }, { ip, zone });
  return { ok: true };
});
