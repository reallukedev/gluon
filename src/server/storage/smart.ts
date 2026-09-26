import "server-only";
import { local, CommandError } from "../host/exec";
import { all, one, run } from "../db";
import type { DiskMedia, SmartAttribute, SmartDetail, SmartSummary } from "@/lib/storage-types";

/**
 * SMART health via the container's smartctl. Read every 30 minutes and cached; `-n standby` makes
 * smartctl skip disks that are spun down so Gluon never wakes a sleeping hard drive just to look at it.
 * Samples are kept in `storage_smart` so "reallocated sectors are rising" can be detected.
 */

export interface SmartTarget {
  id: string;
  path: string;
  name: string;
  transport: string | null;
  removable: boolean;
  mediaPresent: boolean;
  media: DiskMedia;
}

interface Entry {
  summary: SmartSummary;
  attributes: SmartAttribute[];
  firmware: string | null;
}

type G = typeof globalThis & { __gluonSmart?: { byId: Map<string, Entry>; lastRun: number | null; running: Promise<void> | null } };
const g = globalThis as G;
const st = () => (g.__gluonSmart ??= { byId: new Map(), lastRun: null, running: null });

export const SMART_INTERVAL_MS = 30 * 60_000;

export function smartFor(id: string): SmartSummary | null {
  return st().byId.get(id)?.summary ?? null;
}

export function smartCheckedAt(): number | null {
  return st().lastRun;
}

export function smartDetail(id: string): SmartDetail {
  const e = st().byId.get(id);
  let history: SmartDetail["history"] = [];
  try {
    history = all<{ at: number; temp: number | null; reallocated: number | null; pending: number | null }>(
      "SELECT at, temp, reallocated, pending FROM storage_smart WHERE disk_id = ? AND at >= ? ORDER BY at",
      id,
      Date.now() - 90 * 86_400_000,
    ).map((r) => ({ at: r.at, temperature: r.temp, reallocated: r.reallocated, pending: r.pending }));
  } catch {
    /* table not there yet */
  }
  return { summary: e?.summary ?? null, attributes: e?.attributes ?? [], firmware: e?.firmware ?? null, history };
}

/** Load the most recent stored summaries so the page isn't empty right after a restart. */
export function loadSmartCache() {
  try {
    const rows = all<{ disk_id: string; summary: string }>(
      "SELECT s.disk_id, s.summary FROM storage_smart s JOIN (SELECT disk_id, MAX(at) AS at FROM storage_smart GROUP BY disk_id) m ON m.disk_id = s.disk_id AND m.at = s.at",
    );
    for (const r of rows) {
      if (st().byId.has(r.disk_id)) continue;
      try {
        st().byId.set(r.disk_id, { summary: JSON.parse(r.summary) as SmartSummary, attributes: [], firmware: null });
      } catch {
        /* skip */
      }
    }
  } catch {
    /* table not there yet */
  }
}

// ---------------------------------------------------------------- parsing

type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === "object" ? (v as J) : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function rawCount(a: J | undefined): number | null {
  if (!a) return null;
  const raw = obj(a.raw);
  const s = typeof raw.string === "string" ? raw.string.trim() : "";
  const first = Number(s.split(/[\s(]/)[0]);
  if (s && Number.isFinite(first)) return first;
  const v = num(raw.value);
  // Packed 48-bit raw values: only the low 16 bits are the count for these attributes.
  return v === null ? null : v > 0xffffffff ? v % 65536 : v;
}

function devstat(j: J, name: RegExp): number | null {
  const pages = obj(j.ata_device_statistics).pages;
  if (!Array.isArray(pages)) return null;
  for (const p of pages) {
    const table = obj(p).table;
    if (!Array.isArray(table)) continue;
    for (const r of table) {
      const row = obj(r);
      if (typeof row.name === "string" && name.test(row.name) && obj(row.flags).valid !== false) return num(row.value);
    }
  }
  return null;
}

function baseSummary(now: number): SmartSummary {
  return {
    state: "unknown",
    checkedAt: now,
    readAt: null,
    passed: null,
    temperature: null,
    tempLimit: null,
    powerOnHours: null,
    powerCycles: null,
    reallocated: null,
    pending: null,
    uncorrectable: null,
    reallocatedRising: false,
    wearPercent: null,
    nvme: null,
    lastSelfTest: null,
    known: false,
    notes: [],
    message: null,
  };
}

function messages(j: J): string[] {
  const m = obj(j.smartctl).messages;
  return Array.isArray(m) ? m.map((x) => String(obj(x).string ?? "")).filter(Boolean) : [];
}

export function parseSmart(j: J, exit: number, media: DiskMedia, now = Date.now()): { summary: SmartSummary; attributes: SmartAttribute[]; firmware: string | null } {
  const s = baseSummary(now);
  const msgs = messages(j);
  const attributes: SmartAttribute[] = [];

  if ((exit & 2) && msgs.some((m) => /STANDBY|SLEEP|IDLE/i.test(m))) {
    s.state = "asleep";
    s.message = "The drive is spun down, so Gluon didn't wake it to check.";
    return { summary: s, attributes, firmware: null };
  }
  if (exit & 1 || (exit & 2 && !j.smart_status && !j.nvme_smart_health_information_log)) {
    s.state = "unavailable";
    const m = msgs.find((x) => /unknown usb bridge/i.test(x));
    s.message = m ? "This drive's USB adapter doesn't pass health data through." : msgs[0] ? `Health data isn't available: ${msgs[0]}` : "Health data isn't available for this drive.";
    return { summary: s, attributes, firmware: null };
  }

  const smartSupport = obj(j.smart_support);
  if (smartSupport.available === false) {
    s.state = "unavailable";
    s.message = "This drive doesn't support SMART health reporting.";
    return { summary: s, attributes, firmware: typeof j.firmware_version === "string" ? j.firmware_version : null };
  }

  s.readAt = now;
  s.known = j.in_smartctl_database === true || !!j.nvme_smart_health_information_log;
  const status = obj(j.smart_status);
  s.passed = typeof status.passed === "boolean" ? status.passed : null;
  const temp = obj(j.temperature);
  s.temperature = num(temp.current);
  s.tempLimit = num(temp.op_limit_max) ?? devstat(j, /^Specified Maximum Operating Temperature$/) ?? null;
  s.powerOnHours = num(obj(j.power_on_time).hours);
  s.powerCycles = num(j.power_cycle_count);

  // ATA attributes.
  const table = obj(j.ata_smart_attributes).table;
  const byId = new Map<number, J>();
  if (Array.isArray(table)) {
    for (const r of table) {
      const a = obj(r);
      const id = num(a.id);
      if (id === null) continue;
      byId.set(id, a);
      const flags = obj(a.flags);
      attributes.push({
        id,
        name: String(a.name ?? `Attribute ${id}`),
        value: num(a.value),
        worst: num(a.worst),
        thresh: num(a.thresh),
        raw: String(obj(a.raw).string ?? obj(a.raw).value ?? ""),
        prefailure: flags.prefailure === true,
        whenFailed: String(a.when_failed ?? ""),
      });
    }
    s.reallocated = rawCount(byId.get(5));
    const trustSectorCounts = media === "hdd" || s.known;
    const pending = rawCount(byId.get(197));
    const uncorrectable = rawCount(byId.get(198));
    s.pending = pending;
    s.uncorrectable = uncorrectable;
    if (!trustSectorCounts && ((pending ?? 0) > 0 || (uncorrectable ?? 0) > 0)) {
      s.notes.push("This SSD isn't in smartctl's database, so its pending/uncorrectable counters may mean something vendor-specific.");
    }
    // Wear for SSDs: the standard device statistic first, then well-known attributes on known drives.
    s.wearPercent = devstat(j, /Percentage Used Endurance Indicator/i);
    if (s.wearPercent === null && s.known && media !== "hdd") {
      // (233 Media_Wearout_Indicator is left out: vendors disagree on what its value means.)
      for (const [id, re] of [
        [231, /SSD_Life_Left/i],
        [202, /Percent_Lifetime_Remain/i],
        [177, /Wear_Leveling_Count/i],
      ] as const) {
        const a = byId.get(id);
        if (a && re.test(String(a.name)) && num(a.value) !== null && num(a.value)! <= 100) {
          s.wearPercent = 100 - num(a.value)!;
          break;
        }
      }
    }
  }

  // NVMe health log.
  const nv = obj(j.nvme_smart_health_information_log);
  if (Object.keys(nv).length) {
    s.temperature ??= num(nv.temperature);
    s.powerOnHours ??= num(nv.power_on_hours);
    s.powerCycles ??= num(nv.power_cycles);
    s.wearPercent = num(nv.percentage_used);
    s.nvme = {
      criticalWarning: num(nv.critical_warning) ?? 0,
      availableSpare: num(nv.available_spare),
      availableSpareThreshold: num(nv.available_spare_threshold),
      mediaErrors: num(nv.media_errors),
      unsafeShutdowns: num(nv.unsafe_shutdowns),
    };
  }

  // Last self-test.
  const selfTests = obj(obj(j.ata_smart_self_test_log).standard).table;
  if (Array.isArray(selfTests) && selfTests[0]) {
    const t = obj(selfTests[0]);
    const tStatus = obj(t.status);
    s.lastSelfTest = {
      type: String(obj(t.type).string ?? "Self-test"),
      status: String(tStatus.string ?? ""),
      passed: typeof tStatus.passed === "boolean" ? tStatus.passed : null,
      lifetimeHours: num(t.lifetime_hours),
    };
  }

  // Verdict.
  const failingNow = attributes.filter((a) => a.whenFailed === "now" && a.prefailure);
  const failedPast = attributes.filter((a) => a.whenFailed === "past" && a.prefailure);
  const cw = s.nvme?.criticalWarning ?? 0;
  const failing = s.passed === false || (exit & 8) !== 0 || failingNow.length > 0 || (cw & (0x01 | 0x04 | 0x08)) !== 0;
  if (failing) {
    s.state = "failing";
    if (s.passed === false || exit & 8) s.notes.push("The drive's own health check says it is failing.");
    for (const a of failingNow) s.notes.push(`${a.name.replace(/_/g, " ")} is below the manufacturer's safe limit.`);
    if (cw & 0x01) s.notes.push("It has almost run out of spare space to replace worn-out cells.");
    if (cw & 0x04) s.notes.push("It reports its reliability is degraded.");
    if (cw & 0x08) s.notes.push("It has switched itself to read-only to protect your data.");
  } else {
    const trustSectorCounts = media === "hdd" || s.known;
    const warn: string[] = [];
    if (trustSectorCounts && (s.pending ?? 0) > 0) warn.push(`${s.pending} sector${s.pending === 1 ? " is" : "s are"} waiting to be remapped because ${s.pending === 1 ? "it" : "they"} couldn't be read.`);
    if (trustSectorCounts && (s.uncorrectable ?? 0) > 0) warn.push(`${s.uncorrectable} sector${s.uncorrectable === 1 ? "" : "s"} couldn't be read or fixed.`);
    if ((s.nvme?.mediaErrors ?? 0) > 0) warn.push(`${s.nvme!.mediaErrors} unrecoverable read/write errors have happened.`);
    if (s.wearPercent !== null && s.wearPercent >= 90) warn.push(`It has used ${Math.round(s.wearPercent)}% of its rated write endurance.`);
    for (const a of failedPast) warn.push(`${a.name.replace(/_/g, " ")} dropped below the safe limit at some point in the past.`);
    s.state = warn.length ? "warning" : "ok";
    s.notes.push(...warn);
    if ((s.reallocated ?? 0) > 0) s.notes.push(`${s.reallocated} bad sector${s.reallocated === 1 ? " has" : "s have"} been replaced with spares.`);
  }
  if (exit & 64) s.notes.push("The drive has logged errors in the past.");
  if (exit & 128) s.notes.push("A past self-test found problems.");

  return { summary: s, attributes, firmware: typeof j.firmware_version === "string" ? j.firmware_version : null };
}

// ---------------------------------------------------------------- running

async function runSmartctl(args: string[]): Promise<{ json: J | null; exit: number; stderr: string }> {
  try {
    const { stdout } = await local("smartctl", args, { timeoutMs: 60_000, maxBuffer: 8 * 1024 * 1024 });
    return { json: safeJson(stdout), exit: 0, stderr: "" };
  } catch (e) {
    if (e instanceof CommandError) {
      return { json: safeJson(e.stdout), exit: e.code ?? 255, stderr: e.stderr };
    }
    const err = e as NodeJS.ErrnoException;
    return { json: null, exit: 255, stderr: err.code === "ENOENT" ? "smartctl isn't installed in the Gluon container." : err.message };
  }
}

function safeJson(s: string): J | null {
  try {
    return JSON.parse(s) as J;
  } catch {
    return null;
  }
}

async function readOne(t: SmartTarget, now: number): Promise<Entry> {
  if (!t.mediaPresent) {
    const s = baseSummary(now);
    s.state = "unavailable";
    s.message = "Nothing is inserted.";
    return { summary: s, attributes: [], firmware: null };
  }
  if (t.removable || t.media === "card" || t.name.startsWith("mmcblk")) {
    const s = baseSummary(now);
    s.state = "unavailable";
    s.message = "Memory cards and USB sticks don't report health data.";
    return { summary: s, attributes: [], firmware: null };
  }
  const nvme = t.transport === "nvme" || t.name.startsWith("nvme");
  const extra = nvme ? [] : ["-l", "devstat", "-l", "scttemp"];
  let r = await runSmartctl(["-j", "-n", "standby", "-a", ...extra, t.path]);
  if (r.json && t.transport === "usb" && messages(r.json).some((m) => /unknown usb bridge/i.test(m))) {
    r = await runSmartctl(["-j", "-n", "standby", "-d", "sat", "-a", ...extra, t.path]);
  }
  if (!r.json) {
    const s = baseSummary(now);
    s.state = "unavailable";
    s.message = r.stderr.trim().split("\n").pop() || "smartctl didn't return anything.";
    return { summary: s, attributes: [], firmware: null };
  }
  return parseSmart(r.json, r.exit, t.media, now);
}

function rising(id: string, current: number | null): boolean {
  if (current === null) return false;
  try {
    const r = one<{ lo: number | null }>("SELECT MIN(reallocated) AS lo FROM storage_smart WHERE disk_id = ? AND at >= ? AND reallocated IS NOT NULL", id, Date.now() - 30 * 86_400_000);
    return r?.lo !== null && r?.lo !== undefined && current > r.lo;
  } catch {
    return false;
  }
}

function record(id: string, s: SmartSummary) {
  try {
    run(
      `INSERT OR REPLACE INTO storage_smart (disk_id, at, state, temp, power_on_hours, reallocated, pending, uncorrectable, wear_pct, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      s.checkedAt,
      s.state,
      s.temperature,
      s.powerOnHours,
      s.reallocated,
      s.pending,
      s.uncorrectable,
      s.wearPercent,
      JSON.stringify(s),
    );
  } catch (e) {
    console.error("[gluon] couldn't store SMART sample", (e as Error).message);
  }
}

/** Read SMART for the given disks (sequentially: some controllers dislike parallel passthrough). */
export function refreshSmart(targets: SmartTarget[]): Promise<void> {
  const state = st();
  if (state.running) return state.running;
  state.running = (async () => {
    const now = Date.now();
    for (const t of targets) {
      const prev = state.byId.get(t.id);
      let entry: Entry;
      try {
        entry = await readOne(t, now);
      } catch (e) {
        const s = baseSummary(now);
        s.state = "unavailable";
        s.message = (e as Error).message;
        entry = { summary: s, attributes: [], firmware: null };
      }
      if (entry.summary.state === "asleep" && prev) {
        // Keep the last real values; just say it's asleep now.
        const kept: SmartSummary = { ...prev.summary, state: "asleep", checkedAt: now, message: entry.summary.message };
        state.byId.set(t.id, { summary: kept, attributes: prev.attributes, firmware: prev.firmware });
        continue;
      }
      if (entry.summary.readAt) {
        entry.summary.reallocatedRising = rising(t.id, entry.summary.reallocated);
        if (entry.summary.reallocatedRising && entry.summary.state === "ok") {
          entry.summary.state = "warning";
          entry.summary.notes.unshift("The number of replaced bad sectors went up recently.");
        }
        record(t.id, entry.summary);
      }
      state.byId.set(t.id, entry);
    }
    state.lastRun = now;
  })().finally(() => {
    state.running = null;
  });
  return state.running;
}

/** Previous-state value of an asleep disk's last reading, for checks that must not flap. */
export function lastAwakeSummary(id: string): SmartSummary | null {
  const s = smartFor(id);
  return s && s.readAt ? s : null;
}

export function pruneSmart() {
  try {
    run("DELETE FROM storage_smart WHERE at < ?", Date.now() - 400 * 86_400_000);
  } catch {
    /* table not there yet */
  }
}
