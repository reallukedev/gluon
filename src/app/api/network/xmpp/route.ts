import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { tryReadConfig } from "@/server/caddy/routes";
import { invalidateStatus } from "@/server/network/status";
import { certSyncState, syncChatCertificates } from "@/server/network/xmpp-certs";
import { chatServerCandidates } from "@/server/network/xmpp-servers";
import type { XmppCertSync } from "@/lib/network-types";

function syncStates(): Record<string, XmppCertSync> {
  const out: Record<string, XmppCertSync> = {};
  for (const r of tryReadConfig()?.routes ?? []) {
    const s = r.type === "subdomain" && r.xmpp?.cert_sync ? certSyncState(r.id) : null;
    if (s) out[r.id] = s;
  }
  return out;
}

/** Chat servers Gluon can see on this host, and where each chat address's certificate sync stands. */
export const GET = route({ auth: "admin" }, async () => ({ servers: await chatServerCandidates(), sync: syncStates() }));

/** Compare and copy certificates now instead of waiting for the next scheduled check. */
export const POST = route({ auth: "admin" }, async ({ user, ip, zone }) => {
  await syncChatCertificates();
  invalidateStatus();
  const sync = syncStates();
  const failed = Object.values(sync).filter((s) => !s.ok).length;
  audit(user, { action: "network.xmpp.sync", summary: failed ? `Checked chat server certificates (${failed} need attention)` : "Checked chat server certificates", outcome: failed ? "failed" : "ok" }, { ip, zone });
  return { sync };
});
