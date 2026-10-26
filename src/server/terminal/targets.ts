import "server-only";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { AppError } from "../errors";
import { findContainer, selfContainerId, snapshot } from "../dockerx/core";
import { host } from "../host/exec";
import { getSetting } from "../settings";
import { containerOf, type DirEntry, type TargetGroup, type TargetId, type TargetList, type TargetProbe } from "@/lib/terminal/types";
import { captureInContainer, HOST_PATH, type Place } from "./proc";

const devLocal = () => (process.env.GLUON_NO_NSENTER ?? process.env.TEND_NO_NSENTER) === "1";

type G = typeof globalThis & { __gluonPython?: boolean };
const g = globalThis as G;

function hasPython(): boolean {
  if (g.__gluonPython !== undefined) return g.__gluonPython;
  try {
    execFileSync("python3", ["-c", "import pty"], { stdio: "ignore", timeout: 4000 });
    g.__gluonPython = true;
  } catch {
    g.__gluonPython = false;
  }
  return g.__gluonPython;
}

/** Whether "This server" can be opened, and why not. */
export function hostAvailability(): { available: boolean; note: string | null } {
  if (devLocal()) {
    return hasPython() ? { available: true, note: "Development: this is the computer running Gluon." } : { available: false, note: "The server terminal needs Gluon to run in Docker (or Python 3 on this computer, for development)." };
  }
  return selfContainerId() ? { available: true, note: null } : { available: false, note: "Gluon couldn't find its own container, so it can't open a terminal on the server. It needs to run in Docker with the host's process list (pid: host)." };
}

export interface Resolved {
  target: TargetId;
  place: Place;
  /** "This server" or the container's name, for messages and the audit log. */
  label: string;
  /** The app the container belongs to, for the audit log's target. */
  auditTarget: string;
  host: boolean;
}

export async function resolveTarget(target: TargetId): Promise<Resolved> {
  const name = containerOf(target);
  if (!name) {
    const a = hostAvailability();
    if (!a.available) throw new AppError("unavailable", a.note ?? "The server terminal isn't available.", 409);
    const place: Place = devLocal() ? { kind: "local" } : { kind: "self", id: selfContainerId()! };
    return { target, place, label: "this server", auditTarget: "server", host: true };
  }
  const { info, ref } = await findContainer(name);
  if (ref.self) throw new AppError("protected", "Gluon doesn't open terminals inside its own container. Pick This server instead.", 409);
  if (info.State !== "running") throw new AppError("not_running", `${ref.name} isn't running. Start it from its app first.`, 409);
  return { target, place: { kind: "container", id: info.Id }, label: ref.name, auditTarget: ref.app?.id ?? ref.name, host: false };
}

// ---------------------------------------------------------------- the picker

export async function listTargets(): Promise<TargetList> {
  const a = hostAvailability();
  const snap = await snapshot();
  const groups = new Map<string, TargetGroup>();
  for (const c of snap.containers) {
    const ref = snap.refs.get(c.Id);
    if (!ref) continue;
    const app = ref.app ? snap.appById.get(ref.app.id) : undefined;
    const project = c.Labels?.["com.docker.compose.project"];
    const key = app ? `app:${app.id}` : project ? `project:${project}` : "other";
    let grp = groups.get(key);
    if (!grp) {
      grp = { key, name: app?.name ?? project ?? "Other containers", icon: app?.icon ?? null, href: app ? `/apps/${encodeURIComponent(app.id)}` : null, targets: [] };
      groups.set(key, grp);
    }
    grp.targets.push({
      id: `container:${ref.name}`,
      name: ref.name,
      state: ref.state,
      line: ref.line,
      blocked: ref.self ? "This is Gluon" : ref.state !== "running" ? (ref.state === "paused" ? "Paused" : "Not running") : null,
    });
  }
  const list = [...groups.values()];
  for (const grp of list) grp.targets.sort((x, y) => Number(!!x.blocked) - Number(!!y.blocked) || x.name.localeCompare(y.name));
  // Apps with something to open first, then by name; "Other containers" last.
  list.sort((x, y) => Number(x.key === "other") - Number(y.key === "other") || Number(x.targets.every((t) => t.blocked)) - Number(y.targets.every((t) => t.blocked)) || x.name.localeCompare(y.name));
  return { host: { available: a.available, note: a.note, name: getSetting("serverName") }, groups: list };
}

// ---------------------------------------------------------------- what a target is like

/** Fixed script: the best shell, who we are, where we start, and every program on the PATH. */
const PROBE = `
s=$(command -v bash || command -v ash || command -v sh || echo /bin/sh)
echo "shell=$s"
echo "user=$(id -un 2>/dev/null || id -u 2>/dev/null)"
echo "home=$HOME"
echo "pwd=$(pwd)"
echo "---"
if command -v bash >/dev/null 2>&1; then bash -c 'compgen -c' 2>/dev/null; else IFS=:; for d in $PATH; do ls -1 "$d" 2>/dev/null; done; fi
`;

const probeCache = new Map<string, { at: number; value: Promise<TargetProbe> }>();

export function probeTarget(r: Resolved): Promise<TargetProbe> {
  const key = r.place.kind === "container" ? r.place.id : "host";
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < 120_000) return hit.value;
  const value = runProbe(r);
  probeCache.set(key, { at: Date.now(), value });
  value.catch(() => probeCache.delete(key));
  return value;
}

async function runProbe(r: Resolved): Promise<TargetProbe> {
  let text: string;
  if (r.place.kind === "container") {
    const res = await captureInContainer(r.place.id, ["sh", "-c", PROBE], { timeoutMs: 8000 });
    if (res.code === 126 || res.code === 127 || (!res.stdout && res.code !== 0)) {
      throw new AppError("no_shell", `${r.label} has no shell to run commands with. Some images are built without one.`, 409);
    }
    text = res.stdout;
  } else {
    const env: Record<string, string> = r.place.kind === "local" ? { HOME: os.homedir(), PATH: process.env.PATH ?? HOST_PATH } : { HOME: "/root" };
    text = (await host("sh", ["-c", PROBE], { timeoutMs: 8000, env })).stdout;
  }
  const [head, list = ""] = text.split("\n---\n");
  const kv = new Map<string, string>();
  for (const line of (head ?? "").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) kv.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  const commands = [...new Set(list.split("\n").map((s) => s.trim()).filter((s) => /^[\w+-][\w.+-]{0,63}$/.test(s)))].sort().slice(0, 6000);
  const home = kv.get("home") || null;
  const cwd = r.host ? home || "/" : kv.get("pwd") || "/";
  return { shell: kv.get("shell") || "/bin/sh", user: kv.get("user") || "root", home, cwd, commands };
}

// ---------------------------------------------------------------- suggestions that ask the target

export async function listDir(r: Resolved, dir: string): Promise<DirEntry[]> {
  const argv = ["ls", "-1Ap", "--", dir];
  let out: string;
  if (r.place.kind === "container") out = (await captureInContainer(r.place.id, argv, { timeoutMs: 5000, maxBytes: 512 * 1024 })).stdout;
  else out = (await host(argv[0]!, argv.slice(1), { timeoutMs: 5000, okCodes: [1, 2], maxBuffer: 512 * 1024 }).catch(() => ({ stdout: "" }))).stdout;
  return out
    .split("\n")
    .filter((l) => l && l !== "./" && l !== "../")
    .slice(0, 3000)
    .map((l) => (l.endsWith("/") ? { name: l.slice(0, -1), dir: true } : { name: l, dir: false }));
}

let unitCache: { at: number; value: string[] } | null = null;

export async function listUnits(): Promise<string[]> {
  if (unitCache && Date.now() - unitCache.at < 60_000) return unitCache.value;
  const names = new Set<string>();
  const run = async (args: string[]) => {
    try {
      const { stdout } = await host("systemctl", args, { timeoutMs: 6000 });
      for (const line of stdout.split("\n")) {
        const u = line.trim().split(/\s+/)[0];
        if (u && /^[\w@.:\\-]+\.(service|socket|timer|mount|target|path)$/.test(u)) names.add(u);
      }
    } catch {
      /* no systemd here */
    }
  };
  await Promise.all([run(["list-units", "--all", "--plain", "--no-legend", "--no-pager"]), run(["list-unit-files", "--plain", "--no-legend", "--no-pager"])]);
  const value = [...names].filter((u) => !u.includes("@.")).sort();
  unitCache = { at: Date.now(), value };
  return value;
}

export async function containerNames(): Promise<string[]> {
  const snap = await snapshot();
  return [...snap.refs.values()].map((r) => r.name).sort();
}
