import "server-only";
import { docker } from "../../docker/client";
import { recentDies, explainExit } from "../../docker/events";
import type { AppSummary, ContainerSummary } from "../../docker/apps";
import { httpAnswer } from "./probes";
import { apps } from "./addresses";
import { act, fail, go, kv, ms, ok, skip, warn, type CheckCtx, type CheckSpec, type Outcome } from "./core";
import { explainConnectError } from "../../network/probes";

/** Apps: containers crash-looping, unhealthy or restarting, and whether each app's web port answers. */

export const appHref = (id: string, tab?: string) => `/apps/${encodeURIComponent(id)}${tab ? `?tab=${tab}` : ""}`;

export interface ContainerVerdict {
  c: ContainerSummary;
  problem: "crashing" | "unhealthy" | "restarting" | "exited" | "starting" | null;
  dies: number;
  exitCode: number | null;
  policy: string | null;
}

/** Inspect only exited containers (restart policy + exit code decide whether it's a surprise). */
export async function containerVerdicts(app: AppSummary): Promise<ContainerVerdict[]> {
  return Promise.all(
    app.containers.map(async (c): Promise<ContainerVerdict> => {
      const dies = recentDies(c.name);
      if (c.state === "restarting") return { c, problem: "restarting", dies, exitCode: null, policy: null };
      if (dies >= 3) return { c, problem: "crashing", dies, exitCode: null, policy: null };
      if (c.health === "unhealthy") return { c, problem: "unhealthy", dies, exitCode: null, policy: null };
      if (c.health === "starting") return { c, problem: "starting", dies, exitCode: null, policy: null };
      if (c.state === "exited" || c.state === "dead") {
        try {
          const info = await docker().getContainer(c.id).inspect();
          const policy = info.HostConfig.RestartPolicy?.Name ?? "no";
          const code = info.State.ExitCode;
          const meant = policy === "always" || policy === "unless-stopped" || policy === "on-failure";
          return { c, problem: meant && code !== 0 && code !== 143 ? "exited" : null, dies, exitCode: code, policy };
        } catch {
          return { c, problem: null, dies, exitCode: null, policy: null };
        }
      }
      return { c, problem: null, dies, exitCode: null, policy: null };
    }),
  );
}

const partName = (app: AppSummary, c: ContainerSummary) => (app.containers.length > 1 ? `${app.name} (${c.service ?? c.name})` : app.name);

export function containerEvidence(vs: ContainerVerdict[]): string {
  return vs.map((v) => `${v.c.name.padEnd(28)}  ${v.c.state}${v.c.health ? ` · ${v.c.health}` : ""}${v.dies ? ` · ${v.dies} crash${v.dies === 1 ? "" : "es"} in 15 min` : ""}${v.exitCode !== null ? ` · exit ${v.exitCode}` : ""}  ${v.c.status}`).join("\n");
}

/** The containers' side of an app: running, healthy, not crash-looping. */
export function containersOutcome(app: AppSummary, vs: ContainerVerdict[]): Outcome {
  const evidence = containerEvidence(vs);
  const findings = app.containers.map((c) => `app.broken:${c.name}`);
  const logs = go("Read the logs", appHref(app.id, "logs"));
  const bad = vs.find((v) => v.problem === "crashing" || v.problem === "restarting") ?? vs.find((v) => v.problem === "unhealthy") ?? vs.find((v) => v.problem === "exited");
  if (bad) {
    const who = partName(app, bad.c);
    if (bad.problem === "crashing" || bad.problem === "restarting") return fail(`${who} keeps crashing`, { detail: `It restarted ${bad.dies || "several"} time${bad.dies === 1 ? "" : "s"} in the last 15 minutes. The logs usually say why.`, evidence, findings, fix: logs });
    if (bad.problem === "unhealthy") return fail(`${who} is failing its own health check`, { detail: "It's running but may not be responding. Restarting often clears it; the logs say why it happened.", evidence, findings, fix: act(`Restart ${app.name}`, "apps.restart", { id: app.id }) });
    return fail(`${who} stopped unexpectedly`, { detail: `It ${explainExit(bad.exitCode)}.`, evidence, findings, fix: act(`Start ${app.name}`, "apps.start", { id: app.id }) });
  }
  const running = vs.filter((v) => v.c.state === "running").length;
  if (!running) return skip(`${app.name} is stopped`, { detail: "It was stopped on purpose (it exited cleanly), so it wasn't checked further.", evidence });
  const starting = vs.find((v) => v.problem === "starting");
  if (starting) return warn(`${partName(app, starting.c)} is still starting`, { detail: "Its health check hasn't passed yet. Check again in a minute.", evidence });
  return ok(`${app.name} is running${vs.length > 1 ? ` (${running} of ${vs.length} parts)` : ""}`, { evidence });
}

/** Does the app's web port answer HTTP? */
export async function webPortOutcome(app: AppSummary): Promise<Outcome | null> {
  if (!app.webPort) return null;
  const a = await httpAnswer(app.webPort, { timeoutMs: 5000 });
  const evidence = kv([
    ["Request", `GET http://127.0.0.1:${app.webPort}/`],
    ["Answer", a.status ? `HTTP ${a.status} in ${ms(a.ms)}${a.location ? ` → ${a.location}` : ""}` : (a.code ?? a.error)],
    ["Server", a.server],
  ]);
  if (!a.status) {
    return fail(`${app.name} doesn't answer on port ${app.webPort}`, {
      value: a.code === "ETIMEDOUT" ? "timeout" : "closed",
      detail: `${explainConnectError(a.code)[0]!.toUpperCase()}${explainConnectError(a.code).slice(1)}. The app may still be starting, or it crashed inside its container.`,
      evidence,
      findings: app.containers.map((c) => `app.broken:${c.name}`),
      fix: act(`Restart ${app.name}`, "apps.restart", { id: app.id }),
    });
  }
  if (a.status >= 500) return warn(`${app.name} answers on port ${app.webPort} with an error (HTTP ${a.status})`, { value: String(a.status), detail: "The app is up but something inside it is failing. Its logs say what.", evidence, fix: go("Read the logs", appHref(app.id, "logs")) });
  return ok(`${app.name} answers on port ${app.webPort} (${ms(a.ms)})`, { value: ms(a.ms), evidence });
}

function appCheck(appId: string, name: string, group: string): CheckSpec {
  return {
    id: `apps.app:${appId}`,
    group,
    label: name,
    run: async (ctx: CheckCtx) => {
      const app = (await apps(ctx)).find((a) => a.id === appId);
      if (!app) return skip(`${name} is gone`);
      const vs = await containerVerdicts(app);
      const c = containersOutcome(app, vs);
      if (c.state !== "ok" && c.state !== "warn") return c;
      const web = await webPortOutcome(app);
      if (!web) return c;
      if (web.state === "ok" && c.state === "ok") return ok(`${app.name} is running and answers on port ${app.webPort}`, { value: web.value, evidence: `${c.evidence}\n\n${web.evidence}` });
      return { ...(web.state === "ok" ? c : web), evidence: `${c.evidence}\n\n${web.evidence}` };
    },
  };
}

export async function appChecks(list: AppSummary[]): Promise<CheckSpec[]> {
  if (!list.length) return [{ id: "apps.none", group: "apps", label: "Apps", run: async () => skip("No apps were found in Docker") }];
  return list
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => appCheck(a.id, a.name, "apps"));
}
