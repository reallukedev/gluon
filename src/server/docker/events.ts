import "server-only";
import { StringDecoder } from "node:string_decoder";
import { docker } from "./client";
import { invalidateApps } from "./apps";
import { publish } from "../events";
import { systemEvent } from "../audit";
import { onStart } from "../jobs";

/** Knowing about crashes the moment they happen lets Gluon tell a crash loop from a one-off restart. */

export interface DockerEvent {
  t: number;
  type: string;
  action: string;
  id: string;
  name: string;
  project: string | null;
  exitCode: number | null;
}

interface EvState {
  recent: DockerEvent[];
  /** Unrequested deaths of containers Docker restarts, by name: what a crash loop is made of. */
  dies: Map<string, number[]>;
  /** When someone last asked a container (by id) to stop: `docker stop`, `restart` and `kill` all send a kill first. */
  kills: Map<string, number>;
}
type G = typeof globalThis & { __gluonDockerEvents?: EvState };
const g = globalThis as G;
const st = (): EvState => {
  const s = (g.__gluonDockerEvents ??= { recent: [], dies: new Map(), kills: new Map() });
  // A state object left by an older build after a dev reload.
  s.kills ??= new Map();
  return s;
};

/** A die this long after a kill was the stop that was asked for (compose's stop_grace_period can be minutes). */
const REQUESTED_STOP_MS = 10 * 60_000;
const RELOAD_SIGNALS = new Set(["1", "10", "12", "28", "HUP", "SIGHUP", "USR1", "SIGUSR1", "USR2", "SIGUSR2", "WINCH", "SIGWINCH"]);

export const recentDockerEvents = () => st().recent;

/**
 * Stops someone asked for, and containers Docker doesn't restart (policy "no", or "on-failure" after
 * a clean exit), don't count.
 */
export function recentDies(name: string, windowMs = 15 * 60_000): number {
  const t = Date.now() - windowMs;
  return (st().dies.get(name) ?? []).filter((x) => x > t).length;
}

export function explainExit(code: number | null): string {
  switch (code) {
    case null:
      return "stopped";
    case 0:
      return "exited normally";
    case 137:
      return "was killed (code 137), usually because it ran out of memory or was force-stopped";
    case 139:
      return "crashed with a segmentation fault (code 139)";
    case 143:
      return "was asked to stop (code 143)";
    case 126:
    case 127:
      return `couldn't start its program (code ${code}); the image or command is probably wrong`;
    case 1:
      return "exited with an error (code 1); its logs will say why";
    default:
      return `exited with code ${code}`;
  }
}

const INTERESTING = new Set(["start", "die", "oom", "health_status: unhealthy", "health_status: healthy", "kill", "stop", "restart", "destroy", "create", "pause", "unpause"]);

async function follow() {
  let backoff = 1000;
  for (;;) {
    try {
      const stream = (await docker().getEvents({ filters: { type: ["container"] } })) as NodeJS.ReadableStream;
      backoff = 1000;
      await new Promise<void>((resolve) => {
        let buf = "";
        const dec = new StringDecoder("utf8");
        stream.on("data", (chunk: Buffer) => {
          buf += dec.write(chunk);
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (line.trim()) handle(line);
          }
        });
        stream.on("end", () => resolve());
        stream.on("error", () => resolve());
      });
    } catch {
      /* docker unavailable; retry */
    }
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 30_000);
  }
}

/** Read at each death, not remembered: `docker update --restart` (a move does it) changes it in place. */
async function restartPolicy(id: string): Promise<string | null> {
  try {
    const i = await docker().getContainer(id).inspect();
    return i.HostConfig?.RestartPolicy?.Name || "no";
  } catch {
    return null; // gone already (--rm), so Docker won't be restarting it
  }
}

async function countDie(ev: DockerEvent) {
  const policy = await restartPolicy(ev.id);
  if (!policy || policy === "no" || (policy === "on-failure" && !ev.exitCode)) return;
  const s = st();
  const arr = s.dies.get(ev.name) ?? [];
  arr.push(ev.t);
  s.dies.set(ev.name, arr.slice(-50));
}

/** Exported for tests; resolves once the event is fully counted. */
export async function handleDockerEvent(line: string): Promise<void> {
  handle(line);
  await pending;
}
let pending: Promise<void> = Promise.resolve();

function handle(line: string) {
  let e: { Action?: string; Actor?: { ID?: string; Attributes?: Record<string, string> }; time?: number; timeNano?: number };
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  const action = e.Action ?? "";
  if (!INTERESTING.has(action) && !action.startsWith("health_status")) return;
  const attrs = e.Actor?.Attributes ?? {};
  const ev: DockerEvent = {
    t: e.timeNano ? Math.floor(e.timeNano / 1e6) : (e.time ?? Date.now() / 1000) * 1000,
    type: "container",
    action,
    id: e.Actor?.ID ?? "",
    name: attrs.name ?? "",
    project: attrs["com.docker.compose.project"] ?? null,
    exitCode: attrs.exitCode !== undefined ? Number(attrs.exitCode) : null,
  };
  const s = st();
  s.recent.push(ev);
  if (s.recent.length > 500) s.recent.shift();
  // HUP and USR signals ask for a reload or a log rotation, not a stop.
  if (action === "kill" && ev.id && !RELOAD_SIGNALS.has(String(attrs.signal ?? "").toUpperCase())) {
    s.kills.set(ev.id, ev.t);
    if (s.kills.size > 1000) s.kills.delete(s.kills.keys().next().value!);
  }
  if (action === "destroy") s.kills.delete(ev.id);
  if (action === "die") {
    const killedAt = s.kills.get(ev.id);
    const requested = killedAt !== undefined && ev.t - killedAt >= -5000 && ev.t - killedAt < REQUESTED_STOP_MS;
    s.kills.delete(ev.id);
    if (!requested) pending = countDie(ev).catch(() => undefined);
    // Requested stops (137 after `docker stop` timed out included) are skipped above; 143 is a clean exit on SIGTERM.
    if (!requested && ev.exitCode && ev.exitCode !== 143) {
      systemEvent({ action: "container.crashed", target: ev.project ?? ev.name, summary: `${ev.name} ${explainExit(ev.exitCode)}`, outcome: "failed", detail: { exitCode: ev.exitCode } });
    }
  }
  if (action === "oom") systemEvent({ action: "container.oom", target: ev.project ?? ev.name, summary: `${ev.name} ran out of memory`, outcome: "failed" });
  invalidateApps();
  publish("docker.event", ev);
}

onStart("docker-events", () => {
  void follow();
});
