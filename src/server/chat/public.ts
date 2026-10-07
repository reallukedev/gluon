import "server-only";
import { listApps } from "../docker/apps";
import { peekChatInvite, prosodyFor } from "./prosody";

/**
 * The public invite page asks Prosody whether a token is live. Anyone can load that page, so
 * lookups are capped per address: a wrong guess costs a Prosody console call.
 */

type G = typeof globalThis & { __gluonChatInviteLookups?: Map<string, number[]> };
const g = globalThis as G;
const WINDOW = 10 * 60_000;
const LIMIT = 30;

function allowed(ip: string): boolean {
  const m = (g.__gluonChatInviteLookups ??= new Map());
  const now = Date.now();
  const recent = (m.get(ip) ?? []).filter((t: number) => now - t < WINDOW);
  if (recent.length >= LIMIT) return false;
  recent.push(now);
  m.delete(ip);
  m.set(ip, recent);
  // Forget the addresses seen longest ago, never everyone's count at once.
  while (m.size > 5000) m.delete(m.keys().next().value!);
  return true;
}

export async function findChatInvite(host: string, token: string, ip: string): Promise<{ host: string; expires: number; username: string | null; uri: string } | null> {
  if (!/^[a-z0-9.-]{1,253}$/.test(host) || !/^[\w-]{8,100}$/.test(token) || !allowed(ip)) return null;
  const apps = await listApps().catch(() => []);
  for (const a of apps) {
    if (!a.containers.some((c) => c.state === "running" && /(^|\/)(prosody|prosodyim)\/|(^|\/)prosody(:|$)/i.test(c.image))) continue;
    try {
      const t = await prosodyFor(a.id);
      const hit = await peekChatInvite(t, { host, token });
      if (hit) return { host, ...hit };
    } catch {
      /* this server doesn't host that domain, or isn't answering */
    }
  }
  return null;
}
