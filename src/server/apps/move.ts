import "server-only";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type Docker from "dockerode";
import type { MoveEvent, MoveJob, MovePlan, MoveSource } from "@/lib/app-move-types";
import { moveBlock } from "@/lib/app-move-types";
import { formatBytes } from "@/lib/format";
import { docker } from "../docker/client";
import { getApp, invalidateApps, type AppSummary } from "../docker/apps";
import { publicPorts, tryReadConfig } from "../caddy/routes";
import { reassignRouteApp } from "../network/routes-service";
import { invalidateMonitors } from "../monitors/runner";
import { listJoin } from "@/lib/format";
import { applyRecordPlan, planRecordMove, snapshotRecords, type RecordPlan } from "./records";
import { host } from "../host/exec";
import { hostExists, hostPath } from "../host/paths";
import { AppError, conflict, notFound } from "../errors";
import { audit } from "../audit";
import { publish } from "../events";
import { findUmbrel, umbrelAction, umbrelAppState } from "../platform/umbrel";
import type { User } from "../auth/users";
import { appsRoot, invalidateAppsRoot } from "./root";
import { lockApps } from "./lock";
import { spawnLines as runLines } from "./spawn";
import { assess, oneShotServices, type ContainerState } from "./health";

const MOVE_SLOT = "\u0000move";
import { MARKER, moveMarker, readMarker } from "./marker";
import { finalizePlan } from "./plan";
import { rewriteCompose, type OwnDir, type Rewritten } from "./rewrite";
import { composeFromContainer, type ContainerInspect, type ImageInspect } from "./lone";
import { bindUses, freeSpace, inspectAll, measure, readText, runtimeOf, sizeOf, volumeInfo } from "./facts";
import { isBroadPath, inside, norm, slugify, within } from "./paths";
import { parseEnvFile } from "./vars";

type Where = { ip?: string; zone?: string };

/** What running a plan needs beyond what the person reviewed. */
interface Prepared {
  plan: MovePlan;
  envText: string | null;
  app: AppSummary;
  /** The old app's containers: id, name, running before the move, restart policy. */
  originals: { id: string; name: string; running: boolean; restart: string }[];
  /** `docker compose` arguments that address the old project (when it's stopped through Compose). */
  oldCompose: string[] | null;
}

// ---------------------------------------------------------------- planning

const UMBREL_ROOT_RE = (id: string) => new RegExp(`^(.*)/app-data/${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)`);

function pickProject(base: string, taken: Set<string>): string {
  const b = slugify(base);
  if (!taken.has(b)) return b;
  for (let n = 1; n < 50; n++) {
    const c = n === 1 ? `${b}-gluon` : `${b}-gluon-${n}`;
    if (!taken.has(c)) return c;
  }
  return `${b}-${Date.now().toString(36)}`;
}

async function prepare(id: string): Promise<Prepared> {
  const app = await getApp(id);
  if (!app) throw notFound("That app");
  const block = moveBlock(app);
  if (block) throw new AppError("cant_move", block, 409);

  const [inspects, list, root] = await Promise.all([inspectAll(app.containers.map((c) => c.id)), docker().listContainers({ all: true }), appsRoot()]);
  if (!inspects.length) throw new AppError("cant_move", `Docker doesn't know ${app.name}'s containers any more. Reload and try again.`, 409);
  const volumes = await volumeInfo(list);
  const binds = bindUses(list);
  const appContainers = inspects.map((i) => i.Name.replace(/^\//, ""));
  const labels = inspects[0]!.Config.Labels ?? {};
  const oldProject = labels["com.docker.compose.project"] ?? null;

  const taken = new Set<string>();
  for (const c of list) {
    const p = c.Labels?.["com.docker.compose.project"];
    if (p) taken.add(p);
    for (const n of c.Names ?? []) taken.add(n.replace(/^\//, ""));
  }
  try {
    for (const d of fs.readdirSync(hostPath(root))) taken.add(d);
  } catch {
    /* the root doesn't exist yet */
  }
  const newId = pickProject(app.name || app.id, taken);
  const folder = `${root}/${newId}`;
  const meta = { name: app.name, icon: app.icon, description: app.description, webPort: app.webPort, path: null as string | null };
  const extraBlockers: string[] = [];
  const extraWarnings: string[] = [];
  if (hostExists(folder)) extraBlockers.push(`${folder} already exists. Move or rename it first.`);
  if (isBroadPath(folder) || !inside(folder, root)) extraBlockers.push(`Gluon's apps folder (${root}) can't hold this app.`);

  let source: MoveSource;
  let r: Rewritten;
  const runtime = inspects.map(runtimeOf);
  if (app.kind === "container" || !oldProject) {
    source = "docker";
    const ct = inspects[0]! as unknown as ContainerInspect;
    const image = (await docker().getImage(inspects[0]!.Image).inspect().catch(() => null)) as ImageInspect | null;
    if (!image) extraWarnings.push("Gluon couldn't read the container's image, so the compose file lists every setting, including ones the image sets itself.");
    r = composeFromContainer({ container: ct, image, newProject: newId, newDir: folder, volumes, meta });
  } else if (app.source === "umbrel") {
    source = "umbrel";
    const ep = await findUmbrel();
    if (!ep) throw new AppError("umbrel_missing", "Gluon can't find Umbrel on this server, so it can't stop the Umbrel app safely.", 503);
    const re = UMBREL_ROOT_RE(app.id);
    const fromMount = runtime.flatMap((rt) => rt.mounts).map((m) => re.exec(m.source)?.[1]).find(Boolean);
    const umbrelRoot = fromMount ?? ep.dataDir;
    const appData = `${umbrelRoot}/app-data/${app.id}`;
    const text = readText(`${appData}/docker-compose.yml`);
    if (text === null) throw new AppError("no_compose", `Gluon can't read ${appData}/docker-compose.yml, Umbrel's file for ${app.name}.`, 409);
    const manifest = (() => {
      try {
        return (YAML.parse(readText(`${appData}/umbrel-app.yml`) ?? "") ?? {}) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    let hooks: string[] = [];
    try {
      hooks = fs.readdirSync(hostPath(`${appData}/hooks`)).filter((f) => !f.startsWith("."));
    } catch {
      /* none */
    }
    const proxyCtr = app.containers.find((c) => c.service === "app_proxy");
    const proxyPort = proxyCtr?.ports.find((p) => p.proto === "tcp")?.host ?? (typeof manifest.port === "number" ? manifest.port : null);
    const hostName = runtime.find((x) => x.service !== "app_proxy")?.hostname;
    meta.path = typeof manifest.path === "string" && manifest.path ? manifest.path : null;
    if (typeof manifest.tagline === "string" && !meta.description) meta.description = manifest.tagline;
    r = rewriteCompose({
      source: "umbrel",
      appId: app.id,
      project: oldProject,
      newProject: newId,
      newDir: folder,
      composeText: text,
      workingDir: appData,
      ownDirs: [{ path: appData, to: "" }],
      vars: { APP_DATA_DIR: appData, UMBREL_ROOT: umbrelRoot, DEVICE_HOSTNAME: hostName && !/^[0-9a-f]{12}$/.test(hostName) ? hostName : "umbrel", DEVICE_DOMAIN_NAME: `${hostName && !/^[0-9a-f]{12}$/.test(hostName) ? hostName : "umbrel"}.local`, APP_ID: app.id },
      newVars: { APP_DATA_DIR: folder },
      runtime: runtime.filter((x) => x.service !== "app_proxy"),
      volumes,
      appContainers,
      binds,
      meta,
      umbrel: { proxyPort, dependencies: Array.isArray(manifest.dependencies) ? manifest.dependencies.map(String) : [], hooks },
    });
  } else {
    source = app.source === "casaos" ? "casaos" : "compose";
    const files = (labels["com.docker.compose.project.config_files"] ?? "").split(",").filter(Boolean);
    const workingDir = labels["com.docker.compose.project.working_dir"] ?? (files[0] ? path.posix.dirname(files[0]) : null);
    if (files.length !== 1) throw new AppError("cant_move", files.length ? `${app.name} is made from ${files.length} compose files. Gluon can move apps made from one.` : `Gluon can't find ${app.name}'s compose file.`, 409);
    const text = readText(files[0]!);
    if (text === null) throw new AppError("no_compose", `Gluon can't read ${files[0]}.`, 409);
    const dotenvText = workingDir ? readText(`${workingDir}/.env`) : null;
    const ownDirs: OwnDir[] = [];
    if (source === "casaos") {
      let storeId: string | null = null;
      try {
        const x = (YAML.parse(text) as Record<string, unknown>)?.["x-casaos"] as Record<string, unknown> | undefined;
        storeId = typeof x?.store_app_id === "string" ? x.store_app_id : null;
      } catch {
        /* unreadable: rewriteCompose reports it */
      }
      // Only a data folder this app's own containers mount from: a second install can share a store id.
      const mounted = runtime.flatMap((x) => x.mounts.filter((m) => m.type === "bind").map((m) => m.source));
      for (const n of new Set([oldProject, storeId].filter(Boolean) as string[])) {
        const d = `/DATA/AppData/${n}`;
        if (/^[A-Za-z0-9._-]+$/.test(n) && mounted.some((m) => within(m, d)) && hostExists(d)) ownDirs.push({ path: d, to: "data" });
      }
      // CasaOS's own folder for the app holds its compose file and anything it names relatively
      // (env_file: .env, ./data). Removing the old copy deletes that folder, so those come along.
      const casaDir = workingDir ? norm(workingDir) : null;
      if (casaDir && path.posix.dirname(casaDir) === "/var/lib/casaos/apps") ownDirs.push({ path: casaDir, to: "" });
    } else if (workingDir && !isBroadPath(workingDir)) {
      ownDirs.push({ path: workingDir, to: "" });
    } else if (workingDir) {
      extraWarnings.push(`Its compose file is in ${workingDir}, which holds more than this app, so every folder it uses stays where it is.`);
    }
    r = rewriteCompose({
      source,
      appId: app.id,
      project: oldProject,
      newProject: newId,
      newDir: folder,
      composeText: text,
      workingDir,
      ownDirs,
      vars: dotenvText ? parseEnvFile(dotenvText) : {},
      dotenvText,
      runtime,
      volumes,
      appContainers,
      binds,
      meta,
    });
  }

  const [measured, free] = await Promise.all([measure(r.copies.map((c) => c.from)), freeSpace(folder)]);
  const portsInUse = new Map<string, string>();
  const mine = new Set(app.containers.map((c) => c.id));
  for (const c of list) {
    if (mine.has(c.Id) || c.State !== "running") continue;
    for (const p of c.Ports ?? []) if (p.PublicPort) portsInUse.set(`${p.PublicPort}/${p.Type}`, (c.Names?.[0] ?? c.Id).replace(/^\//, ""));
  }
  const via = app.umbrel ? "umbrel" : app.configFile ? "compose" : "containers";
  const plan = finalizePlan({
    appId: app.id,
    name: app.name,
    source,
    newId,
    folder,
    rewritten: r,
    measured,
    free,
    portsInUse,
    publicPorts: (() => {
      const cfg = tryReadConfig();
      return cfg ? publicPorts(cfg) : undefined;
    })(),
    stops: { name: app.name, containers: app.containers.map((c) => c.name), via },
    blockers: extraBlockers,
    warnings: extraWarnings,
  });
  const originals = inspects.map((i) => ({ id: i.Id, name: i.Name.replace(/^\//, ""), running: i.State.Running || i.State.Restarting, restart: i.HostConfig.RestartPolicy?.Name ?? "no" }));
  const oldCompose = via === "compose" && app.configFile ? ["compose", "-p", app.id, ...app.configFile.split(",").flatMap((f) => ["-f", f])] : null;
  return { plan, envText: r.envText, app, originals, oldCompose };
}

export async function movePlan(id: string): Promise<MovePlan> {
  return (await prepare(id)).plan;
}

// ---------------------------------------------------------------- jobs

interface Job extends MoveJob {
  listeners: Set<(e: MoveEvent) => void>;
}

type G = typeof globalThis & { __gluonMoves?: Map<string, Job> };
const g = globalThis as G;
const jobs = (g.__gluonMoves ??= new Map());

export function moveJob(appId: string): MoveJob | null {
  const j = jobs.get(appId) ?? [...jobs.values()].find((x) => x.newId === appId);
  if (!j) return null;
  // Finished moves are shown for a while after, so a reload still sees the result.
  if (j.finishedAt && Date.now() - j.finishedAt > 30 * 60_000) return null;
  return { appId: j.appId, newId: j.newId, name: j.name, startedAt: j.startedAt, finishedAt: j.finishedAt, events: j.events };
}

export function followMove(appId: string, onEvent: (e: MoveEvent) => void): (() => void) | null {
  const j = jobs.get(appId);
  if (!j) return null;
  for (const e of j.events) onEvent(e);
  if (j.finishedAt) return () => undefined;
  j.listeners.add(onEvent);
  return () => j.listeners.delete(onEvent);
}

/** Ids of apps a running move involves: each original and the copy it's making. */
export function movingApps(): Set<string> {
  const out = new Set<string>();
  for (const j of jobs.values()) if (!j.finishedAt) out.add(j.appId).add(j.newId);
  return out;
}

export const moveRunning = (appId: string) => {
  const j = jobs.get(appId);
  return !!j && !j.finishedAt;
};

/**
 * Start a move. It runs to the end on its own even if the browser goes away (stopping halfway
 * would be worse than either outcome); the page can follow it again with `followMove`.
 */
export async function startMove(appId: string, planId: string, user: User, where: Where): Promise<void> {
  // Taken before the slow planning, so a second request can't plan the same move alongside.
  // MOVE_SLOT allows one move at a time on the whole server.
  const name = (await getApp(appId).catch(() => null))?.name ?? appId;
  const lock = lockApps([MOVE_SLOT, appId], `${name} is moving to Gluon`);
  let prep: Prepared;
  try {
    prep = await prepare(appId);
    if (prep.plan.id !== planId) throw conflict(`Something about ${prep.app.name} changed since you reviewed the move. Review it again.`);
    if (prep.plan.blockers.length) throw new AppError("cant_move", prep.plan.blockers[0]!, 409);
    lock.extend(prep.plan.newId);
  } catch (e) {
    lock.release();
    throw e;
  }
  const job: Job = { appId, newId: prep.plan.newId, name: prep.app.name, startedAt: Date.now(), finishedAt: null, events: [], listeners: new Set() };
  jobs.set(appId, job);
  const emit = (e: MoveEvent) => {
    job.events.push(e);
    if (job.events.length > 3000) job.events.splice(1, job.events.length - 3000);
    for (const l of job.listeners) l(e);
  };
  void execute(prep, user, where, emit)
    .catch((e) => emit({ type: "result", ok: false, rolledBack: false, newId: null, message: e instanceof AppError ? e.message : "The move stopped on an unexpected error. Check both copies on the Apps page.", detail: e instanceof Error ? e.message : undefined }))
    .finally(() => {
      lock.release();
      job.finishedAt = Date.now();
      job.listeners.clear();
      invalidateApps();
      publish("apps.changed", { id: appId });
    });
}

// ---------------------------------------------------------------- running

const MIN = 60_000;
const ignore304 = (e: { statusCode?: number }) => {
  if (e?.statusCode !== 304) throw e;
};

/** A host command whose output goes into the move's log. The move itself never stops on a closed tab. */
const spawnLines = (cmd: string, args: string[], emit: (e: MoveEvent) => void, timeoutMs: number): Promise<number> =>
  runLines(cmd, args, (text, stream) => emit({ type: "line", text, stream }), { timeoutMs }).then((r) => r.code);

/** A copy's time limit: generous for big data (assumes 10 MB/s at worst), never under 15 minutes. */
export const copyTimeout = (bytes: number | null) => Math.min(24 * 60 * MIN, 15 * MIN + Math.round(((bytes ?? 50e9) / 10e6) * 1000));

async function waitUmbrel(appId: string, want: (s: string) => boolean, ms: number): Promise<string> {
  const end = Date.now() + ms;
  let state = "unknown";
  while (Date.now() < end) {
    state = (await umbrelAppState(appId).catch(() => null))?.state ?? state;
    if (want(state)) return state;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return state;
}

async function stopOriginal(p: Prepared, emit: (e: MoveEvent) => void) {
  const { app } = p;
  // A container set to restart "always" comes back whenever Docker restarts, even after a stop.
  // Hold it until the old copy is removed (a rollback puts the policy back).
  for (const o of p.originals) if (o.restart === "always") await host("docker", ["update", "--restart", "no", o.id], { timeoutMs: 30_000 }).catch(() => undefined);
  if (!p.originals.some((o) => o.running)) {
    emit({ type: "step", text: `${app.name} is already stopped` });
    return;
  }
  emit({ type: "step", text: app.umbrel ? `Asking Umbrel to stop ${app.name}` : `Stopping ${app.name}` });
  if (app.umbrel) {
    // Umbrel's own stop also tells it not to start the app again at boot. A slow stop can outlast
    // the request, so what counts is the state Umbrel reports afterwards.
    await umbrelAction(app.id, "stop").catch(() => undefined);
    const s = await waitUmbrel(app.id, (x) => x === "stopped", 4 * MIN);
    if (s !== "stopped") throw new AppError("stop_failed", `Umbrel didn't stop ${app.name} (it says ${s}). Nothing was copied.`, 502);
  } else if (p.oldCompose) {
    await host("docker", [...p.oldCompose, "stop"], { timeoutMs: 5 * MIN });
  } else {
    for (const o of p.originals) await docker().getContainer(o.id).stop({ t: 30 }).catch(ignore304);
  }
}

async function startOriginal(p: Prepared, emit: (e: MoveEvent) => void): Promise<boolean> {
  const { app } = p;
  for (const o of p.originals) if (o.restart === "always") await host("docker", ["update", "--restart", "always", o.id], { timeoutMs: 30_000 }).catch(() => undefined);
  if (!p.originals.some((o) => o.running)) return true;
  emit({ type: "step", text: `Starting ${app.name} again` });
  try {
    if (app.umbrel) {
      await umbrelAction(app.id, "start").catch(() => undefined);
      return ["ready", "running"].includes(await waitUmbrel(app.id, (x) => x === "ready" || x === "running", 5 * MIN));
    }
    if (p.oldCompose) {
      await host("docker", [...p.oldCompose, "start"], { timeoutMs: 5 * MIN });
      return true;
    }
    for (const o of p.originals) if (o.running) await docker().getContainer(o.id).start().catch(ignore304);
    return true;
  } catch (e) {
    emit({ type: "line", text: e instanceof Error ? e.message : String(e), stream: "err" });
    return false;
  }
}

async function copyOne(from: string, to: string, size: number | null, done: number, total: number, emit: (e: MoveEvent) => void): Promise<void> {
  fs.mkdirSync(hostPath(path.posix.dirname(to)), { recursive: true });
  let measuring = false;
  const tick = setInterval(() => {
    if (measuring) return;
    measuring = true;
    void sizeOf(to, 20_000)
      .then((n) => n !== null && emit({ type: "progress", done: done + Math.min(n, size ?? n), total, current: from }))
      .finally(() => (measuring = false));
  }, 3000);
  try {
    const code = await spawnLines("cp", ["-a", "-T", "--reflink=auto", "--", from, to], emit, copyTimeout(size));
    if (code !== 0) throw new AppError("copy_failed", `Copying ${from} didn't finish. The output above says why.`, 500);
  } finally {
    clearInterval(tick);
  }
}

const projectArgs = (dir: string, project: string) => ["compose", "-p", project, "--project-directory", dir, "-f", `${dir}/docker-compose.yml`];

type Health = { ok: true } | { ok: false; why: string; containers: string[] };

/**
 * Wait for every container of the new project to be running (and healthy, if it has a check) and
 * to stay that way for a few checks in a row. See health.ts for what counts.
 */
async function waitHealthy(project: string, compose: string, emit: (e: MoveEvent) => void): Promise<Health> {
  const start = Date.now();
  let limit = 3 * MIN;
  let steady = 0;
  const firstRestarts = new Map<string, number>();
  const oneShot = oneShotServices(compose);
  let said = "";
  while (Date.now() - start < limit) {
    await new Promise((r) => setTimeout(r, 3000));
    const list = await docker().listContainers({ all: true, filters: { label: [`com.docker.compose.project=${project}`] } }).catch(() => [] as Docker.ContainerInfo[]);
    if (!list.length) return { ok: false, why: "No containers were created.", containers: [] };
    const cs = await inspectAll(list.map((c) => c.Id));
    const states: ContainerState[] = cs.map((c) => ({ name: c.Name.replace(/^\//, ""), service: c.Config.Labels?.["com.docker.compose.service"] ?? null, status: c.State.Status, exitCode: c.State.ExitCode, health: c.State.Health?.Status ?? null, restartCount: c.RestartCount }));
    if (states.some((c) => c.health === "starting")) limit = 8 * MIN; // checks with a start period get longer
    const { bad, waiting } = assess(states, firstRestarts, oneShot);
    if (bad.length) return { ok: false, why: `${bad.map((b) => `${b.name} ${b.why}`).join("; ")}.`, containers: bad.map((b) => b.name) };
    const line = waiting ? `Waiting for ${waiting} of ${cs.length} to be ready` : "All running";
    if (line !== said) emit({ type: "step", text: line });
    said = line;
    steady = waiting ? 0 : steady + 1;
    if (steady >= 4) return { ok: true };
  }
  return { ok: false, why: "It didn't become ready in time.", containers: [] };
}

async function tailLogs(project: string, names: string[], emit: (e: MoveEvent) => void) {
  const cs = await docker().listContainers({ all: true, filters: { label: [`com.docker.compose.project=${project}`] } }).catch(() => [] as Docker.ContainerInfo[]);
  for (const c of cs) {
    const name = (c.Names?.[0] ?? c.Id).replace(/^\//, "");
    if (names.length && !names.includes(name)) continue;
    try {
      const { stdout, stderr } = await host("docker", ["logs", "--tail", "30", c.Id], { timeoutMs: 15_000 });
      emit({ type: "step", text: `Last lines from ${name}` });
      for (const l of `${stdout}${stderr}`.split("\n").filter(Boolean).slice(-30)) emit({ type: "line", text: l, stream: "err" });
    } catch {
      /* logs are a courtesy */
    }
  }
}

/**
 * Hand everything stored under the old id to the new one. Runs only after the copy is up and
 * healthy; the database part is one transaction. A failure here doesn't undo a working move, so it
 * comes back as a sentence for the result instead.
 */
async function carryOver(from: string, to: string, movedAt: number, user: User, where: Where, emit: (e: MoveEvent) => void): Promise<string | null> {
  const t = Date.now();
  let plan: RecordPlan;
  try {
    plan = planRecordMove(snapshotRecords(from, to, tryReadConfig(), t), from, to, { movedAt, now: t });
    applyRecordPlan(plan);
  } catch (e) {
    emit({ type: "line", text: e instanceof Error ? e.message : String(e), stream: "err" });
    return "Gluon couldn't hand over its settings, access and Home pins, so check them on its Settings tab.";
  } finally {
    invalidateMonitors();
  }
  if (plan.summary.length) emit({ type: "step", text: `Handed over ${listJoin(plan.summary)}` });
  if (plan.routes.ids.length || plan.routes.fallback) {
    try {
      await reassignRouteApp(user, { ip: where.ip ?? "", zone: where.zone ?? "" }, from, to);
    } catch (e) {
      emit({ type: "line", text: e instanceof Error ? e.message : String(e), stream: "err" });
      return "Its public address still names the old copy (it reaches the new one anyway, on the same port). Pick the new app for it under Network.";
    }
  }
  return null;
}

async function execute(p: Prepared, user: User, where: Where, emit: (e: MoveEvent) => void) {
  const { plan, app } = p;
  const dir = plan.folder;
  const startedAt = Date.now();
  const moveId = `${plan.id}-${startedAt.toString(36)}`;
  const present = plan.copies.filter((c) => !c.missing);
  const total = present.reduce((n, c) => n + (c.size ?? 0), 0);
  let stopped = false;
  let created = false;
  let started = false;
  const detail = { newId: plan.newId, folder: dir, copies: plan.copies.map((c) => ({ from: c.from, to: c.to })) };

  const rollback = async (why: string, extra?: string): Promise<void> => {
    emit({ type: "step", text: "Putting things back the way they were" });
    if (started) await spawnLines("docker", [...projectArgs(dir, plan.newId), "down", "--remove-orphans"], emit, 5 * MIN);
    // Only the folder this move made, identified by its own marker, is ever deleted.
    if (created && readMarker(dir)?.moveId === moveId && !isBroadPath(dir)) {
      await host("rm", ["-rf", "--one-file-system", "--", dir], { timeoutMs: 60 * MIN }).catch((e) => emit({ type: "line", text: `Couldn't delete ${dir}: ${e instanceof Error ? e.message : e}`, stream: "err" }));
    }
    const back = stopped ? await startOriginal(p, emit) : true;
    const message = back
      ? `${why} ${app.name} is back the way it was${p.originals.some((o) => o.running) ? " and running" : ""}${created ? ", and the unfinished copy is gone" : ""}.`
      : `${why} Gluon also couldn't start the original ${app.name} again. Start it from its page; its data was never changed.`;
    audit(user, { action: "app.move", target: app.id, summary: `Tried to move ${app.name} to Gluon; rolled back`, detail: { ...detail, why, restarted: back }, outcome: "failed" }, where);
    emit({ type: "result", ok: false, rolledBack: true, newId: null, message, detail: extra });
  };

  try {
    emit({ type: "stage", stage: "stop" });
    // Counted as stopped before it finishes: a stop that fails halfway still gets undone.
    stopped = true;
    await stopOriginal(p, emit);

    emit({ type: "stage", stage: "copy" });
    fs.mkdirSync(hostPath(path.posix.dirname(dir)), { recursive: true, mode: 0o755 });
    // Not recursive: if anything made this folder since the plan, the move stops here instead of
    // writing its marker into someone else's folder (which a rollback would then delete).
    try {
      fs.mkdirSync(hostPath(dir), { mode: 0o755 });
    } catch (e) {
      throw new AppError("folder_taken", (e as NodeJS.ErrnoException).code === "EEXIST" ? `${dir} appeared while ${app.name} was stopping, so Gluon left it alone.` : `Gluon couldn't create ${dir}.`, 409);
    }
    fs.writeFileSync(hostPath(`${dir}/${MARKER}`), moveMarker({ source: plan.source, id: app.id, name: app.name }, moveId, user.username));
    created = true;
    invalidateAppsRoot();
    let done = 0;
    for (const c of plan.copies) {
      if (c.missing) {
        emit({ type: "step", text: `${c.from} doesn't exist yet; the app creates it` });
        continue;
      }
      const what = c.volume && !/^[0-9a-f]{64}$/.test(c.volume) ? `the volume ${c.volume}` : c.from;
      emit({ type: "step", text: `Copying ${what}${c.size ? ` (${formatBytes(c.size)})` : ""}` });
      await copyOne(c.from, c.to, c.size, done, total, emit);
      done += c.size ?? 0;
      emit({ type: "progress", done, total });
    }
    const write = (rel: string, text: string, mode: number) => {
      const f = hostPath(`${dir}/${rel}`);
      fs.writeFileSync(`${f}.tmp`, text, { mode });
      fs.renameSync(`${f}.tmp`, f);
    };
    write("docker-compose.yml", plan.compose, 0o644);
    if (p.envText !== null) write(".env", p.envText, 0o600);
    emit({ type: "step", text: `Wrote ${dir}/docker-compose.yml` });

    emit({ type: "stage", stage: "start" });
    emit({ type: "step", text: "Starting the copy with docker compose up" });
    started = true;
    const code = await spawnLines("docker", [...projectArgs(dir, plan.newId), "up", "-d", "--remove-orphans"], emit, 30 * MIN);
    if (code !== 0) return await rollback("The copy didn't start.");

    emit({ type: "stage", stage: "check" });
    const health = await waitHealthy(plan.newId, plan.compose, emit);
    if (!health.ok) {
      await tailLogs(plan.newId, health.containers, emit);
      return await rollback(`The copy didn't come up: ${health.why}`);
    }
  } catch (e) {
    const why = e instanceof AppError ? e.message : `The move stopped: ${e instanceof Error ? e.message : String(e)}.`;
    return await rollback(why);
  }

  const handover = await carryOver(app.id, plan.newId, startedAt, user, where, emit);
  invalidateApps();
  audit(user, { action: "app.move", target: app.id, summary: `Moved ${app.name} to Gluon`, detail }, where);
  emit({
    type: "result",
    ok: true,
    rolledBack: false,
    newId: plan.newId,
    message: `${app.name} now runs from Gluon. The old copy is stopped and its data is untouched; remove it once you've checked the new one works.${handover ? ` ${handover}` : ""}`,
  });
}
