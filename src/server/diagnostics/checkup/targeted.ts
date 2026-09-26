import "server-only";
import { tryReadConfig, caddyRunning, routeUrl } from "../../caddy/routes";
import { FALLBACK_ID } from "../../network/routes-meta";
import { probeTls, probeHttpViaCaddy } from "../../network/probes";
import { ddnsStatus } from "../../network/ddns";
import { latestContainers, latestHost } from "../../metrics/sampler";
import { tailLogs } from "../../docker/logs";
import { docker } from "../../docker/client";
import { recentDies } from "../../docker/events";
import { smartDetail } from "../../storage/smart";
import { cleanupPreview } from "../../storage/cleanup";
import { latestUsage, startUsage } from "../../storage/usage";
import { getJob } from "../../storage/oplog";
import { notPersistent } from "../../storage/ops";
import { listUsers } from "../../auth/users";
import { getSetting } from "../../settings";
import { host } from "../../host/exec";
import { AppError } from "../../errors";
import { formatBytes, formatDuration, formatRelative, listJoin, plural } from "@/lib/format";
import type { AppSummary } from "../../docker/apps";
import type { CheckupGroup, CheckupKind } from "@/lib/diagnostics-types";
import type { UsageResult } from "@/lib/storage-types";
import { recentRequests } from "../caddy-log";
import { interfaces } from "../interfaces";
import { sampleProcesses } from "../processes";
import { dnsLookup } from "../tools";
import { act, fail, go, kv, ms, ok, skip, warn, type CheckCtx, type CheckSpec } from "./core";
import { apps, addressHref, certOutcome, displayUrl } from "./addresses";
import { appHref, containersOutcome, containerVerdicts, webPortOutcome } from "./apps";
import { gatewayCheck, httpsCheck, netStatus, systemDnsCheck, PROBE_NAME } from "./internet";
import { inventory, realFilesystems, spaceOutcome, inodeOutcome, smartOutcome } from "./storage";
import { cpuTempOutcome, loadOutcome, memoryOutcome } from "./hardware";
import { dockerDiskOutcome, updatesOutcome } from "./system";
import { adminMfaOutcome, exposure, lanOutcome, sshFailuresOutcome, sshPasswordOutcome, sshRootOutcome, gluonLoginsOutcome } from "./security";
import { cpuWindow, download, hostNameservers, httpAnswer, pingSeries, summarizeRtts } from "./probes";

/** Targeted checkups: go deeper along one path for one symptom. */

export interface Plan {
  title: string;
  layout: "sweep" | "path";
  origin: string | null;
  groups: CheckupGroup[];
  specs: CheckSpec[];
  /** Label used in the audit log. */
  subject: string | null;
}

const DETAILS: CheckupGroup = { id: "details", label: "Details" };
const PATH: CheckupGroup = { id: "path", label: "Path" };

// ---------------------------------------------------------------- an app won't open

async function findApp(id: string): Promise<AppSummary> {
  const { listApps } = await import("../../docker/apps");
  const a = (await listApps()).find((x) => x.id === id);
  if (!a) throw new AppError("not_found", "That app isn't installed any more. Pick another one.", 404);
  return a;
}

async function appPlan(appId: string): Promise<Plan> {
  const app = await findApp(appId);
  const cfg = tryReadConfig();
  const route = cfg?.routes.find((r) => r.enabled !== false && r.type === "subdomain" && app.routes.some((x) => x.id === r.id)) ?? cfg?.routes.find((r) => r.enabled !== false && r.type !== "redirect" && app.routes.some((x) => x.id === r.id));
  const publicHost = route && cfg ? (route.type === "subdomain" ? route.host : cfg.base_domain) : null;
  const specs: CheckSpec[] = [];
  const routeStatus = async (ctx: CheckCtx) => (await netStatus(ctx)).routes.find((r) => r.id === route!.id);

  if (route && publicHost && cfg) {
    specs.push({
      id: "app.dns",
      group: "path",
      hop: true,
      label: "Name",
      sub: publicHost,
      run: async (ctx) => {
        const r = await routeStatus(ctx);
        const d = r?.dns;
        if (!d) return skip("Gluon couldn't look up the name");
        const evidence = kv([["Name", d.name], ["A", d.a.join(", ")], ["AAAA", d.aaaa.join(", ")], ["Resolver", d.resolver], ["Via Cloudflare", d.proxied ? "yes" : "no"]]);
        if (d.status === "missing") return fail(`${publicHost} has no DNS record`, { value: "missing", detail: d.message, evidence, findings: [`net.dns:${publicHost}`], fix: go("See DNS", "/network?tab=dns") });
        if (d.status === "mismatch") return warn(`${publicHost} points somewhere else`, { value: "elsewhere", detail: d.message, evidence, findings: [`net.dns:${publicHost}`], fix: go("See DNS", "/network?tab=dns") });
        if (d.status === "error") return warn(`Gluon couldn't look up ${publicHost}`, { detail: d.message, evidence });
        return ok(`${publicHost} points at this network`, { value: d.proxied ? "proxied" : d.a[0] ?? "ok", evidence });
      },
    });
    specs.push({
      id: "app.cert",
      group: "path",
      hop: true,
      label: "Certificate",
      run: async (ctx) => certOutcome(publicHost, (await routeStatus(ctx))?.tls ?? null, route.id),
    });
    specs.push({
      id: "app.caddy",
      group: "path",
      hop: true,
      label: "Caddy",
      sub: "port 443",
      run: async (ctx) => {
        const r = await routeStatus(ctx);
        const h = r?.http;
        if (!h) return skip("Caddy wasn't asked");
        const evidence = kv([["Request", `GET ${h.url} (through Caddy at 127.0.0.1:443)`], ["Answer", h.error ?? `HTTP ${h.status} in ${ms(h.ms)}`], ["Redirects to", h.location]]);
        if (h.error) return fail("Caddy isn't serving it", { value: "no answer", detail: h.error, evidence, fix: go("Check the address", addressHref(route.id)) });
        if (h.status && h.status >= 500) {
          const why = h.status === 502 ? "Caddy can't reach the app behind it" : h.status === 504 ? "the app is too slow to answer" : "the app answered with an error";
          return fail(`Visitors get an error page (HTTP ${h.status})`, { value: String(h.status), detail: `${why[0]!.toUpperCase()}${why.slice(1)}.`, evidence, findings: [`net.backend:${route.id}`] });
        }
        return ok(`Caddy serves it (HTTP ${h.status}, ${ms(h.ms)})`, { value: String(h.status), evidence });
      },
    });
  }

  specs.push({
    id: "app.container",
    group: "path",
    hop: true,
    label: app.containers.length > 1 ? "Containers" : "Container",
    sub: app.containers.length > 1 ? `${app.containers.length} parts` : app.containers[0]?.name ?? null,
    run: async (ctx) => {
      const a = (await apps(ctx)).find((x) => x.id === appId);
      if (!a) return fail(`${app.name} is gone`);
      const vs = await containerVerdicts(a);
      const o = containersOutcome(a, vs);
      if (o.state === "skip") return fail(`${a.name} is stopped`, { value: "stopped", detail: "Nothing is running, so it can't answer.", evidence: o.evidence, fix: act(`Start ${a.name}`, "apps.start", { id: a.id }) });
      return { ...o, value: o.state === "ok" ? "running" : o.state === "warn" ? "starting" : "down" };
    },
  });

  if (app.webPort) {
    const port = app.webPort;
    specs.push({
      id: "app.port",
      group: "path",
      hop: true,
      label: "Port",
      sub: String(port),
      run: async (ctx) => {
        const { portCheck } = await import("../tools");
        const p = await portCheck("127.0.0.1", port, 3000);
        const evidence = kv([["Connect", `127.0.0.1:${port}`], ["Result", p.open ? `open (${ms(p.ms)})` : p.error]]);
        const now = (await apps(ctx)).find((x) => x.id === app.id);
        const running = !!now?.containers.some((c) => c.state === "running");
        if (p.open && !running) {
          const other = (await apps(ctx)).find((x) => x.id !== app.id && x.containers.some((c) => c.state === "running" && c.ports.some((pp) => pp.host === port)));
          return warn(`Port ${port} answers, but not from ${app.name}`, { value: other ? other.name : "another app", detail: `${other ? other.name : "Another program"} is using port ${port}, so ${app.name} couldn't take it even if it were started. Two copies of the same app often do this.`, evidence });
        }
        if (!p.open) return fail(`Nothing accepts connections on port ${port}`, { value: "closed", detail: `${p.message} The app may have crashed inside its container, or it's listening on another port.`, evidence, fix: act(`Restart ${app.name}`, "apps.restart", { id: app.id }) });
        return ok(`Port ${port} accepts connections (${ms(p.ms)})`, { value: ms(p.ms), evidence });
      },
    });
    specs.push({
      id: "app.answers",
      group: "path",
      hop: true,
      label: "App answers",
      sub: "HTTP",
      run: async (ctx) => {
        const now = (await apps(ctx)).find((x) => x.id === app.id);
        if (!now?.containers.some((c) => c.state === "running")) return skip(`Not asked: ${app.name} isn't running`);
        const o = await webPortOutcome(app);
        return o ?? skip("No web port to ask");
      },
    });
  }

  // ---- details
  if (app.urls.home && /^https?:\/\//.test(app.urls.home)) {
    const home = app.urls.home;
    specs.push({
      id: "app.home",
      group: "details",
      label: "Opens at home",
      run: async () => {
        const u = new URL(home);
        const a = await httpAnswer(Number(u.port || (u.protocol === "https:" ? 443 : 80)), { host: u.hostname, tls: u.protocol === "https:", path: u.pathname + u.search });
        const evidence = kv([["Address", home], ["Answer", a.status ? `HTTP ${a.status} in ${ms(a.ms)}` : (a.code ?? a.error)]]);
        if (!a.status) return fail(`${home} doesn't open from your network`, { detail: "That's the address people at home use.", evidence });
        return ok(`${home} opens from your network`, { value: ms(a.ms), evidence });
      },
    });
  }
  specs.push({
    id: "app.restarts",
    group: "details",
    label: "Restarts",
    run: async () => {
      const rows: [string, string][] = [];
      let crashes = 0;
      let restarts = 0;
      let oldest: number | null = null;
      for (const c of app.containers) {
        const dies = recentDies(c.name, 24 * 3_600_000);
        crashes += dies;
        try {
          const info = await docker().getContainer(c.id).inspect();
          restarts += info.RestartCount ?? 0;
          const started = Date.parse(info.State.StartedAt);
          if (info.State.Running && Number.isFinite(started)) oldest = oldest === null ? started : Math.min(oldest, started);
          rows.push([c.name, `${info.State.Status}, started ${Number.isFinite(started) ? formatRelative(started) : "?"} · restarted ${info.RestartCount ?? 0}× by Docker · stopped ${dies}× today`]);
        } catch {
          rows.push([c.name, "couldn't inspect"]);
        }
      }
      const evidence = kv(rows);
      if (crashes >= 3) return warn(`${app.name} stopped ${plural(crashes, "time")} in the last day`, { detail: "Something keeps killing it. Its logs usually show why.", evidence, fix: go("Read the logs", appHref(app.id, "logs")) });
      return ok(oldest ? `Up for ${formatDuration((Date.now() - oldest) / 1000)} without a crash` : "No recent crashes", { evidence });
    },
  });
  specs.push({
    id: "app.logs",
    group: "details",
    label: "Recent errors",
    run: async () => {
      const since = Date.now() - 3_600_000;
      const lines = (
        await Promise.all(
          app.containers
            .filter((c) => c.state === "running" || c.state === "restarting" || c.state === "exited")
            .map((c) => tailLogs(c.id, c.name, { tail: 400 }).catch(() => [])),
        )
      ).flat();
      const recent = lines.filter((l) => l.t >= since);
      const errors = recent.filter((l) => l.level === "error");
      const evidence = errors.length ? errors.slice(-8).map((l) => `${new Date(l.t).toISOString().slice(11, 19)} ${l.container}  ${l.text.slice(0, 220)}`).join("\n") : `${recent.length} log lines in the last hour, none look like errors.`;
      if (errors.length >= 20) return warn(`${plural(errors.length, "error")} in its logs in the last hour`, { detail: "The newest ones are below. They usually name the cause.", evidence, fix: go("Read the logs", appHref(app.id, "logs")) });
      if (errors.length) return ok(`${plural(errors.length, "error line")} in its logs in the last hour`, { detail: "A few errors are normal for many apps; look if the app misbehaves.", evidence });
      return ok("No errors in its logs in the last hour", { evidence });
    },
  });
  specs.push({
    id: "app.resources",
    group: "details",
    label: "CPU and memory",
    run: async () => {
      const snap = latestContainers();
      const names = new Set(app.containers.map((c) => c.name));
      const rows = (snap?.list ?? []).filter((x) => names.has(x.name));
      if (!rows.length) return skip("No live numbers for its containers yet");
      const cpu = rows.reduce((a, r) => a + r.cpu, 0);
      const mem = rows.reduce((a, r) => a + r.mem, 0);
      const evidence = kv(rows.map((r) => [r.name, `${r.cpu.toFixed(1)}% CPU · ${formatBytes(r.mem)}`]));
      if (cpu >= 80) return warn(`${app.name} is using ${Math.round(cpu)}% of the processor`, { detail: "It may be too busy to answer quickly.", evidence });
      return ok(`Using ${cpu.toFixed(1)}% CPU and ${formatBytes(mem)} of memory`, { evidence });
    },
  });

  return {
    title: `${app.name} won't open`,
    layout: "path",
    origin: publicHost ? "The internet" : "This server",
    groups: [PATH, DETAILS],
    specs,
    subject: app.name,
  };
}

// ---------------------------------------------------------------- a public address isn't working

async function addressPlan(routeId: string): Promise<Plan> {
  const cfg = tryReadConfig();
  if (!cfg) throw new AppError("no_routes", "Gluon can't read your public addresses (routes.json).", 503);
  const r = routeId === FALLBACK_ID ? null : cfg.routes.find((x) => x.id === routeId);
  if (routeId !== FALLBACK_ID && !r) throw new AppError("not_found", "That address doesn't exist any more. Pick another one.", 404);
  const hostName = r?.type === "subdomain" ? r.host : cfg.base_domain;
  const url = r ? routeUrl(cfg, r) : `https://${cfg.base_domain}/`;
  const where = displayUrl(url);
  const backend = r ? (r.type === "redirect" ? null : r.backend) : cfg.fallback.backend;
  const status = async (ctx: CheckCtx) => (await netStatus(ctx)).routes.find((x) => x.id === routeId);
  const certDays = getSetting("thresholds").certDays;
  const specs: CheckSpec[] = [
    {
      id: "addr.dns",
      group: "path",
      hop: true,
      label: "Name",
      sub: hostName,
      run: async (ctx) => {
        const d = (await status(ctx))?.dns;
        if (!d) return skip("The name wasn't looked up");
        const evidence = kv([["Name", d.name], ["A", d.a.join(", ")], ["AAAA", d.aaaa.join(", ")], ["Asked", `${d.resolver} (public)`]]);
        if (d.status === "missing") return fail(`${hostName} has no DNS record`, { value: "missing", detail: d.message, evidence, findings: [`net.dns:${hostName}`], fix: go("See DNS", "/network?tab=dns") });
        if (d.status === "error") return fail(`${hostName} can't be looked up`, { value: "error", detail: d.message, evidence });
        return ok(`${hostName} resolves`, { value: d.a[0] ?? d.aaaa[0] ?? "ok", evidence });
      },
    },
    {
      id: "addr.ip",
      group: "path",
      hop: true,
      label: "Points here",
      run: async (ctx) => {
        const st = await netStatus(ctx);
        const d = st.routes.find((x) => x.id === routeId)?.dns;
        const ddns = await ddnsStatus().catch(() => null);
        const evidence = kv([
          ["This network", `${st.publicIp.v4 ?? "unknown"}${st.publicIp.v6.length ? `, ${st.publicIp.v6[0]}` : ""} (from ${st.publicIp.source})`],
          ["DNS says", d ? [...d.a, ...d.aaaa].join(", ") : null],
          ["DDNS updater", ddns ? `${ddns.container.running ? "running" : "stopped"} · ${ddns.summary}` : "not found"],
        ]);
        if (!d || d.status === "missing" || d.status === "error") return skip("Can't compare without a DNS answer", { evidence });
        if (d.proxied) return ok("It goes through Cloudflare's proxy, which forwards to this network", { value: "Cloudflare", evidence });
        if (d.status === "mismatch") return fail("DNS points somewhere other than this network", { value: "elsewhere", detail: `${d.message} The DDNS updater should correct it within minutes; if it doesn't, check its log.`, evidence, findings: [`net.dns:${hostName}`], fix: go("See DNS", "/network?tab=dns") });
        return ok(`It points at this network (${st.publicIp.v4 ?? "your address"})`, { value: st.publicIp.v4 ?? "ok", evidence });
      },
    },
    {
      id: "addr.caddy",
      group: "path",
      hop: true,
      label: "Caddy",
      sub: "port 443",
      run: async () => {
        const up = await caddyRunning();
        if (!up) return fail("Caddy isn't running", { value: "down", detail: "Caddy is the front door for every public address.", fix: go("Open the Proxy app", "/apps/proxy") });
        return ok("Caddy is running", { value: "up" });
      },
    },
    {
      id: "addr.cert",
      group: "path",
      hop: true,
      label: "Certificate",
      run: async () => {
        const t = await probeTls(hostName, certDays);
        return certOutcome(hostName, t, routeId);
      },
    },
    {
      id: "addr.route",
      group: "path",
      hop: true,
      label: r?.type === "redirect" ? "Redirect" : "Route",
      sub: where,
      run: async () => {
        const path = r?.type === "path" ? `${r.path}/` : r?.type === "redirect" ? r.path : "/";
        const h = await probeHttpViaCaddy(hostName, path);
        const evidence = kv([["Request", `GET https://${hostName}${path}`], ["Answer", h.error ?? `HTTP ${h.status} in ${ms(h.ms)}`], ["Location", h.location]]);
        if (h.error) return fail("Caddy doesn't serve this address", { value: "no answer", detail: h.error, evidence, fix: go("Check the address", addressHref(routeId)) });
        if (r?.type === "redirect") {
          if (h.status && h.status >= 300 && h.status < 400) return ok(`It redirects to ${h.location ?? "its target"}`, { value: String(h.status), evidence });
          return warn(`Expected a redirect but got HTTP ${h.status}`, { value: String(h.status), evidence, fix: go("Check the address", addressHref(routeId)) });
        }
        if (h.status && h.status >= 500) return fail(`Visitors get an error page (HTTP ${h.status})`, { value: String(h.status), detail: h.status === 502 ? "Caddy can't reach the app behind it." : h.status === 504 ? "The app behind it is too slow to answer." : "The app answered with an error.", evidence, findings: [`net.backend:${routeId}`] });
        return ok(`Caddy serves it (HTTP ${h.status}, ${ms(h.ms)})`, { value: String(h.status), evidence });
      },
    },
  ];
  if (backend) {
    specs.push({
      id: "addr.backend",
      group: "path",
      hop: true,
      label: "App port",
      sub: `${backend.host === "host.docker.internal" ? "this server" : backend.host}:${backend.port}`,
      run: async (ctx) => {
        const b = (await status(ctx))?.backend;
        if (!b) return skip("No app port to check");
        const evidence = kv([["Backend", `${b.host}:${b.port}`], ["Result", b.reachable ? `answers (${ms(b.ms)})` : b.error]]);
        if (!b.reachable) {
          const a = (await status(ctx))?.app;
          const list = await apps(ctx);
          const app = a ? list.find((x) => x.id === a.appId) : undefined;
          const stopped = app && app.containers.every((c) => c.state !== "running");
          return fail(`Nothing answers on port ${b.port}`, { value: "closed", detail: `${b.error}. ${stopped ? `${app!.name} is stopped.` : "The app may have crashed or be listening elsewhere."}`, evidence, findings: [`net.backend:${routeId}`], fix: app ? (stopped ? act(`Start ${app.name}`, "apps.start", { id: app.id }) : act(`Restart ${app.name}`, "apps.restart", { id: app.id })) : go("Check the address", addressHref(routeId)) });
        }
        return ok(`Port ${b.port} answers (${ms(b.ms)})`, { value: ms(b.ms), evidence });
      },
    });
    specs.push({
      id: "addr.app",
      group: "path",
      hop: true,
      label: "App",
      run: async (ctx) => {
        const a = (await status(ctx))?.app;
        if (!a) return skip("Gluon doesn't know which app is behind it");
        const app = (await apps(ctx)).find((x) => x.id === a.appId);
        if (!app) return skip(`${a.name} isn't installed here`);
        const o = containersOutcome(app, await containerVerdicts(app));
        if (o.state === "skip") return fail(`${app.name} is stopped`, { value: "stopped", evidence: o.evidence, fix: act(`Start ${app.name}`, "apps.start", { id: app.id }) });
        return { ...o, value: app.name };
      },
    });
  }
  specs.push({
    id: "addr.traffic",
    group: "details",
    label: "Recent visitors",
    run: async () => {
      const since = Date.now() - 60 * 60_000;
      const reqs = recentRequests(2000, false).filter((q) => q.host === hostName && q.time >= since);
      const errs = reqs.filter((q) => q.status >= 500);
      const evidence = reqs.length ? reqs.slice(-10).map((q) => `${new Date(q.time).toISOString().slice(11, 19)}  ${q.status}  ${q.method} ${q.uri.slice(0, 80)}  ${q.remoteIp}`).join("\n") : "No requests from outside in the last hour.";
      if (!reqs.length) return ok("No visitors in the last hour", { detail: "Nothing from outside has asked for it recently, so there's no traffic to judge by.", evidence });
      const share = errs.length / reqs.length;
      if (share >= 0.2 && errs.length >= 3) return warn(`${Math.round(share * 100)}% of the last hour's requests failed`, { detail: `${errs.length} of ${reqs.length} got a server error.`, evidence, fix: go("See requests", "/diagnostics?tab=requests") });
      return ok(`${plural(reqs.length, "request")} in the last hour${errs.length ? `, ${errs.length} with errors` : ", none failed"}`, { evidence });
    },
  });
  return { title: `${where} isn't working`, layout: "path", origin: "The internet", groups: [PATH, DETAILS], specs, subject: where };
}

// ---------------------------------------------------------------- the internet feels slow

interface SpeedProbe {
  idle: ReturnType<typeof summarizeRtts> & { rtts: number[] };
  loaded: ReturnType<typeof summarizeRtts> & { rtts: number[] };
  mbps: number | null;
  bytes: number;
  error: string | null;
}

const SPEED_URL = (bytes: number) => `https://speed.cloudflare.com/__down?bytes=${bytes}`;

/** Download a few MB while pinging 1.1.1.1, to measure speed and latency under load. */
async function speedProbe(signal: AbortSignal): Promise<SpeedProbe> {
  const idleP = await pingSeries("1.1.1.1", 8, 0.2, signal);
  const idle = { ...summarizeRtts(idleP.rtts), rtts: idleP.rtts };
  // A small warm-up sizes the real download so it lasts about two seconds, 25 MB at most.
  const warm = await download(SPEED_URL(1_000_000), 1_000_000, 8000, signal);
  const warmRate = warm.ms && warm.bytes ? warm.bytes / (warm.ms / 1000) : 1_000_000;
  const size = Math.max(2_000_000, Math.min(25_000_000, Math.round(warmRate * 2)));
  const pings: Promise<Awaited<ReturnType<typeof pingSeries>>> = pingSeries("1.1.1.1", 20, 0.1, signal);
  const dl = await download(SPEED_URL(size), size, 15_000, signal);
  const loadedP = await pings;
  const loaded = { ...summarizeRtts(loadedP.rtts), rtts: loadedP.rtts };
  const mbps = dl.ms && dl.bytes ? (dl.bytes * 8) / (dl.ms / 1000) / 1_000_000 : null;
  return { idle, loaded, mbps, bytes: dl.bytes + warm.bytes, error: dl.error ?? warm.error };
}

function internetPlan(): Plan {
  const specs: CheckSpec[] = [];
  specs.push({
    id: "net.link",
    group: "path",
    hop: true,
    label: "Network link",
    run: async (ctx) => {
      const gws = await ctx.memo("gateways", async () => (await import("./probes")).defaultGateways());
      const dev = gws[0]?.dev ?? null;
      const list = await interfaces();
      const i = list.find((x) => x.name === dev) ?? list.find((x) => x.physical && x.state === "UP");
      if (!i) return fail("No network interface is up", { value: "down" });
      const evidence = kv([["Interface", `${i.name} (${i.kind})`], ["State", i.state], ["Speed", i.speedMbps ? `${i.speedMbps} Mb/s` : "not reported"], ["MTU", i.mtu], ["Errors", `${i.rxErrors} in, ${i.txErrors} out`], ["Traffic since boot", `${formatBytes(i.rxTotal)} in, ${formatBytes(i.txTotal)} out`]]);
      const speed = i.speedMbps ? (i.speedMbps >= 1000 ? `${i.speedMbps / 1000} Gb/s` : `${i.speedMbps} Mb/s`) : null;
      if (i.state !== "UP") return fail(`${i.name} is ${i.state.toLowerCase()}`, { value: "down", evidence });
      if (i.speedMbps && i.speedMbps < 1000 && i.kind === "ethernet") return warn(`The cable link runs at only ${speed}`, { value: speed, detail: "Gigabit hardware usually connects at 1 Gb/s. A worn cable or port can drop it to 100 Mb/s.", evidence });
      const errs = i.rxErrors + i.txErrors;
      if (errs > 1000) return warn(`${i.name} has seen ${errs.toLocaleString("en-US")} transmission errors`, { value: speed, detail: "That usually means a bad cable or port.", evidence });
      return ok(`${i.name} is up${speed ? ` at ${speed}` : ""}`, { value: speed ?? "up", evidence });
    },
  });
  const gw = gatewayCheck("path", true);
  specs.push({ ...gw, id: "net.gateway" });
  const dns = systemDnsCheck("path", true);
  specs.push({
    ...dns,
    id: "net.dns",
    run: async () => {
      const server = hostNameservers()[0];
      if (!server) return fail("The server has no DNS resolver set");
      const names = [PROBE_NAME, "google.com", "github.com"];
      const rs = await Promise.all(names.map((n) => dnsLookup(n, "A", server)));
      const good = rs.filter((r) => r.status === "NOERROR" && r.queryMs !== null);
      const evidence = kv(rs.map((r) => [r.name, `${r.status} in ${ms(r.queryMs)}`]));
      if (!good.length) return fail(`The resolver (${server}) isn't answering`, { value: "no answer", detail: "Nothing can be found by name. Restart the router, or set 1.1.1.1 as its DNS server.", evidence });
      const avg = good.reduce((a, r) => a + r.queryMs!, 0) / good.length;
      if (avg > 250) return warn(`Name lookups are slow (${ms(avg)} on average)`, { value: ms(avg), detail: "Every new connection waits for this. A faster resolver (like 1.1.1.1) usually helps.", evidence });
      return ok(`Name lookups take ${ms(avg)} on average`, { value: ms(avg), evidence });
    },
  });
  specs.push({
    id: "net.internet",
    group: "path",
    hop: true,
    label: "Internet",
    sub: "1.1.1.1",
    run: async (ctx) => {
      const p = await pingSeries("1.1.1.1", 12, 0.2, ctx.signal);
      const evidence = kv([["Replies", `${p.received} of ${p.sent}`], ["Round trip", `${ms(p.min)} min, ${ms(p.avg)} avg, ${ms(p.max)} max`], ["Jitter", ms(p.jitter)], ["", p.raw]]);
      if (!p.received) return fail("The internet isn't reachable", { value: "no reply", detail: "Nothing came back from 1.1.1.1. The connection to your provider is down, or the router is.", evidence });
      if (p.lossPct >= 5) return warn(`${p.lossPct}% of packets are lost on the way to the internet`, { value: `${p.lossPct}% loss`, detail: "Loss makes everything stall and retry. It's usually the provider's line or the modem.", evidence });
      if ((p.avg ?? 0) > 80 || (p.jitter ?? 0) > 30) return warn(`The connection is sluggish (${ms(p.avg)}, jitter ${ms(p.jitter)})`, { value: ms(p.avg), detail: "Calls and games need under 50 ms with little jitter.", evidence });
      return ok(`The internet answers in ${ms(p.avg)} with ${ms(p.jitter)} of jitter`, { value: ms(p.avg), evidence });
    },
  });
  const https = httpsCheck("path", true);
  specs.push({ ...https, id: "net.https" });
  specs.push({
    id: "net.speed",
    group: "path",
    hop: true,
    label: "Download",
    sub: "speed.cloudflare.com",
    timeoutMs: 45_000,
    run: async (ctx) => {
      const s = await ctx.memo("speed", () => speedProbe(ctx.signal));
      const evidence = kv([["Downloaded", formatBytes(s.bytes)], ["Speed", s.mbps === null ? null : `${s.mbps.toFixed(0)} Mb/s`], ["From", "speed.cloudflare.com"]]);
      if (s.mbps === null) return fail("The test download didn't work", { value: "failed", detail: s.error ?? "No data came back.", evidence });
      const v = `${s.mbps >= 100 ? Math.round(s.mbps) : s.mbps.toFixed(1)} Mb/s`;
      if (s.mbps < 10) return warn(`Downloads are slow (${v})`, { value: v, detail: "Streaming and updates will struggle. Compare with what your plan promises; if it's far below, restart the modem or call the provider.", evidence });
      return ok(`Downloads run at about ${v}`, { value: v, evidence });
    },
  });
  specs.push({
    id: "net.bufferbloat",
    group: "details",
    afterHops: true,
    label: "Delay while busy",
    timeoutMs: 45_000,
    run: async (ctx) => {
      const s = await ctx.memo("speed", () => speedProbe(ctx.signal));
      if (s.idle.median === null || s.loaded.median === null) return skip("Not enough pings came back to compare");
      const rise = s.loaded.median - s.idle.median;
      const evidence = kv([["Idle", `${ms(s.idle.median)} median (${s.idle.rtts.length} pings)`], ["While downloading", `${ms(s.loaded.median)} median, ${ms(s.loaded.max)} worst (${s.loaded.rtts.length} pings)`], ["Rise", ms(rise)]]);
      if (rise >= 100) return warn(`Delay jumps by ${ms(rise)} when the line is busy`, { value: `+${ms(rise)}`, detail: "This is bufferbloat: one big download makes calls, games and browsing lag. Turning on SQM or Smart Queue in the router fixes it.", evidence });
      if (rise >= 30) return ok(`Delay rises a little when the line is busy (+${ms(rise)})`, { value: `+${ms(rise)}`, evidence });
      return ok(`Delay stays steady when the line is busy (+${ms(Math.max(0, rise))})`, { value: `+${ms(Math.max(0, rise))}`, evidence });
    },
  });
  specs.push({
    id: "net.second",
    group: "details",
    afterHops: true,
    label: "Second opinion",
    run: async (ctx) => {
      const p = await pingSeries("8.8.8.8", 8, 0.2, ctx.signal);
      const evidence = kv([["Target", "8.8.8.8 (Google)"], ["Replies", `${p.received} of ${p.sent}`], ["Round trip", `${ms(p.min)} min, ${ms(p.avg)} avg, ${ms(p.max)} max`]]);
      if (!p.received) return warn("Google's DNS (8.8.8.8) didn't answer", { evidence });
      return ok(`Google's DNS answers in ${ms(p.avg)}`, { value: ms(p.avg), evidence });
    },
  });
  specs.push({
    id: "net.dns-public",
    group: "details",
    afterHops: true,
    label: "DNS through 1.1.1.1",
    run: async () => {
      const rs = await Promise.all([PROBE_NAME, "google.com", "github.com"].map((n) => dnsLookup(n, "A", "cloudflare")));
      const good = rs.filter((r) => r.status === "NOERROR" && r.queryMs !== null);
      const evidence = kv(rs.map((r) => [r.name, `${r.status} in ${ms(r.queryMs)}`]));
      if (!good.length) return warn("1.1.1.1 didn't answer", { evidence });
      const avg = good.reduce((a, r) => a + r.queryMs!, 0) / good.length;
      return ok(`1.1.1.1 answers lookups in ${ms(avg)}`, { value: ms(avg), evidence, detail: "Compare with your router's resolver above: if this is much faster, point the router at 1.1.1.1." });
    },
  });
  return { title: "The internet feels slow", layout: "path", origin: "This server", groups: [PATH, DETAILS], specs, subject: null };
}

// ---------------------------------------------------------------- the server feels slow

function serverPlan(): Plan {
  const g = "server";
  const win = (ctx: CheckCtx) => ctx.memo("cpuwin", () => cpuWindow(2500, ctx.signal));
  const specs: CheckSpec[] = [
    {
      id: "srv.cpu",
      group: g,
      label: "Processor",
      run: async (ctx) => {
        const w = await win(ctx);
        const evidence = kv([["Busy", `${w.busyPct.toFixed(1)}% over ${w.seconds} s`], ["Waiting on disks (iowait)", `${w.iowaitPct.toFixed(1)}%`], ["Stolen by a hypervisor", `${w.stealPct.toFixed(1)}%`]]);
        const v = `${Math.round(w.busyPct)}%`;
        if (w.busyPct >= 90) return fail(`The processor is maxed out (${v})`, { value: v, detail: "Everything waits its turn. The busiest programs are listed below.", evidence, fix: go("See processes", "/diagnostics?tab=processes") });
        if (w.busyPct >= 70) return warn(`The processor is busy (${v})`, { value: v, evidence, fix: go("See processes", "/diagnostics?tab=processes") });
        return ok(`The processor is ${v} busy`, { value: v, evidence });
      },
    },
    { id: "srv.load", group: g, label: "Load", run: async () => loadOutcome() },
    {
      id: "srv.io",
      group: g,
      label: "Disks",
      run: async (ctx) => {
        const w = await win(ctx);
        const h = latestHost();
        const devs = Object.entries(h?.disk.devices ?? {}).sort((a, b) => b[1].busy - a[1].busy);
        const evidence = kv([["iowait", `${w.iowaitPct.toFixed(1)}%`], ...devs.slice(0, 8).map(([d, v]) => [d, `${Math.round(v.busy)}% busy · read ${formatBytes(v.read)}/s · write ${formatBytes(v.write)}/s`] as [string, string])]);
        const top = devs[0];
        if (top && top[1].busy >= 90) return warn(`${top[0]} is busy ${Math.round(top[1].busy)}% of the time`, { value: `${Math.round(top[1].busy)}%`, detail: "Anything that reads or writes that drive waits. A scan, a copy, or a failing drive can do this.", evidence, fix: go("See processes", "/diagnostics?tab=processes") });
        if (w.iowaitPct >= 20) return warn(`Programs spend ${Math.round(w.iowaitPct)}% of their time waiting for the disks`, { value: `${Math.round(w.iowaitPct)}%`, evidence });
        return ok(top ? `Disks keep up (busiest ${top[0]} at ${Math.round(top[1].busy)}%)` : "Disks keep up", { value: top ? `${Math.round(top[1].busy)}%` : null, evidence });
      },
    },
    { id: "srv.memory", group: g, label: "Memory", run: async () => memoryOutcome() },
    {
      id: "srv.swap",
      group: g,
      label: "Swapping",
      run: async (ctx) => {
        const w = await win(ctx);
        const evidence = kv([["Swapped in", `${w.swapInPerSec.toFixed(1)} pages/s`], ["Swapped out", `${w.swapOutPerSec.toFixed(1)} pages/s`], ["Major page faults", `${w.majorFaultsPerSec.toFixed(1)}/s`]]);
        if (w.swapInPerSec + w.swapOutPerSec >= 100) return warn("The server is swapping memory to disk right now", { detail: "That makes everything slow. Something is using more memory than the machine has.", evidence, fix: go("See memory by app", "/apps?sort=memory") });
        return ok("No memory is being swapped to disk", { evidence });
      },
    },
    { id: "srv.temp", group: g, label: "Temperature", run: async () => cpuTempOutcome() },
    {
      id: "srv.top",
      group: g,
      label: "Busiest programs",
      run: async () => {
        const s = await sampleProcesses();
        const top = s.byCpu.slice(0, 8);
        const evidence = kv(top.map((p) => [`${p.name} (${p.pid})`, `${p.cpu.toFixed(1)}% · ${formatBytes(p.memBytes)} · ${p.ownerLabel}`]));
        const first = top[0];
        if (!first) return skip("No process numbers yet");
        if (first.cpu >= 50) return warn(`${first.ownerLabel !== first.name ? `${first.ownerLabel} (${first.name})` : first.name} is using ${Math.round(first.cpu)}% of the processor`, { value: `${Math.round(first.cpu)}%`, detail: "One program is taking most of the machine.", evidence, fix: go("See processes", "/diagnostics?tab=processes") });
        return ok(`Busiest right now: ${first.ownerLabel !== first.name ? `${first.ownerLabel} (${first.name})` : first.name} at ${first.cpu.toFixed(1)}%`, { value: `${first.cpu.toFixed(1)}%`, evidence });
      },
    },
    {
      id: "srv.containers",
      group: g,
      label: "Busiest apps",
      run: async (ctx) => {
        const snap = latestContainers();
        if (!snap) return skip("No container numbers yet");
        const list = await apps(ctx);
        const byName = new Map<string, string>();
        for (const a of list) for (const c of a.containers) byName.set(c.name, a.name);
        const agg = new Map<string, { cpu: number; mem: number }>();
        for (const c of snap.list) {
          const n = byName.get(c.name) ?? c.name;
          const x = agg.get(n) ?? { cpu: 0, mem: 0 };
          x.cpu += c.cpu;
          x.mem += c.mem;
          agg.set(n, x);
        }
        const rows = [...agg.entries()].sort((a, b) => b[1].cpu - a[1].cpu);
        const evidence = kv(rows.slice(0, 10).map(([n, v]) => [n, `${v.cpu.toFixed(1)}% CPU · ${formatBytes(v.mem)}`]));
        const [name, v] = rows[0] ?? ["", { cpu: 0, mem: 0 }];
        if (!name) return skip("No apps are running");
        if (v.cpu >= 50) return warn(`${name} is using ${Math.round(v.cpu)}% of the processor`, { value: `${Math.round(v.cpu)}%`, evidence, fix: go("See apps", "/apps?sort=cpu") });
        const memTop = [...rows].sort((a, b) => b[1].mem - a[1].mem)[0]!;
        return ok(`Busiest app: ${name} (${v.cpu.toFixed(1)}% CPU); most memory: ${memTop[0]} (${formatBytes(memTop[1].mem)})`, { evidence });
      },
    },
  ];
  return { title: "The server feels slow", layout: "sweep", origin: null, groups: [{ id: g, label: "Right now" }], specs, subject: null };
}

// ---------------------------------------------------------------- running out of space

async function waitForUsage(path: string, ctx: CheckCtx, capMs: number): Promise<UsageResult | null> {
  const recent = latestUsage(path);
  if (recent && recent.finishedAt && Date.now() - recent.finishedAt < 6 * 3_600_000) return recent.result as UsageResult;
  const job = await startUsage(ctx.user, path);
  const t0 = Date.now();
  while (Date.now() - t0 < capMs && !ctx.signal.aborted) {
    await new Promise((r) => setTimeout(r, 700));
    const j = getJob(job.id);
    if (j && j.status !== "running") return j.status === "done" ? (j.result as UsageResult) : null;
  }
  return null;
}

function spacePlan(): Plan {
  const g = "space";
  const fsList = realFilesystems();
  const fullest = [...fsList].sort((a, b) => b.pct - a.pct)[0] ?? null;
  const specs: CheckSpec[] = fsList.map((f) => ({ id: `storage.space:${f.mount}`, group: g, label: `Space on ${f.mount}`, run: async () => spaceOutcome(realFilesystems().find((x) => x.mount === f.mount) ?? f) }));
  if (fullest) {
    specs.push({
      id: "space.biggest",
      group: g,
      label: `Biggest folders on ${fullest.mount}`,
      timeoutMs: 60_000,
      run: async (ctx) => {
        const href = `/storage?usage=${encodeURIComponent(fullest.mount)}`;
        if (fullest.used > 400 * 1000 ** 3) return skip(`${fullest.mount} is too big to measure here`, { detail: "Measuring it takes a while; run it from Storage and come back.", fix: go("Measure it in Storage", href) });
        const r = await waitForUsage(fullest.mount, ctx, 45_000);
        if (!r) return skip(`Still measuring ${fullest.mount}`, { detail: "The scan keeps running in Storage; the answer will be there.", fix: go("See the scan", href) });
        const top = r.entries.filter((e) => !e.mountpoint).slice(0, 10);
        const evidence = kv(top.map((e) => [e.path, formatBytes(e.bytes)]));
        const names = top.slice(0, 3).map((e) => `${e.path} (${formatBytes(e.bytes)})`);
        return ok(`On ${fullest.mount} the biggest are ${listJoin(names)}`, { detail: `Measured ${formatRelative(r.scannedAt)}.`, evidence, fix: go("Explore it", href) });
      },
    });
  }
  specs.push({
    id: "space.cleanup",
    group: g,
    label: "Old files",
    timeoutMs: 60_000,
    run: async () => {
      const p = await cleanupPreview();
      const journalExtra = Math.max(0, p.journal.bytes - p.journal.suggestedKeep);
      const leftovers = p.leftovers?.bytes ?? 0;
      const parts: [string, number][] = [
        ["the old copy of Docker's storage", leftovers],
        ["old system logs", journalExtra],
        ["downloaded update packages", p.apt.bytes],
      ];
      const total = parts.reduce((a, [, b]) => a + b, 0);
      const evidence = kv([
        ["Old Docker storage copies", leftovers ? `${formatBytes(leftovers)} (${p.leftovers!.paths.join(", ")})` : "none"],
        ["System log beyond what's useful", `${formatBytes(journalExtra)} (keeps ${formatBytes(p.journal.suggestedKeep)} of ${formatBytes(p.journal.bytes)})`],
        ["Downloaded update packages", formatBytes(p.apt.bytes)],
      ]);
      const named = parts.filter(([, b]) => b >= 50 * 1000 ** 2).sort((a, b) => b[1] - a[1]);
      const detail = named.length ? `${listJoin(named.map(([n, b]) => `${n} (${formatBytes(b)})`))[0]!.toUpperCase()}${listJoin(named.map(([n, b]) => `${n} (${formatBytes(b)})`)).slice(1)}. None of it is used by anything.` : null;
      if (total >= 1000 ** 3) return warn(`${formatBytes(total)} of old files can go`, { value: formatBytes(total), detail, evidence, fix: go("Free space", "/storage?tab=space") });
      return ok(total > 50 * 1000 ** 2 ? `Only ${formatBytes(total)} of old files to clean up` : "There are no old files to clean up", { value: formatBytes(total), detail, evidence });
    },
  });
  specs.push({ id: "system.docker", group: g, label: "Docker", run: dockerDiskOutcome });
  specs.push({ id: "storage.inodes", group: g, label: "Room for new files", run: async () => inodeOutcome(realFilesystems()) });
  return { title: "Running out of space", layout: "sweep", origin: null, groups: [{ id: g, label: "Space" }], specs, subject: null };
}

// ---------------------------------------------------------------- a drive is acting up

async function drivePlan(diskId: string): Promise<Plan> {
  const { getInventoryState } = await import("../../storage/inventory");
  const s = await getInventoryState();
  const d = s.view.disks.find((x) => x.id === diskId);
  if (!d) throw new AppError("not_found", "That drive isn't connected any more. Pick another one.", 404);
  const g = "drive";
  const disk = async (ctx: CheckCtx) => (await inventory(ctx)).view.disks.find((x) => x.id === diskId) ?? d;
  const specs: CheckSpec[] = [
    { id: "drive.smart", group: g, label: "Overall health", run: async (ctx) => smartOutcome(await disk(ctx)) },
    {
      id: "drive.attributes",
      group: g,
      label: "Health counters",
      run: async () => {
        let det;
        try {
          det = smartDetail(diskId);
        } catch {
          return skip("No SMART counters stored for this drive yet");
        }
        if (!det.attributes.length) return skip("This drive doesn't report SMART counters");
        const bad = det.attributes.filter((a) => a.whenFailed && a.whenFailed !== "-");
        const key = det.attributes.filter((a) => [5, 187, 188, 196, 197, 198, 199, 9, 194, 190].includes(a.id));
        const evidence = ["ID  NAME                        VALUE WORST THRESH RAW", ...(key.length ? key : det.attributes.slice(0, 16)).map((a) => `${String(a.id).padStart(3)} ${a.name.padEnd(27).slice(0, 27)} ${String(a.value ?? "-").padStart(5)} ${String(a.worst ?? "-").padStart(5)} ${String(a.thresh ?? "-").padStart(6)} ${a.raw}${a.whenFailed && a.whenFailed !== "-" ? `  (${a.whenFailed})` : ""}`)].join("\n");
        const TEMP = new Set([190, 194, 231]);
        const now = bad.filter((a) => a.whenFailed === "FAILING_NOW");
        const nowWear = now.find((a) => !TEMP.has(a.id));
        if (nowWear) return fail(`${nowWear.name.replaceAll("_", " ")} is past the maker's failure limit`, { detail: "The drive itself says it's failing. Copy what matters off it now.", evidence, fix: go("See drive health", `/storage/${encodeURIComponent(diskId)}`) });
        if (now.length) return warn("The drive is hotter than its maker allows", { detail: "Check the airflow around it and that nothing blocks its fan.", evidence });
        const pastWear = bad.find((a) => !TEMP.has(a.id));
        if (pastWear) return warn(`${pastWear.name.replaceAll("_", " ")} crossed the maker's limit in the past`, { detail: "It's back within limits, but it's a sign of wear. Keep a backup of what's on it.", evidence });
        if (bad.length) return ok("Health counters are within limits; it ran too hot at some point in the past", { detail: "Its temperature counter once went past the maker's limit. Keep an eye on the airflow.", evidence });
        const hist = det.history.filter((h) => h.reallocated !== null);
        const first = hist[0];
        const last = hist.at(-1);
        if (first && last && last.reallocated! > first.reallocated!) return warn(`Replaced sectors went from ${first.reallocated} to ${last.reallocated} since ${formatRelative(first.at)}`, { detail: "A rising count often comes before a failure. Keep a backup of what's on it.", evidence });
        return ok("Every health counter is within its limits", { evidence });
      },
    },
    {
      id: "drive.selftest",
      group: g,
      label: "Self-test",
      run: async (ctx) => {
        const t = (await disk(ctx)).smart?.lastSelfTest;
        if (!t) return skip("The drive has never run a self-test", { detail: "A short self-test takes two minutes and can be started from the drive's page.", fix: go("Open the drive", `/storage/${encodeURIComponent(diskId)}`) });
        const ev = kv([["Type", t.type], ["Result", t.status], ["At power-on hour", t.lifetimeHours]]);
        if (t.passed === false) return fail(`Its last self-test failed (${t.status})`, { detail: "The drive found errors while reading itself. Copy what matters off it.", evidence: ev, fix: go("See drive health", `/storage/${encodeURIComponent(diskId)}`) });
        return ok(`Its last ${t.type.toLowerCase()} self-test passed`, { evidence: ev });
      },
    },
    {
      id: "drive.temp",
      group: g,
      label: "Temperature",
      run: async (ctx) => {
        const x = await disk(ctx);
        const t = x.smart?.temperature;
        if (t === null || t === undefined) return skip("The drive doesn't report its temperature");
        const limit = x.media === "hdd" ? Math.min(x.smart?.tempLimit ?? 55, 55) : (x.smart?.tempLimit ?? 75) - 5;
        const ev = kv([["Now", `${t} °C`], ["Warns at", `${limit} °C`], ["Rated to", x.smart?.tempLimit ? `${x.smart.tempLimit} °C` : null]]);
        if (t >= limit) return warn(`It's running hot (${t} °C)`, { value: `${t} °C`, detail: "Check the airflow around it.", evidence: ev });
        return ok(`It's at ${t} °C`, { value: `${t} °C`, evidence: ev });
      },
    },
    {
      id: "drive.kernel",
      group: g,
      label: "Kernel log",
      run: async () => {
        const names = [d.name, ...d.partitions.map((p) => p.name)];
        const re = new RegExp(`\\b(${names.map((n) => n.replace(/[^A-Za-z0-9]/g, "")).join("|")})\\b`);
        const bad = /I\/O error|\berror\b|\bfail(ed|ure|ing)?\b|\breset\b|time(d)? ?out|critical medium|\bUNC\b|uncorrect|\boffline\b|\babort|exception Emask/i;
        let stdout = "";
        try {
          ({ stdout } = await host("journalctl", ["-k", "--since", "-7d", "--no-pager", "-o", "short-iso", "-q"], { timeoutMs: 20_000, maxBuffer: 64 * 1024 * 1024, okCodes: [1] }));
        } catch {
          return skip("Gluon couldn't read the kernel log");
        }
        const lines = stdout.split("\n").filter((l) => re.test(l) && bad.test(l));
        const evidence = lines.length ? lines.slice(-12).join("\n") : `No errors mentioning ${names.join(", ")} in the last 7 days.`;
        const fix = go("Read the kernel log", "/diagnostics?tab=logs&source=kernel");
        if (lines.length >= 20) return fail(`${plural(lines.length, "disk error")} in the kernel log this week`, { detail: "Linux keeps having trouble reading or writing it. Check the cable, then the drive's health.", evidence, fix });
        if (lines.length) return warn(`${plural(lines.length, "disk error")} in the kernel log this week`, { detail: "A few can be a loose cable or a power blip; many mean a failing drive.", evidence, fix });
        return ok("No errors about it in the kernel log this week", { evidence });
      },
    },
    {
      id: "drive.filesystems",
      group: g,
      label: "Filesystems",
      run: async (ctx) => {
        const st = await inventory(ctx);
        const x = st.view.disks.find((y) => y.id === diskId) ?? d;
        const vols = [...(x.wholeDisk ? [x.wholeDisk] : []), ...x.partitions];
        const mounted = vols.filter((v) => v.primaryMount);
        const evidence = kv(vols.map((v) => [v.path, `${v.fstype ?? v.role}${v.primaryMount ? ` at ${v.primaryMount}${v.mountedReadOnly ? " (READ-ONLY)" : ""}${v.usage ? `, ${Math.round((v.usage.used / Math.max(1, v.usage.size)) * 100)}% used` : ""}` : ", not mounted"}`]));
        const ro = mounted.find((v) => v.mountedReadOnly && !v.deviceReadOnly);
        if (ro) return fail(`${ro.primaryMount} has switched to read-only`, { detail: "Linux did this after errors on the drive, to protect its data.", evidence, findings: [`storage.readonly:${ro.primaryMount}`], fix: go("Read the kernel log", "/diagnostics?tab=logs&source=kernel") });
        const missing = notPersistent(st).filter((r) => r.disk.id === diskId);
        if (missing.length) return warn(`${listJoin(missing.map((r) => r.vol.primaryMount!))} won't come back after a restart`, { detail: "It was mounted by hand and isn't in /etc/fstab.", evidence, findings: ["storage.not-persistent"], fix: go("Open Storage", "/storage?tab=fstab") });
        if (!mounted.length) return ok("Nothing on it is mounted", { evidence });
        return ok(`${listJoin(mounted.map((v) => v.primaryMount!))} ${mounted.length === 1 ? "is" : "are"} mounted normally`, { evidence });
      },
    },
  ];
  return { title: `The ${d.title} (${d.name}) is acting up`, layout: "sweep", origin: null, groups: [{ id: g, label: d.title }], specs, subject: `${d.name} ${d.model ?? ""}`.trim() };
}

// ---------------------------------------------------------------- is my server safe on the internet?

async function safetyPlan(): Promise<Plan> {
  const specs: CheckSpec[] = [];
  const cfg = tryReadConfig();
  const entries = cfg ? [{ id: FALLBACK_ID, label: cfg.base_domain }, ...cfg.routes.filter((r) => r.enabled !== false && r.type !== "redirect").map((r) => ({ id: r.id, label: displayUrl(routeUrl(cfg, r)) }))] : [];
  for (const e of entries) {
    specs.push({
      id: `safety.public:${e.id}`,
      group: "internet",
      label: e.label,
      timeoutMs: 45_000,
      run: async (ctx) => {
        const r = await exposure(ctx, true);
        const x = r.internet.find((i) => i.routeId === e.id);
        if (!x) return skip(`${e.label} isn't reachable from the internet`);
        const who = x.app?.name ?? x.name;
        const evidence = kv([["Address", x.url], ["Leads to", `${who} on port ${x.backend.port}`], ["Login", `${x.login.verdict}${x.login.evidence ? ` (${x.login.evidence})` : ""}`], ["Admin tool", x.adminUi ? "yes" : "no"], ["Through Cloudflare", x.viaCloudflare ? "yes" : "no"], ["Only these paths", x.onlyPaths?.join(", ") ?? "everything"]]);
        const fix = go("Review exposure", "/network?tab=exposure");
        if (x.login.verdict === "no-login") return fail(`${who} is open to anyone at ${e.label}`, { detail: "It has no login of its own. Turn one on, or take it off the internet.", evidence, findings: [`net.exposed:${e.id}`], fix });
        if (x.adminUi) return warn(`${who}'s admin screens are reachable from the internet`, { detail: "It can change this server or your home. It has a login; use a strong password and two-step sign-in if it offers one, or keep it home-only.", evidence, fix });
        if (x.login.verdict === "unknown") return warn(`Gluon can't tell whether ${who} asks for a login`, { detail: "Open the address from outside your network to check, then record the answer on the app.", evidence, fix });
        if (x.onlyPaths?.length) return ok(`${who} is only partly public, and asks for a login`, { evidence });
        return ok(`${who} asks for a login`, { evidence });
      },
    });
  }
  if (!entries.length) specs.push({ id: "safety.public", group: "internet", label: "Public addresses", run: async () => ok("Nothing is published to the internet") });
  specs.push({ id: "safety.ssh-failures", group: "internet", label: "SSH attempts", run: sshFailuresOutcome });
  specs.push({ id: "security.lan", group: "network", label: "Open ports", timeoutMs: 45_000, run: async (ctx) => lanOutcome(await exposure(ctx, true)) });
  specs.push({ id: "security.ssh-password", group: "network", label: "SSH passwords", run: sshPasswordOutcome });
  specs.push({ id: "security.ssh-root", group: "network", label: "SSH root", run: sshRootOutcome });
  specs.push({ id: "system.updates", group: "network", label: "Security updates", timeoutMs: 60_000, run: updatesOutcome });
  specs.push({ id: "security.admin-mfa", group: "accounts", label: "Admins", run: async () => adminMfaOutcome() });
  specs.push({
    id: "safety.members-mfa",
    group: "accounts",
    label: "Household",
    run: async () => {
      const members = listUsers().filter((u) => u.role === "member" && !u.disabled);
      const without = members.filter((u) => !u.mfa);
      const evidence = kv(members.map((u) => [u.username, u.mfa ? "two-step on" : "two-step off"]));
      if (!members.length) return ok("There are no household accounts", { evidence: null });
      return ok(without.length ? `${plural(without.length, "household member")} ${without.length === 1 ? "signs" : "sign"} in with just a password` : "Every household member uses two-step sign-in", { detail: without.length ? "Members can't change anything risky, so this is fine; two-step is still better." : null, evidence });
    },
  });
  specs.push({
    id: "safety.mfa-policy",
    group: "accounts",
    label: "Away from home",
    run: async () => {
      const on = getSetting("requireMfaAway");
      if (!on) return warn("Admins can sign in from the internet without two-step verification", { detail: "Turn on \"Require two-step for admins away from home\" in Settings → Server.", fix: go("Open server settings", "/settings/server") });
      return ok("Admins need two-step sign-in to get in from outside");
    },
  });
  specs.push({ id: "safety.gluon-logins", group: "accounts", label: "Failed sign-ins", run: async () => gluonLoginsOutcome() });
  return {
    title: "Is my server safe on the internet?",
    layout: "sweep",
    origin: null,
    groups: [
      { id: "internet", label: "From the internet" },
      { id: "network", label: "On this machine" },
      { id: "accounts", label: "Accounts" },
    ],
    specs,
    subject: null,
  };
}

// ---------------------------------------------------------------- entry

export async function targetedPlan(kind: Exclude<CheckupKind, "full">, target: string | null): Promise<Plan> {
  switch (kind) {
    case "app":
      if (!target) throw new AppError("invalid", "Pick the app that won't open.", 400, { field: "target" });
      return appPlan(target);
    case "address":
      if (!target) throw new AppError("invalid", "Pick the address that isn't working.", 400, { field: "target" });
      return addressPlan(target);
    case "drive":
      if (!target) throw new AppError("invalid", "Pick the drive.", 400, { field: "target" });
      return drivePlan(target);
    case "internet":
      return internetPlan();
    case "server":
      return serverPlan();
    case "space":
      return spacePlan();
    case "safety":
      return safetyPlan();
  }
}

