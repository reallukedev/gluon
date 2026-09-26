import "server-only";
import fs from "node:fs";
import { filesystems, sampleFilesystems, history, type FsUsage } from "../../metrics/sampler";
import { getInventoryState, type InventoryState } from "../../storage/inventory";
import { notPersistent } from "../../storage/ops";
import { hostPath } from "../../host/paths";
import { getSetting } from "../../settings";
import { formatBytes, listJoin } from "@/lib/format";
import type { DiskView } from "@/lib/storage-types";
import { fail, go, kv, ok, skip, warn, type CheckCtx, type CheckSpec, type Outcome } from "./core";

/** Storage: free space per filesystem, inodes, SMART health, and mounts that won't survive a restart. */

export const inventory = (ctx: CheckCtx) => ctx.memo("inventory", () => getInventoryState());

export function realFilesystems(): FsUsage[] {
  const list = filesystems();
  return (list.length ? list : sampleFilesystems()).filter((f) => f.size >= 256 * 1024 * 1024);
}

/** Days until full at the last day's fill rate, or null when it isn't reliably filling. */
export function daysToFull(mount: string, avail: number): { days: number | null; perDay: number | null } {
  const series = history([`fs.${mount}.used`], 86_400_000)[`fs.${mount}.used`] ?? [];
  if (series.length < 60) return { days: null, perDay: null };
  const span = series.at(-1)![0] - series[0]![0];
  if (span < 6 * 3_600_000) return { days: null, perDay: null };
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const head = series.filter(([t]) => t <= series[0]![0] + 3_600_000).map(([, v]) => v);
  const tail = series.filter(([t]) => t >= series.at(-1)![0] - 3_600_000).map(([, v]) => v);
  const perDay = ((median(tail) - median(head)) / (span - 3_600_000)) * 86_400_000;
  if (perDay < 200 * 1024 * 1024) return { days: null, perDay };
  return { days: avail / perDay, perDay };
}

const humanDays = (d: number) => (d < 1 ? `in about ${Math.max(1, Math.round(d * 24))} hours` : d < 1.5 ? "in about a day" : `in about ${Math.round(d)} days`);

export function spaceOutcome(f: FsUsage): Outcome {
  const { diskAttention, diskFault } = getSetting("thresholds");
  const pct = Math.round(f.pct);
  const fill = daysToFull(f.mount, f.avail);
  const evidence = kv([
    ["Device", `${f.device} (${f.fstype})`],
    ["Size", formatBytes(f.size)],
    ["Used", `${formatBytes(f.used)} (${f.pct.toFixed(1)}%)`],
    ["Free", formatBytes(f.avail)],
    ["Growth, last day", fill.perDay === null ? "not enough history" : `${fill.perDay >= 0 ? "+" : "−"}${formatBytes(Math.abs(fill.perDay))} a day`],
    ["Gluon warns at", `${diskAttention}% (fault at ${diskFault}%)`],
  ]);
  const findings = [`disk.full:${f.mount}`];
  const fix = go("See what's using it", `/storage?usage=${encodeURIComponent(f.mount)}`);
  const soon = fill.days !== null && fill.days < 3 && pct >= 60;
  const value = `${pct}%`;
  if (pct >= diskFault || (fill.days !== null && fill.days < 1 && pct >= 80)) {
    return fail(`${f.mount} is ${pct}% full`, { value, detail: `${formatBytes(f.avail)} free of ${formatBytes(f.size)}.${fill.days !== null ? ` At the current rate it fills ${humanDays(fill.days)}.` : ""} Apps writing here will start failing when it's full.`, evidence, findings, fix });
  }
  if (pct >= diskAttention || soon) {
    return warn(soon && pct < diskAttention ? `${f.mount} is filling up fast` : `${f.mount} is ${pct}% full`, { value, detail: `${formatBytes(f.avail)} free of ${formatBytes(f.size)}.${fill.days !== null ? ` At the current rate it fills ${humanDays(fill.days)}.` : ""}`, evidence, findings, fix });
  }
  return ok(`${f.mount} has ${formatBytes(f.avail)} free (${pct}% used)`, { value, evidence });
}

function spaceCheck(mount: string): CheckSpec {
  return {
    id: `storage.space:${mount}`,
    group: "storage",
    label: `Space on ${mount}`,
    run: async () => {
      const f = realFilesystems().find((x) => x.mount === mount);
      if (!f) return skip(`${mount} isn't mounted any more`);
      return spaceOutcome(f);
    },
  };
}

/** Inode use per filesystem (running out of inodes looks like "disk full" with space left). */
export function inodeOutcome(list: FsUsage[]): Outcome {
  const rows: [string, string][] = [];
  const high: { mount: string; pct: number }[] = [];
  for (const f of list) {
    try {
      const s = fs.statfsSync(hostPath(f.mount));
      if (!s.files) {
        rows.push([f.mount, "no inode limit"]);
        continue;
      }
      const pct = ((s.files - s.ffree) / s.files) * 100;
      rows.push([f.mount, `${(s.files - s.ffree).toLocaleString("en-US")} of ${s.files.toLocaleString("en-US")} (${pct.toFixed(1)}%)`]);
      if (pct >= 85) high.push({ mount: f.mount, pct });
    } catch {
      rows.push([f.mount, "unreadable"]);
    }
  }
  const evidence = kv(rows);
  if (!rows.length) return skip("No filesystems to check");
  const worstOne = high.sort((a, b) => b.pct - a.pct)[0];
  if (worstOne && worstOne.pct >= 95) return fail(`${worstOne.mount} has almost no room left for new files`, { detail: `${worstOne.pct.toFixed(0)}% of its file slots (inodes) are used, usually by millions of tiny files like caches or thumbnails. New files fail even with free space.`, evidence, fix: go("See what's using it", `/storage?usage=${encodeURIComponent(worstOne.mount)}`) });
  if (worstOne) return warn(`${worstOne.mount} is running low on file slots (${worstOne.pct.toFixed(0)}% of inodes used)`, { detail: "Usually caused by huge numbers of tiny files, like caches or thumbnails.", evidence, fix: go("See what's using it", `/storage?usage=${encodeURIComponent(worstOne.mount)}`) });
  return ok(`Every filesystem has plenty of room for new files`, { evidence });
}

const named = (d: DiskView) => `${d.title}${d.model ? ` (${d.model})` : ""}`;

export function smartOutcome(d: DiskView): Outcome {
  const sm = d.smart;
  const href = `/storage/${encodeURIComponent(d.id)}`;
  if (!sm || sm.state === "unavailable") return skip(`Health of the ${named(d)} can't be read`, { detail: sm?.message ?? "The drive doesn't report SMART data (common for USB adapters and card readers)." });
  const evidence = kv([
    ["Drive", `${d.path} · ${d.model ?? "unknown model"} · ${d.serial ?? "no serial"}`],
    ["Overall", sm.passed === null ? "unknown" : sm.passed ? "passed" : "FAILED"],
    ["Temperature", sm.temperature === null ? null : `${sm.temperature} °C${sm.tempLimit ? ` (rated to ${sm.tempLimit} °C)` : ""}`],
    ["Power-on", sm.powerOnHours === null ? null : `${sm.powerOnHours.toLocaleString("en-US")} hours (${(sm.powerOnHours / 8766).toFixed(1)} years)`],
    ["Replaced sectors", sm.reallocated],
    ["Pending sectors", sm.pending],
    ["Uncorrectable", sm.uncorrectable],
    ["Wear", sm.wearPercent === null ? null : `${sm.wearPercent}% of rated writes`],
    ["Last self-test", sm.lastSelfTest ? `${sm.lastSelfTest.type}: ${sm.lastSelfTest.status}` : null],
    ["Read", sm.readAt ? new Date(sm.readAt).toISOString() : null],
  ]);
  const findings = [`storage.smart:${d.id}`];
  const fix = go("See drive health", href);
  const notes = sm.notes.slice(0, 2).join(" ");
  if (sm.state === "failing") return fail(`The ${named(d)} is failing`, { detail: `${notes} Copy anything important off it and plan to replace it.`, evidence, findings, fix });
  if (sm.state === "warning") return warn(`The ${named(d)} is showing signs of wear`, { detail: `${notes} Make sure what's on it is backed up.`, evidence, findings, fix });
  if (sm.state === "asleep") return ok(`The ${named(d)} is asleep; its last health reading was fine`, { evidence });
  if (sm.reallocatedRising) return warn(`The ${named(d)} is replacing bad sectors`, { detail: `${sm.reallocated} so far, and the number went up recently. That often comes before a failure.`, evidence, findings, fix });
  return ok(`The ${named(d)} reports good health`, { detail: (sm.reallocated ?? 0) > 0 ? `${sm.reallocated} replaced sector${sm.reallocated === 1 ? "" : "s"}, not rising.` : null, evidence });
}

function smartCheck(d: DiskView): CheckSpec {
  return {
    id: `storage.smart:${d.id}`,
    group: "storage",
    label: `Health of ${d.name}`,
    run: async (ctx) => {
      const s = await inventory(ctx);
      const disk = s.view.disks.find((x) => x.id === d.id);
      if (!disk) return skip(`${d.name} is no longer connected`);
      return smartOutcome(disk);
    },
  };
}

export function fstabOutcome(s: InventoryState): Outcome {
  const missing = notPersistent(s);
  const findings = ["storage.not-persistent"];
  if (!missing.length) return ok("Every mounted drive comes back after a restart", { evidence: kv(s.volumes.filter((r) => r.vol.primaryMount).map((r) => [r.vol.primaryMount!, r.vol.persistence?.state ?? "system"])) });
  const targets = missing.map((r) => r.vol.primaryMount!);
  const apps = [...new Set(missing.flatMap((r) => r.vol.usedBy.map((u) => u.app)))];
  return warn(targets.length === 1 ? `${targets[0]} won't come back after a restart` : `${targets.length} drives won't come back after a restart`, {
    detail: `${listJoin(targets)} ${targets.length === 1 ? "was" : "were"} mounted by hand and ${targets.length === 1 ? "isn't" : "aren't"} in /etc/fstab.${apps.length ? ` ${listJoin(apps)} would find ${apps.length === 1 ? "its" : "their"} folders empty.` : ""}`,
    evidence: kv(missing.map((r) => [r.vol.primaryMount!, `${r.vol.path} (${r.disk.title}) · ${r.vol.persistence?.state ?? "not in fstab"}`])),
    findings,
    fix: go("Open Storage", "/storage?tab=fstab"),
  });
}

export function readOnlyOutcome(s: InventoryState): Outcome {
  const ro = s.volumes.filter((r) => r.vol.primaryMount && r.vol.mountedReadOnly && !r.vol.deviceReadOnly && !["iso9660", "squashfs", "udf", "erofs"].includes(r.vol.fstype ?? "") && !s.fstab.lines.some((l) => l.entry?.file === r.vol.primaryMount && l.entry.mntops.includes("ro")));
  if (!ro.length) return ok("No drive has switched to read-only");
  const m = ro[0]!.vol.primaryMount!;
  return fail(`${m} has switched to read-only`, { detail: "Linux does this when it finds errors on a drive. Apps can't save anything there until the drive is checked. The kernel log usually says why.", evidence: kv(ro.map((r) => [r.vol.primaryMount!, r.vol.path])), findings: ro.map((r) => `storage.readonly:${r.vol.primaryMount}`), fix: go("Read the kernel log", "/diagnostics?tab=logs&source=kernel") });
}

export async function storageChecks(): Promise<CheckSpec[]> {
  const specs: CheckSpec[] = realFilesystems().map((f) => spaceCheck(f.mount));
  specs.push({ id: "storage.inodes", group: "storage", label: "Room for new files", run: async () => inodeOutcome(realFilesystems()) });
  let disks: DiskView[] = [];
  try {
    disks = (await getInventoryState()).view.disks.filter((d) => d.mediaPresent);
  } catch {
    /* inventory unavailable: SMART rows are left out */
  }
  for (const d of disks) specs.push(smartCheck(d));
  specs.push({ id: "storage.fstab", group: "storage", label: "Mounts survive a restart", run: async (ctx) => fstabOutcome(await inventory(ctx)) });
  specs.push({ id: "storage.readonly", group: "storage", label: "Drives are writable", run: async (ctx) => readOnlyOutcome(await inventory(ctx)) });
  return specs;
}
