import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { invalidateOverview } from "@/server/system/overview";
import { setHostname } from "@/server/system/time";

const body = z.object({ hostname: z.string().min(1, "Enter a name for the server.").max(253) });

/** Rename the server (hostnamectl + /etc/hosts, backed up to /etc/hosts.gluon-backup). */
export const PUT = route({ auth: "admin", recent: true, body }, async ({ body, user, ip, zone }) => {
  const r = await setHostname(body.hostname);
  invalidateOverview();
  if (r.previous !== r.hostname) audit(user, { action: "system.hostname", target: "server", summary: `Renamed the server to ${r.hostname}`, detail: { from: r.previous, to: r.hostname } }, { ip, zone });
  return r;
});
