import { z } from "zod";
import { route } from "@/server/api";
import { hasRecentAuth } from "@/server/auth/session";
import { AppError } from "@/server/errors";
import { voiceAct } from "@/server/voice/service";

const session = z.number().int().min(0);
const channel = z.number().int().min(0);
const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("kick"), session, reason: z.string().max(500) }),
  z.object({ op: z.literal("move"), session, channel }),
  z.object({ op: z.literal("mute"), session, on: z.boolean() }),
  z.object({ op: z.literal("deafen"), session, on: z.boolean() }),
  z.object({ op: z.literal("channel.create"), name: z.string().max(200), parent: channel }),
  z.object({ op: z.literal("channel.update"), id: channel, name: z.string().max(200).optional(), parent: channel.optional(), description: z.string().max(10_000).optional() }),
  z.object({ op: z.literal("channel.delete"), id: channel }),
  z.object({ op: z.literal("channel.default"), id: channel }),
  z.object({ op: z.literal("registered.create"), name: z.string().max(200), password: z.string().max(200) }),
  z.object({ op: z.literal("registered.rename"), id: z.number().int().min(0), name: z.string().max(200) }),
  z.object({ op: z.literal("registered.password"), id: z.number().int().min(0), password: z.string().max(200) }),
  z.object({ op: z.literal("registered.delete"), id: z.number().int().min(0) }),
  z.object({ op: z.literal("setting"), key: z.string().max(40), value: z.string().max(20_000) }),
  z.object({ op: z.literal("setting.reset"), key: z.string().max(40) }),
]);

/** Passwords and removals ask for a recent sign-in; moving, muting and channels don't. */
const SENSITIVE = new Set(["registered.password", "registered.delete", "registered.create"]);

export const POST = route({ auth: "admin", body, burst: { limit: 60, windowMs: 60_000 } }, async ({ params, body, user, session: s, ip, zone }) => {
  if ((SENSITIVE.has(body.op) || (body.op === "setting" && body.key === "password")) && !hasRecentAuth(s)) throw new AppError("reauth", "Confirm it's you to continue.", 403);
  const message = await voiceAct(decodeURIComponent(String(params.id)), body, user, { ip, zone });
  return { ok: true, message };
});
