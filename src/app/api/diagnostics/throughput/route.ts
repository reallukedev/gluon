import { route, sse } from "@/server/api";
import { subscribe } from "@/server/events";
import { containerHistory, hostHistory } from "@/server/metrics/sampler";
import { interfaces } from "@/server/diagnostics/interfaces";
import { containerIndex } from "@/server/diagnostics/attribution";

async function containerApps() {
  const idx = await containerIndex(10_000);
  const out: Record<string, { name: string; appId: string | null; appName: string | null; hostNet: boolean }> = {};
  for (const m of idx.list) out[m.id] = { name: m.name, appId: m.appId, appName: m.appName, hostNet: m.hostNet };
  return out;
}

/**
 * Live throughput. Events:
 *  snapshot   { host: HostSample[], containers: {t,list}[], interfaces: InterfaceInfo[], containerApps }
 *  host       HostSample (every 2 s; net.ifaces has per-interface rx/tx bytes/s)
 *  containers { t, list: ContainerSample[] } (every 5 s; rx/tx null for host-network containers)
 *  interfaces { interfaces: InterfaceInfo[], containerApps } (every 15 s)
 */
export const GET = route({ auth: "admin" }, ({ req }) =>
  sse(req, async (send) => {
    const [ifs, apps] = await Promise.all([interfaces(), containerApps()]);
    send("snapshot", { host: hostHistory(), containers: containerHistory(), interfaces: ifs, containerApps: apps });
    const offs = [subscribe("metrics.host", (d) => send("host", d)), subscribe("metrics.containers", (d) => send("containers", d))];
    const timer = setInterval(() => {
      void Promise.all([interfaces(), containerApps()]).then(([i, a]) => send("interfaces", { interfaces: i, containerApps: a }), () => undefined);
    }, 15_000);
    return () => {
      clearInterval(timer);
      offs.forEach((o) => o());
    };
  }),
);
