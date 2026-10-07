import type { XmppStatus } from "@/lib/network-types";

/** What a chat server's own checks add: faults stop people signing in, the rest is attention. */
export function xmppVerdict(x: XmppStatus): { state: "fault" | "attention"; summary: string } | null {
  const c2s = x.c2s;
  if (c2s.reachable && c2s.error) return { state: "fault", summary: `Chat apps can't sign in: ${c2s.error}.` };
  const t = c2s.tls;
  if (t?.status === "expired") return { state: "fault", summary: `${t.message} Chat apps will refuse to connect.` };
  if (t?.status === "invalid") return { state: "fault", summary: t.message };
  if (x.certSync && !x.certSync.ok) return { state: "attention", summary: x.certSync.message };
  if (x.s2s && !x.s2s.reachable) return { state: "attention", summary: `Other chat servers can't reach port ${x.s2s.port}: ${x.s2s.error}.` };
  if (x.s2s?.error) return { state: "attention", summary: `Other chat servers can't connect: ${x.s2s.error}.` };
  if (x.s2s?.tls && x.s2s.tls.status !== "ok" && x.s2s.tls.status !== "expiring") return { state: "attention", summary: `On the federation port: ${x.s2s.tls.message}` };
  if (t?.status === "expiring") return { state: "attention", summary: t.message };
  for (const srv of [x.srv.client, x.srv.server]) if (srv && (srv.status === "mismatch" || srv.status === "error")) return { state: "attention", summary: srv.message };
  if (x.web && !x.web.reachable) return { state: "attention", summary: `The chat server's web port (${x.web.port}) isn't answering, so web chat apps can't connect: ${x.web.error}.` };
  return null;
}
