import { z } from "zod";
import { route } from "@/server/api";
import { AppError } from "@/server/errors";
import { CHANNEL_KINDS } from "@/lib/alerts-types";
import { testChannel } from "@/server/notify/channels";

/**
 * Send a test message. Either a saved channel (`id`, optionally with unsaved edits in `config`) or a
 * channel that isn't saved yet (`kind` + `config`). Nothing is stored; the only effect is the send.
 */
const body = z.object({
  id: z.string().max(64).optional(),
  kind: z.enum(CHANNEL_KINDS).optional(),
  scope: z.enum(["server", "personal"]).default("personal"),
  config: z.record(z.string(), z.unknown()).optional(),
});

type G = typeof globalThis & { __gluonTestSends?: Map<string, number[]> };
const g = globalThis as G;

/** At most 6 test sends a minute per person (it's easy to double-click, hard to un-spam a phone). */
function throttle(userId: string) {
  const m = (g.__gluonTestSends ??= new Map<string, number[]>());
  const t = Date.now();
  const recent = (m.get(userId) ?? []).filter((x: number) => t - x < 60_000);
  if (recent.length >= 6) throw new AppError("rate_limited", "That's a lot of test messages. Wait a minute and try again.", 429);
  recent.push(t);
  m.set(userId, recent);
}

export const POST = route({ auth: "user", body }, async ({ user, body }) => {
  throttle(user.id);
  return testChannel(user, body);
});
