import "server-only";
import { umbrelAction, umbrelAppState, type UmbrelAppState } from "../platform/umbrel";
import { docker } from "./client";
import { getApp, invalidateApps, type AppSummary } from "./apps";
import { host } from "../host/exec";
import { AppError, notFound } from "../errors";
import { publish } from "../events";
import { lockApps } from "../apps/lock";
import { spawnLines } from "../apps/spawn";

export type AppAction = "start" | "stop" | "restart" | "update" | "down" | "uninstall";

function composeArgs(app: AppSummary, ...rest: string[]) {
  if (!app.configFile) throw new AppError("no_compose", "This app wasn't started with Docker Compose, so Gluon can't manage it as a stack.");
  const args = ["compose", "-p", app.id];
  for (const f of app.configFile.split(",")) args.push("-f", f);
  return [...args, ...rest];
}

/** Guard: Gluon must not stop or recreate itself from the UI. */
function guardSelf(app: AppSummary, action: AppAction) {
  if (app.self && action !== "restart") {
    throw new AppError("self", "Gluon can't stop or update itself from here. Restart it instead, or use the terminal.");
  }
}

export async function appAction(id: string, action: AppAction): Promise<string> {
  const app = await getApp(id);
  if (!app) throw notFound("That app");
  guardSelf(app, action);
  // Everything else uninstalls through /api/apps/[id]/uninstall, which asks what happens to its data.
  if (action === "uninstall" && !app.umbrel) throw new AppError("unsupported", "Uninstall it from its page, where you choose whether to keep its data.");
  // Refused while a move or an uninstall works on this app (starting an original mid-copy would
  // tear the data being copied), and holds the app for the length of the action.
  const lock = lockApps([app.id], `${app.name} is being ${{ start: "started", stop: "stopped", restart: "restarted", update: "updated", down: "removed", uninstall: "uninstalled" }[action]}`);
  try {
    if (app.umbrel) {
      // Umbrel owns these apps: going around it would leave its state out of step.
      if (action === "down") throw new AppError("unsupported", `Umbrel manages ${app.name}. Stop or uninstall it instead.`);
      await umbrelAction(app.id, action);
    } else if (app.kind === "stack" && app.configFile) {
      const map: Record<AppAction, string[]> = {
        start: ["up", "-d", "--remove-orphans"],
        stop: ["stop"],
        restart: ["restart"],
        update: ["up", "-d", "--pull", "always", "--remove-orphans"],
        down: ["down"],
        uninstall: [],
      };
      await host("docker", composeArgs(app, ...map[action]), { timeoutMs: action === "update" ? 20 * 60_000 : 5 * 60_000, cwd: undefined });
    } else {
      for (const c of app.containers) {
        const ctr = docker().getContainer(c.id);
        if (action === "start") await ctr.start().catch(ignoreNotModified);
        else if (action === "stop" || action === "down") await ctr.stop().catch(ignoreNotModified);
        else if (action === "restart") await ctr.restart();
        else throw new AppError("unsupported", "Updating single containers isn't supported. Recreate it with Compose to update.");
      }
    }
  } finally {
    lock.release();
    invalidateApps();
    publish("apps.changed", { id });
  }
  const verbs: Record<AppAction, string> = {
    start: "Started",
    stop: "Stopped",
    restart: "Restarted",
    update: app.umbrel ? "Started updating" : "Updated",
    down: "Removed containers of",
    uninstall: "Started uninstalling",
  };
  return `${verbs[action]} ${app.name}`;
}

function ignoreNotModified(e: { statusCode?: number }) {
  if (e?.statusCode !== 304) throw e;
}

export async function containerAction(containerId: string, action: "start" | "stop" | "restart" | "pause" | "unpause" | "kill") {
  const c = docker().getContainer(containerId);
  try {
    await (c[action] as (opts?: object) => Promise<unknown>).call(c, {});
  } catch (e) {
    const err = e as { statusCode?: number; json?: { message?: string } };
    if (err.statusCode === 304) return;
    if (err.statusCode === 404) throw notFound("That container");
    throw new AppError("docker", err.json?.message ?? "Docker couldn't do that.", 500);
  } finally {
    invalidateApps();
    publish("apps.changed", { containerId });
  }
}

/**
 * Stream a compose operation's output (pull/up) line by line. Used for "Update" so the person can
 * watch images download instead of staring at a spinner.
 */
export async function streamCompose(app: AppSummary, args: string[], onLine: (line: string, stream: "out" | "err") => void, signal?: AbortSignal, timeoutMs = 30 * 60_000): Promise<number> {
  const r = await spawnLines("docker", composeArgs(app, ...args), onLine, { timeoutMs, signal });
  if (r.timedOut) onLine(`Stopped after ${Math.round(timeoutMs / 60_000)} minutes without finishing.`, "err");
  invalidateApps();
  publish("apps.changed", { id: app.id });
  return r.code;
}

/**
 * Follow an Umbrel app through a long action (install, update, uninstall) by polling its state,
 * emitting a line whenever it changes. Resolves with the state it settled in.
 */
export async function followUmbrel(
  appId: string,
  settled: (s: UmbrelAppState) => boolean,
  emit: (text: string, progress: number) => void,
  signal?: AbortSignal,
  timeoutMs = 45 * 60_000,
): Promise<UmbrelAppState> {
  const TEXT: Partial<Record<UmbrelAppState, string>> = {
    installing: "Installing",
    updating: "Updating",
    uninstalling: "Uninstalling",
    starting: "Starting",
    stopping: "Stopping",
    restarting: "Restarting",
    ready: "Running",
    running: "Running",
    stopped: "Stopped",
    "not-installed": "Not installed",
  };
  const end = Date.now() + timeoutMs;
  let last = "";
  let state: UmbrelAppState = "unknown";
  while (Date.now() < end && !signal?.aborted) {
    const s = await umbrelAppState(appId).catch(() => null);
    if (s) {
      state = s.state;
      const line = `${TEXT[s.state] ?? s.state}${s.progress ? ` · ${Math.round(s.progress)}%` : ""}`;
      if (line !== last) emit(line, s.progress);
      last = line;
      if (settled(s.state)) break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  invalidateApps();
  publish("apps.changed", { id: appId });
  return state;
}
