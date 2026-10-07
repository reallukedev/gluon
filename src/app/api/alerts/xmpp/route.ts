import { route } from "@/server/api";
import { xmppServers } from "@/server/notify/xmpp";

/**
 * Chat servers Gluon runs, for the XMPP channel form: their domains, and (admins) the accounts and
 * group chats to suggest as recipients. Household members only see the domains.
 */
export const GET = route({ auth: "user" }, async ({ user }) => {
  const r = await xmppServers();
  if (user.role === "admin") return r;
  return { servers: r.servers.map((s) => ({ ...s, domains: s.domains.map((d) => ({ domain: d.domain, accounts: [], rooms: [] })) })) };
});
