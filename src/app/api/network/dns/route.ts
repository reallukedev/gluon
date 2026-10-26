import { z } from "zod";
import { route } from "@/server/api";
import { resolveName } from "@/server/network/probes";
import { networkStatus } from "@/server/network/status";

const query = z.object({ name: z.string().min(3).max(253).regex(/^[a-z0-9.-]+$/, "That isn't a host name.") });

/** What public resolvers answer for a name, next to this network's address, for DNS help in the editors. */
export const GET = route({ auth: "admin", query, burst: { limit: 60, windowMs: 60_000 } }, async ({ query }) => {
  const status = await networkStatus({ maxAgeMs: 10 * 60_000 }).catch(() => null);
  const publicIp = status?.publicIp ?? { v4: null, v6: [] };
  return { dns: await resolveName(query.name, publicIp), publicIp: { v4: publicIp.v4, v6: publicIp.v6 } };
});
