import "server-only";
import YAML from "yaml";

/**
 * Whether a freshly started app is up. Only running counts (and healthy, for containers with a
 * health check). A container that exits, even cleanly, is a failure unless the compose file says
 * it's a one-off job: another service waits for it with `condition: service_completed_successfully`,
 * or it carries the label `gluon.one-shot: "true"`.
 */

export function oneShotServices(composeText: string): Set<string> {
  const out = new Set<string>();
  let doc: { services?: Record<string, Record<string, unknown> | null> };
  try {
    doc = YAML.parse(composeText, { merge: true }) ?? {};
  } catch {
    return out;
  }
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    if (!svc) continue;
    const deps = svc.depends_on;
    if (deps && typeof deps === "object" && !Array.isArray(deps)) {
      for (const [dep, cfg] of Object.entries(deps as Record<string, { condition?: string } | null>)) if (cfg?.condition === "service_completed_successfully") out.add(dep);
    }
    const labels = svc.labels;
    const flag = Array.isArray(labels) ? labels.some((l) => /^gluon\.one-shot=(true|1|yes)$/i.test(String(l))) : labels && typeof labels === "object" ? /^(true|1|yes)$/i.test(String((labels as Record<string, unknown>)["gluon.one-shot"] ?? "")) : false;
    if (flag) out.add(name);
  }
  return out;
}

export interface ContainerState {
  name: string;
  service: string | null;
  status: string;
  exitCode: number;
  health: string | null;
  restartCount: number;
}

export interface Assessment {
  bad: { name: string; why: string }[];
  waiting: number;
}

/** One look at the new app's containers. `firstRestarts` remembers each one's count from the first look. */
export function assess(cs: ContainerState[], firstRestarts: Map<string, number>, oneShot: Set<string>): Assessment {
  const bad: Assessment["bad"] = [];
  let waiting = 0;
  for (const c of cs) {
    const first = firstRestarts.get(c.name) ?? c.restartCount;
    firstRestarts.set(c.name, first);
    if (c.restartCount - first >= 2) bad.push({ name: c.name, why: "keeps restarting" });
    else if (c.status === "exited" || c.status === "dead") {
      if (c.exitCode === 0 && c.service && oneShot.has(c.service)) continue; // a one-off job that finished
      bad.push({ name: c.name, why: c.exitCode === 0 ? "stopped right after starting" : `stopped with code ${c.exitCode}` });
    } else if (c.health === "unhealthy") bad.push({ name: c.name, why: "fails its health check" });
    else if (c.status !== "running" || c.health === "starting") waiting++;
  }
  return { bad, waiting };
}
