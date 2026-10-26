import "server-only";
import { docker } from "./client";
import { invalidateApps } from "./apps";
import { publish } from "../events";
import { systemEvent } from "../audit";
import { onStart } from "../jobs";

/**
 * Follows `docker events` so Gluon knows about crashes the moment they happen (rather than on the
 * next poll) and can tell a crash loop from a one-off restart.
 */

export interface DockerEvent {
  t: number;
  type: string;
  action: string;
  id: string;
  name: string;
  project: string | null;
  exitCode: number | null;
}

interface EvState { recent: DockerEvent[]; dies: Map<string, number[]> }
type G = typeof globalThis & { __gluonDockerEvents?: EvState };
const g = globalThis as G;
const st = (): EvState => (g.__gluonDockerEvents ??= { recent: [], dies: new Map<string, number[]>() });

export const recentDockerEvents = () => st().recent;

/** How many times a container died in the last `windowMs`. */
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
        stream.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
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
  if (action === "die") {
    const arr = s.dies.get(ev.name) ?? [];
    arr.push(ev.t);
    s.dies.set(ev.name, arr.slice(-50));
    // A non-zero exit that wasn't a requested stop is worth recording.
    if (ev.exitCode && ev.exitCode !== 143 && ev.exitCode !== 0) {
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
