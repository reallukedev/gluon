import type { LineState } from "@/lib/types";
import type { DiskView, SmartAttribute, SmartSummary, StorageJob, VolumeView } from "@/lib/storage-types";

/** Every volume on a disk, including LVM/crypt children. */
export function allVolumes(d: DiskView): VolumeView[] {
  const top = [...d.partitions, ...(d.wholeDisk ? [d.wholeDisk] : [])];
  const walk = (v: VolumeView): VolumeView[] => [v, ...v.children.flatMap(walk)];
  return top.flatMap(walk);
}

/** Mounted filesystems that won't come back after a restart (mirrors the server's check). */
export function notPermanent(v: VolumeView, d: DiskView): boolean {
  return (
    v.role === "filesystem" &&
    !!v.primaryMount &&
    !!v.persistence &&
    v.persistence.state !== "persistent" &&
    !d.removable &&
    !/^\/(run\/)?media(\/|$)/.test(v.primaryMount)
  );
}

export function volumeLine(v: VolumeView, d: DiskView): LineState {
  if (d.smart?.state === "failing") return "unhealthy";
  if (v.mountedReadOnly && !v.deviceReadOnly) return "unhealthy";
  if (notPermanent(v, d)) return "attention";
  if (v.primaryMount || v.swapActive || v.children.some((c) => c.primaryMount || c.swapActive)) return d.smart?.state === "asleep" ? "paused" : "running";
  return "stopped";
}

export function diskLine(d: DiskView): LineState {
  if (d.smart?.state === "failing") return "unhealthy";
  if (allVolumes(d).some((v) => (v.mountedReadOnly && !v.deviceReadOnly) || notPermanent(v, d))) return "attention";
  if (d.smart?.state === "warning") return "attention";
  if (d.state === "unused" || d.state === "empty" || d.state === "no-media") return "stopped";
  if (d.smart?.state === "asleep") return "paused";
  return "running";
}

export const MEDIA_SHORT: Record<DiskView["media"], string> = { hdd: "HDD", ssd: "SSD", nvme: "NVMe", flash: "USB stick", card: "Card reader", unknown: "Disk" };

export function transportLabel(d: DiskView): string {
  const t = d.transport?.toLowerCase();
  if (t === "usb") return "USB";
  if (t === "nvme") return "NVMe";
  if (t === "sata" || t === "ata") return "SATA";
  if (t === "sas") return "SAS";
  return t ? t.toUpperCase() : "";
}

/** One short phrase for a disk's health. */
export function smartPhrase(s: SmartSummary | null): string {
  if (!s) return "Health not checked yet";
  switch (s.state) {
    case "ok":
      return "Healthy";
    case "warning":
      return "Showing wear";
    case "failing":
      return "Failing";
    case "asleep":
      return "Asleep";
    case "unavailable":
      return "No health data";
    default:
      return "Health unknown";
  }
}

export function smartLine(s: SmartSummary | null): LineState {
  if (!s) return "unknown";
  if (s.state === "failing") return "unhealthy";
  if (s.state === "warning") return "attention";
  if (s.state === "asleep") return "paused";
  if (s.state === "ok") return "running";
  return "unknown";
}

export function jobLine(j: StorageJob): LineState {
  if (j.status === "running") return "starting";
  if (j.status === "done") return "running";
  if (j.status === "rolled-back" || j.status === "cancelled") return "stopped";
  if (j.status === "interrupted") return "attention";
  return "unhealthy";
}

export const JOB_STATUS: Record<StorageJob["status"], string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  "rolled-back": "Put back",
  interrupted: "Interrupted",
  cancelled: "Stopped",
};

// ---------------------------------------------------------------- SMART attributes in plain words

const NAMES: Record<number, string> = {
  1: "Read errors (rate)",
  2: "Throughput",
  3: "Time to spin up",
  4: "Times started",
  5: "Bad sectors replaced",
  7: "Seek errors (rate)",
  8: "Seek speed",
  9: "Hours powered on",
  10: "Spin-up retries",
  11: "Calibration retries",
  12: "Times powered on",
  100: "Total erase count",
  160: "Uncorrectable sectors",
  168: "Min erase count",
  169: "Max erase count",
  170: "Spare blocks",
  171: "Program failures",
  172: "Erase failures",
  173: "Wear levelling",
  174: "Unexpected power losses",
  175: "Program failures",
  176: "Erase failures",
  177: "Wear levelling",
  178: "Spare blocks used",
  179: "Spare blocks used",
  180: "Spare blocks left",
  181: "Program failures",
  182: "Erase failures",
  183: "Link slow-downs",
  184: "End-to-end errors",
  187: "Errors it couldn't fix",
  188: "Command timeouts",
  189: "High-fly writes",
  190: "Airflow temperature",
  191: "Shock events",
  192: "Emergency head parks",
  193: "Head load cycles",
  194: "Temperature",
  195: "Errors corrected",
  196: "Remapping events",
  197: "Sectors waiting to be remapped",
  198: "Sectors it couldn't read",
  199: "Cable/connection errors",
  200: "Write errors",
  202: "Life used",
  204: "Soft errors corrected",
  212: "Interface errors",
  231: "Life left",
  232: "Spare space left",
  233: "Media wear",
  240: "Head flying hours",
  241: "Total written",
  242: "Total read",
};

export function attributeName(a: SmartAttribute): string {
  return NAMES[a.id] ?? a.name.replace(/_/g, " ");
}

export type Verdict = { tone: "ok" | "attention" | "fault" | "info"; text: string };

const COUNTERS_THAT_MATTER = new Set([5, 10, 184, 187, 196, 197, 198]);
const INFO_ONLY = new Set([4, 9, 12, 190, 192, 193, 194, 240, 241, 242, 100, 168, 169, 174]);

function rawNumber(raw: string): number {
  const n = Number(raw.trim().split(/[\s(]/)[0]);
  return Number.isFinite(n) ? n : 0;
}

/** Plain verdict for one attribute. `known` = smartctl knows this drive's attribute meanings. */
export function attributeVerdict(a: SmartAttribute, known: boolean, hdd: boolean): Verdict {
  const temp = a.id === 190 || a.id === 194;
  if (a.whenFailed === "now") return { tone: a.prefailure ? "fault" : "attention", text: temp ? "Hotter than the maker allows" : "Below the maker's safe limit now" };
  if (temp && a.whenFailed === "past") return { tone: "info", text: "Has been too hot before" };
  if (a.whenFailed === "past") return { tone: "attention", text: "Dropped below the safe limit before" };
  const raw = rawNumber(a.raw);
  if (COUNTERS_THAT_MATTER.has(a.id) && raw > 0) {
    if (!known && !hdd && (a.id === 197 || a.id === 198)) return { tone: "info", text: "Vendor-specific on this SSD" };
    if (a.id === 5) return { tone: "attention", text: `${raw.toLocaleString()} so far; watch if it grows` };
    return { tone: "attention", text: `${raw.toLocaleString()} so far` };
  }
  if (a.id === 199 && raw > 0) return { tone: "info", text: "Some; check the cable if it grows" };
  if (INFO_ONLY.has(a.id)) return { tone: "info", text: "For information" };
  // Many attributes start at 100 with a limit just below (Seagate's 97/99): only worry once the score has dropped.
  if (a.value !== null && a.thresh !== null && a.thresh > 0 && a.value < 100 && a.value - a.thresh <= 5) return { tone: "attention", text: "Close to the safe limit" };
  return { tone: "ok", text: "Fine" };
}

export function filesHref(p: string) {
  return `/files?path=${encodeURIComponent(p)}`;
}
