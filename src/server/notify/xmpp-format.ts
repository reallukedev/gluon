/**
 * What an XMPP message says. Chat apps show plain text only, so: the title, one line of the body
 * (a summary or a list keeps a few lines), and the link on its own line so apps make it tappable.
 */

export interface XmppOut {
  title: string;
  body: string;
  link: string | null;
  event: string;
}

/** The account Gluon sends from on a chat server it runs: gluon@<domain>. */
export const XMPP_SENDER = "gluon";

const MAX_LINE = 280;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function xmppText(m: XmppOut): string {
  const lines = m.body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const list = lines.length > 1 && lines.every((l) => /^[•…]/.test(l));
  const keep = m.event === "digest" ? 8 : list ? 6 : 1;
  const body = lines.slice(0, keep).map((l) => clip(l, MAX_LINE));
  if (lines.length > keep && keep > 1) body.push("…");
  return [clip(m.title.trim(), MAX_LINE), ...body, m.link ?? ""].filter(Boolean).join("\n");
}

/** "chat.example.com", "chat.example.com:5223", "[2001:db8::1]:5222" → host and port (default 5222). */
export function splitServer(s: string): { host: string; port: number } | null {
  const v = s.trim();
  if (!v) return null;
  const m = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(v) ?? /^([a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(v);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : 5222;
  if (port < 1 || port > 65535) return null;
  return { host: m[1]!.toLowerCase(), port };
}
