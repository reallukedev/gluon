import "server-only";
import fs from "node:fs";
import { registerCheck, registerRemedy } from "./engine";
import { raise, resolve, resolveMissing } from "../findings";
import { filesystems, latestHost, history } from "../metrics/sampler";
import { listApps } from "../docker/apps";
import { appAction } from "../docker/actions";
import { recentDies, explainExit } from "../docker/events";
import { docker } from "../docker/client";
import { hostPath, readHostFileOr } from "../host/paths";
import { host, local } from "../host/exec";
import { getSetting } from "../settings";
import { formatBytes } from "@/lib/format";
import { AppError } from "../errors";

// ---------------------------------------------------------------- disk space

/** Leftovers from moving Docker/containerd storage: `<dir>.old` next to a live dir that is now a mount. */
interface Leftover {
  path: string;
  bytes: number;
}

const leftoverCache = new Map<string, { at: number; bytes: number }>();

async function dirSize(p: string): Promise<number> {
  const c = leftoverCache.get(p);
  if (c && Date.now() - c.at < 30 * 60_000) return c.bytes;
  const { stdout } = await local("du", ["-sxb", hostPath(p)], { timeoutMs: 120_000 });
  const bytes = Number(stdout.split(/\s+/)[0]) || 0;
  leftoverCache.set(p, { at: Date.now(), bytes });
  return bytes;
}

function isMountpoint(p: string): boolean {
  const mounts = readHostFileOr("/proc/1/mounts", "");
  return mounts.split("\n").some((l) => l.split(" ")[1] === p);
}

export async function findLeftovers(): Promise<Leftover[]> {
  const out: Leftover[] = [];
  for (const name of ["docker", "containerd"]) {
    const live = `/var/lib/${name}`;
    const old = `${live}.old`;
    if (!fs.existsSync(hostPath(old))) continue;
    // Only safe if the live directory has moved to its own mount (so .old is really unused).
    if (!isMountpoint(live)) continue;
    out.push({ path: old, bytes: await dirSize(old) });
  }
  return out.filter((l) => l.bytes > 0);
}

/**
 * Days until full at the recent fill rate, or null if it isn't reliably filling.
 * Uses the change between the median of the first and last hour of the window (robust to spikes
 * from one-off downloads) and needs at least 6 hours of history.
 */
function daysToFull(mount: string, avail: number): number | null {
  const series = history([`fs.${mount}.used`], 86_400_000)[`fs.${mount}.used`] ?? [];
  if (series.length < 60) return null;
  const span = series.at(-1)![0] - series[0]![0];
  if (span < 6 * 3_600_000) return null;
  const median = (xs: number[]) => {
    const a = [...xs].sort((x, y) => x - y);
    return a[Math.floor(a.length / 2)]!;
  };
  const head = series.filter(([t]) => t <= series[0]![0] + 3_600_000).map(([, v]) => v);
  const tail = series.filter(([t]) => t >= series.at(-1)![0] - 3_600_000).map(([, v]) => v);
  const perDay = ((median(tail) - median(head)) / (span - 3_600_000)) * 86_400_000;
  if (perDay < 200 * 1024 * 1024) return null; // under 200 MB/day is normal churn
  return avail / perDay;
}

function humanDays(d: number) {
  if (d < 1) return `in ${Math.max(1, Math.round(d * 24))} hours`;
  if (d < 1.5) return "in about a day";
  return `in about ${Math.round(d)} days`;
}

registerCheck("disk-space", 60_000, async () => {
  const { diskAttention, diskFault } = getSetting("thresholds");
  const open = new Set<string>();
  for (const f of filesystems()) {
    if (f.size < 256 * 1024 * 1024) continue; // tiny (EFI etc.)
    const pct = f.pct;
    const days = daysToFull(f.mount, f.avail);
    // "Filling fast" only matters for disks that are already fairly full.
    const soon = days !== null && days < 3 && pct >= 60;
    if (pct < diskAttention && !soon) continue;
    const id = `disk.full:${f.mount}`;
    open.add(id);
    const severity = pct >= diskFault || (days !== null && days < 1 && pct >= 80) ? "fault" : "attention";
    let cause = `${formatBytes(f.avail)} free of ${formatBytes(f.size)}.`;
    if (days !== null) cause += ` At the current rate it fills ${humanDays(days)}.`;
    let remedy: Parameters<typeof raise>[0]["remedy"] = { action: "", label: "See what's using it", href: `/storage?usage=${encodeURIComponent(f.mount)}` };

    // The old copies live under /var: they only help the filesystem that actually holds /var.
    const varFs = filesystems().some((x) => x.mount === "/var") ? "/var" : "/";
    if (f.mount === varFs) {
      const leftovers = await findLeftovers();
      const total = leftovers.reduce((a, l) => a + l.bytes, 0);
      if (total > 100 * 1024 * 1024) {
        cause = `The old copies of Docker's storage (${leftovers.map((l) => l.path).join(", ")}, ${formatBytes(total)}) were kept after the move to /srv. ${cause}`;
        remedy = {
          action: "storage.removeLeftovers",
          label: `Free ${formatBytes(total)}`,
          params: { paths: leftovers.map((l) => l.path) },
          confirm: {
            title: `Delete the old storage copies?`,
            consequences: [
              `Deletes ${leftovers.map((l) => l.path).join(" and ")} (${formatBytes(total)}).`,
              "They're unused: Docker now runs from /srv, and your apps won't notice.",
              "This can't be undone.",
            ],
          },
        };
      }
    }
    raise({
      id,
      kind: "disk.full",
      severity,
      subject: f.mount,
      title: soon && pct < diskAttention ? `${f.mount} is filling up fast` : `${f.mount} is ${Math.round(pct)}% full`,
      cause,
      detail: { mount: f.mount, device: f.device, pct, avail: f.avail, size: f.size, daysToFull: days },
      remedy,
    });
  }
  resolveMissing("disk.full", open);
});

registerRemedy("storage.removeLeftovers", {
  recent: true,
  async run({ params }) {
    const paths = (params.paths as string[]) ?? [];
    const allowed = (await findLeftovers()).map((l) => l.path);
    let freed = 0;
    for (const p of paths) {
      if (!allowed.includes(p)) throw new AppError("unsafe", `${p} isn't a leftover Gluon can safely remove.`, 400);
      freed += (await findLeftovers()).find((l) => l.path === p)?.bytes ?? 0;
      await host("rm", ["-rf", "--one-file-system", "--", p], { timeoutMs: 10 * 60_000 });
      leftoverCache.delete(p);
    }
    return { message: `Freed ${formatBytes(freed)} by removing ${paths.join(" and ")}` };
  },
});

// ---------------------------------------------------------------- apps

registerCheck("apps", 20_000, async () => {
  const apps = await listApps();
  const open = new Set<string>();
  for (const app of apps) {
    for (const c of app.containers) {
      const dies = recentDies(c.name);
      const crashLoop = dies >= 3 || c.state === "restarting";
      const unhealthy = c.health === "unhealthy";
      let unexpectedExit: { code: number } | null = null;
      if (c.state === "exited") {
        try {
          const info = await docker().getContainer(c.id).inspect();
          const policy = info.HostConfig.RestartPolicy?.Name ?? "no";
          const code = info.State.ExitCode;
          // Only surprising if it was meant to keep running and didn't exit cleanly.
          if ((policy === "always" || policy === "unless-stopped" || policy === "on-failure") && code !== 0 && code !== 143) unexpectedExit = { code };
        } catch {
          /* gone */
        }
      }
      if (!crashLoop && !unhealthy && !unexpectedExit) continue;
      const id = `app.broken:${c.name}`;
      open.add(id);
      const who = app.containers.length > 1 ? `${app.name} (${c.service ?? c.name})` : app.name;
      let title: string;
      let cause: string;
      if (crashLoop) {
        title = `${who} keeps crashing`;
        cause = `It has restarted ${dies} time${dies === 1 ? "" : "s"} in the last 15 minutes. The logs usually show why.`;
      } else if (unexpectedExit) {
        title = `${who} stopped unexpectedly`;
        cause = `It ${explainExit(unexpectedExit.code)}.`;
      } else {
        title = `${who} isn't healthy`;
        cause = "It's running but failing its own health check, so it may not be responding.";
      }
      raise({
        id,
        kind: "app.broken",
        severity: "fault",
        subject: app.id,
        title,
        cause,
        detail: { container: c.name, state: c.state, health: c.health, dies },
        remedy: crashLoop
          ? { action: "", label: "Read the logs", href: `/apps/${encodeURIComponent(app.id)}?tab=logs&container=${encodeURIComponent(c.name)}` }
          : { action: "apps.restart", label: `Restart ${app.name}`, params: { id: app.id } },
      });
    }
  }
  resolveMissing("app.broken", open);
});

registerRemedy("apps.restart", {
  async run({ params }) {
    return { message: await appAction(String(params.id), "restart") };
  },
});
registerRemedy("apps.start", {
  async run({ params }) {
    return { message: await appAction(String(params.id), "start") };
  },
});

// ---------------------------------------------------------------- memory & temperature

registerCheck("memory", 30_000, () => {
  const h = latestHost();
  if (!h) return;
  const pct = (h.mem.used / h.mem.total) * 100;
  const limit = getSetting("thresholds").memoryAttention;
  if (pct >= limit) {
    raise({
      id: "host.memory",
      kind: "host.memory",
      severity: pct >= 97 ? "fault" : "attention",
      subject: "memory",
      title: `Memory is ${Math.round(pct)}% used`,
      cause: `${formatBytes(h.mem.available)} left. Apps may slow down or be killed. The Apps page shows which ones use the most.`,
      remedy: { action: "", label: "See memory by app", href: "/apps?sort=memory" },
    });
  } else resolve("host.memory");
});

registerCheck("temperature", 30_000, () => {
  const h = latestHost();
  if (!h || h.temp === null) return;
  const limit = getSetting("thresholds").tempAttention;
  if (h.temp >= limit) {
    raise({
      id: "host.temperature",
      kind: "host.temperature",
      severity: h.temp >= limit + 10 ? "fault" : "attention",
      subject: "cpu",
      title: `The processor is running hot (${Math.round(h.temp)}°C)`,
      cause: "Check that the fans are spinning and the vents aren't blocked. Heavy work like video transcoding also raises it.",
      remedy: { action: "", label: "See what's busy", href: "/diagnostics?tab=processes" },
    });
  } else if (h.temp < limit - 5) resolve("host.temperature");
});
