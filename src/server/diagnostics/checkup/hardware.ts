import "server-only";
import { latestHost, sensors } from "../../metrics/sampler";
import { memInfo, loadAvg, cpuCount, temperatures, cpuTemperature } from "../../host/proc";
import { getSetting } from "../../settings";
import { formatBytes } from "@/lib/format";
import type { DiskView } from "@/lib/storage-types";
import { pressure } from "./probes";
import { inventory } from "./storage";
import { fail, go, kv, ok, skip, warn, type CheckSpec, type Outcome } from "./core";

/** Hardware: temperatures, memory pressure, swap, and load against the number of cores. */

export function cpuTempOutcome(): Outcome {
  const list = sensors().length ? sensors() : temperatures();
  const t = latestHost()?.temp ?? cpuTemperature(list);
  const limit = getSetting("thresholds").tempAttention;
  const evidence = kv(list.slice(0, 12).map((s) => [s.label.startsWith(s.chip) ? s.label : `${s.chip} ${s.label}`, `${s.celsius.toFixed(1)} °C${s.high ? ` (high ${s.high} °C)` : ""}`]));
  if (t === null) return skip("This machine doesn't report a processor temperature", { evidence: evidence || null });
  const v = `${Math.round(t)} °C`;
  const fix = go("See what's busy", "/diagnostics?tab=processes");
  if (t >= limit + 10) return fail(`The processor is very hot (${v})`, { value: v, detail: "It will slow itself down to cool off. Check the fans and vents, and what's keeping it busy.", evidence, findings: ["host.temperature"], fix });
  if (t >= limit) return warn(`The processor is running hot (${v})`, { value: v, detail: `Gluon warns at ${limit} °C. Check the fans and vents; heavy work like transcoding also raises it.`, evidence, findings: ["host.temperature"], fix });
  return ok(`The processor is at ${v}`, { value: v, evidence });
}

function diskLimit(d: DiskView): number {
  const lim = d.smart?.tempLimit ?? null;
  if (d.media === "hdd") return lim ? Math.min(lim, 55) : 55;
  if (d.media === "nvme") return lim ? lim - 5 : 75;
  return lim ? lim - 5 : 70;
}

export function diskTempOutcome(disks: DiskView[]): Outcome {
  const rows = disks.filter((d) => d.smart?.temperature !== null && d.smart?.temperature !== undefined);
  if (!rows.length) return skip("No drive reports its temperature");
  const evidence = kv(rows.map((d) => [`${d.name} ${d.title}`, `${d.smart!.temperature} °C (warns at ${diskLimit(d)} °C)${d.smart!.state === "asleep" ? ", asleep" : ""}`]));
  const hot = rows.filter((d) => d.smart!.state !== "asleep" && d.smart!.temperature! >= diskLimit(d)).sort((a, b) => b.smart!.temperature! - a.smart!.temperature!);
  const hottest = [...rows].sort((a, b) => b.smart!.temperature! - a.smart!.temperature!)[0]!;
  if (hot.length) {
    const d = hot[0]!;
    const over = d.smart!.temperature! >= diskLimit(d) + 5;
    return (over ? fail : warn)(`The ${d.title} (${d.name}) is running hot (${d.smart!.temperature} °C)`, {
      value: `${d.smart!.temperature} °C`,
      detail: `Above ${diskLimit(d)} °C shortens a drive's life. Check the airflow around it${d.media === "hdd" ? ", and that it isn't packed against another hot drive" : ""}.`,
      evidence,
      findings: [`storage.temp:${d.id}`],
      fix: go("See drive health", `/storage/${encodeURIComponent(d.id)}`),
    });
  }
  return ok(`Drives are cool enough (hottest ${hottest.smart!.temperature} °C, ${hottest.name})`, { value: `${hottest.smart!.temperature} °C`, evidence });
}

export function memoryOutcome(): Outcome {
  const m = memInfo();
  const pct = m.total ? (m.used / m.total) * 100 : 0;
  const psi = pressure("memory");
  const limit = getSetting("thresholds").memoryAttention;
  const evidence = kv([
    ["Total", formatBytes(m.total)],
    ["Available", formatBytes(m.available)],
    ["In use", `${formatBytes(m.used)} (${pct.toFixed(1)}%)`],
    ["Waiting on memory", psi ? `${psi.some60.toFixed(1)}% of the last minute (full stall ${psi.full60?.toFixed(1) ?? "?"}%)` : "not reported"],
  ]);
  const value = `${Math.round(pct)}%`;
  const fix = go("See memory by app", "/apps?sort=memory");
  if (pct >= 97 || (psi && psi.full60 !== null && psi.full60 >= 10)) return fail(`Memory is nearly exhausted (${value} used)`, { value, detail: `Only ${formatBytes(m.available)} left, and programs are stalling while the system frees memory. Apps may be killed.`, evidence, findings: ["host.memory"], fix });
  if (pct >= limit || (psi && psi.some60 >= 10)) return warn(psi && psi.some60 >= 10 && pct < limit ? "Programs are waiting on memory" : `Memory is ${value} used`, { value, detail: `${formatBytes(m.available)} available. The Apps page shows which ones use the most.`, evidence, findings: ["host.memory"], fix });
  return ok(`Memory is fine (${formatBytes(m.available)} available of ${formatBytes(m.total)})`, { value, evidence });
}

export function swapOutcome(): Outcome {
  const m = memInfo();
  if (!m.swapTotal) return ok("No swap is set up; with this much memory that's fine", { evidence: kv([["Swap", "none"], ["Memory", formatBytes(m.total)]]) });
  const pct = (m.swapUsed / m.swapTotal) * 100;
  const evidence = kv([
    ["Swap", formatBytes(m.swapTotal)],
    ["In use", `${formatBytes(m.swapUsed)} (${pct.toFixed(1)}%)`],
  ]);
  if (pct >= 80) return warn(`Swap is ${Math.round(pct)}% used`, { value: `${Math.round(pct)}%`, detail: "Memory has overflowed onto the disk, which slows things down. Something may be using far more memory than it should.", evidence, fix: go("See memory by app", "/apps?sort=memory") });
  return ok(m.swapUsed > 0 ? `Swap is lightly used (${formatBytes(m.swapUsed)})` : "Swap isn't being used", { value: `${Math.round(pct)}%`, evidence });
}

export function loadOutcome(): Outcome {
  const [l1, l5, l15] = loadAvg();
  const cores = cpuCount();
  const cpu = pressure("cpu");
  const io = pressure("io");
  const evidence = kv([
    ["Load (1, 5, 15 min)", `${l1.toFixed(2)}, ${l5.toFixed(2)}, ${l15.toFixed(2)}`],
    ["Threads", cores],
    ["Waiting for CPU", cpu ? `${cpu.some60.toFixed(1)}% of the last minute` : "not reported"],
    ["Waiting for disks", io ? `${io.some60.toFixed(1)}% of the last minute` : "not reported"],
  ]);
  const ratio = l5 / cores;
  const value = `${l5.toFixed(1)} / ${cores}`;
  const fix = go("See what's busy", "/diagnostics?tab=processes");
  if (ratio >= 2) return fail(`The server is overloaded (load ${l5.toFixed(1)} on ${cores} threads)`, { value, detail: "Twice as much work is queued as it can run at once, so everything is slow.", evidence, fix });
  if (ratio >= 1 || (cpu && cpu.some60 >= 25)) return warn(`The server is very busy (load ${l5.toFixed(1)} on ${cores} threads)`, { value, detail: "Work is queuing for the processor.", evidence, fix });
  if (io && io.some60 >= 20) return warn(`Programs are often waiting for the disks (${io.some60.toFixed(0)}% of the time)`, { value, detail: "A drive is busy or slow. Large copies, scans or a failing disk can cause this.", evidence, fix });
  return ok(`The processor has room to spare (load ${l5.toFixed(1)} on ${cores} threads)`, { value, evidence });
}

export function hardwareChecks(): CheckSpec[] {
  const g = "hardware";
  return [
    { id: "hardware.cpu-temp", group: g, label: "Processor temperature", run: async () => cpuTempOutcome() },
    { id: "hardware.disk-temp", group: g, label: "Drive temperatures", run: async (ctx) => diskTempOutcome((await inventory(ctx)).view.disks) },
    { id: "hardware.memory", group: g, label: "Memory", run: async () => memoryOutcome() },
    { id: "hardware.swap", group: g, label: "Swap", run: async () => swapOutcome() },
    { id: "hardware.load", group: g, label: "Load", run: async () => loadOutcome() },
  ];
}
