import { route } from "@/server/api";
import { xmppServers } from "@/server/notify/xmpp";

/** For the XMPP channel form. Household members only see the domains. */
export const GET = route({ auth: "user" }, async ({ user }) => {
  const r = await xmppServers();
  if (user.role === "admin") return r;
  return { servers: r.servers.map((s) => ({ ...s, domains: s.domains.map((d) => ({ domain: d.domain, accounts: [], rooms: [] })) })) };
});
