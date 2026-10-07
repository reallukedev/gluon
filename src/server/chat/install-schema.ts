import { z } from "zod";
import { DOMAIN_RE, installSettings } from "./recipe";

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** What the chat server install flow sends. */
export const installBody = z.object({
  domain: z.string().trim().toLowerCase().regex(DOMAIN_RE, "Enter a domain like chat.example.com."),
  username: z.string().trim().toLowerCase().regex(USERNAME_RE, "Use lowercase letters, numbers, dots, dashes or underscores."),
  signUp: z.enum(["closed", "invite", "open"]).default("invite"),
  groups: z.boolean().default(true),
  files: z.boolean().default(true),
  push: z.boolean().default(true),
  history: z.enum(["off", "1w", "1m", "3m", "1y", "never"]).default("3m"),
});

export const toInstall = (b: z.infer<typeof installBody>) => ({
  domain: b.domain,
  username: b.username,
  settings: installSettings(b.domain, {
    signUp: b.signUp,
    history: b.history,
    push: b.push,
    groups: { on: b.groups, host: `rooms.${b.domain}`, whoCreates: "everyone" },
    files: { on: b.files, host: `upload.${b.domain}`, maxMb: 100, keepDays: 30 },
  }),
});

