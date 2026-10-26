import type { ChannelKind } from "@/lib/alerts-types";

export const FINDINGS_URL = "/api/findings?view=all";
export const MONITORS_URL = "/api/alerts/monitors";
export const CHANNELS_URL = "/api/alerts/channels";

export const KIND_LABEL: Record<ChannelKind, string> = { ntfy: "ntfy", pushover: "Pushover", email: "Email", webhook: "Webhook", xmpp: "XMPP" };

/** Group items into days (newest first), keyed by the viewer's local calendar day. */
export function byDay<T>(items: T[], at: (t: T) => number, dayOf: (ts: number) => string): { day: string; ts: number; items: T[] }[] {
  const out: { day: string; ts: number; items: T[] }[] = [];
  for (const it of items) {
    const ts = at(it);
    const day = dayOf(ts);
    const last = out[out.length - 1];
    if (last && last.day === day) last.items.push(it);
    else out.push({ day, ts, items: [it] });
  }
  return out;
}

export const errorMessage = (e: unknown, fallback = "That didn't work.") => (e instanceof Error ? e.message : fallback);

/** "Today", "Yesterday", or the weekday + date in the viewer's format. */
export function dayLabel(ts: number, date: (ts: number, o?: { year?: boolean; weekday?: boolean }) => string): string {
  const now = Date.now();
  const d = date(ts);
  if (d === date(now)) return "Today";
  if (d === date(now - 86_400_000)) return "Yesterday";
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return date(ts, { weekday: true, year: !sameYear });
}
