import { z } from "zod";
import { route } from "@/server/api";
import { param } from "@/app/api/docker/params";
import { applySettings } from "@/server/chat/service";

const host = z.string().regex(/^[a-z0-9.-]{1,253}$/, "That isn't a valid address.");
const settings = z.object({
  signUp: z.enum(["closed", "invite", "open"]),
  history: z.enum(["off", "1w", "1m", "3m", "1y", "never", "custom"]),
  groups: z.object({ on: z.boolean(), host, whoCreates: z.enum(["everyone", "admins"]) }),
  files: z.object({ on: z.boolean(), host, maxMb: z.number().int().min(1).max(2048), keepDays: z.number().int().min(0).max(3650) }),
  push: z.boolean(),
  federation: z.boolean(),
  web: z.boolean(),
  calls: z.object({ on: z.boolean(), host }).optional(),
  welcome: z.string().trim().max(1000).nullable(),
  contact: z
    .string()
    .trim()
    .max(300)
    .regex(/^(?:(?:xmpp:|mailto:)?[^\s@]+@[^\s@]+|https?:\/\/\S+)$/, "Use a chat or email address, like you@example.com.")
    .nullable()
    .or(z.literal("").transform(() => null)),
});

const body = z.object({ host, settings, restart: z.boolean().default(false), rev: z.string().max(64).nullish() });

export const PUT = route({ auth: "admin", recent: true, body }, async ({ params, body, user, ip, zone }) => {
  const appId = param(params.app);
  return applySettings(user, { ip, zone }, appId, body.host, body.settings, body.restart, body.rev ?? null);
});
