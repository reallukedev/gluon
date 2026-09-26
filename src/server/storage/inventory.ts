import "server-only";
import fs from "node:fs";
import path from "node:path";
import { host, local } from "../host/exec";
import { hostPath, isWithin } from "../host/paths";
import { filesystems } from "../metrics/sampler";
import { formatBytes, listJoin } from "@/lib/format";
import { readMountinfo, readSwaps, isSystemTarget, type MountEntry } from "./mounts";
import { readFstab, matchesVolume, sourceRef, isBindEntry, isSwapEntry, readMountUnits, resolveDevLink, listBackups, type ParsedFstab, type FstabEntry, type VolumeIdentity } from "./fstab";
import { smartFor, smartCheckedAt, type SmartTarget } from "./smart";
import { listContainerRefs, type ContainerRef } from "./compose";
import { listApps } from "../docker/apps";
import type { DiskMedia, DiskView, FstabEntryView, Inventory, MountView, Persistence, VolumeRole, VolumeUser, VolumeView } from "@/lib/storage-types";

/**
 * Disks → partitions → filesystems → mount points, joined with /etc/fstab, swap, SMART and Docker.
 * Nothing here touches the disks themselves (no blkid probing), so building it never wakes a sleeping drive.
 */

interface LsblkNode {
  name: string;
  kname?: string;
  path?: string;
  "maj:min"?: string;
  type: string;
  size?: number | null;
  model?: string | null;
  serial?: string | null;
  vendor?: string | null;
  wwn?: string | null;
  rota?: boolean | string | null;
  tran?: string | null;
  rm?: boolean | string | null;
  hotplug?: boolean | string | null;
  ro?: boolean | string | null;
  fstype?: string | null;
  fsver?: string | null;
  label?: string | null;
  uuid?: string | null;
  partuuid?: string | null;
  partlabel?: string | null;
  parttypename?: string | null;
  partn?: number | string | null;
  pttype?: string | null;
  pkname?: string | null;
  state?: string | null;
  children?: LsblkNode[];
}

const COLS_FULL = "NAME,KNAME,PATH,MAJ:MIN,TYPE,SIZE,MODEL,SERIAL,VENDOR,WWN,ROTA,TRAN,RM,HOTPLUG,RO,FSTYPE,FSVER,LABEL,UUID,PARTUUID,PARTLABEL,PARTTYPENAME,PARTN,PTTYPE,PKNAME,STATE";
const COLS_BASIC = "NAME,KNAME,PATH,MAJ:MIN,TYPE,SIZE,MODEL,SERIAL,VENDOR,WWN,ROTA,TRAN,RM,HOTPLUG,RO,FSTYPE,LABEL,UUID,PARTUUID,PARTLABEL,PKNAME,PTTYPE";

const bool = (v: unknown) => v === true || v === "1" || v === 1;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

async function lsblk(warnings: string[]): Promise<LsblkNode[]> {
  const attempts: [typeof host, string][] = [
    [host, COLS_FULL],
    [host, COLS_BASIC],
    [local, COLS_BASIC],
  ];
  for (const [runner, cols] of attempts) {
    try {
      const { stdout } = await runner("lsblk", ["-J", "-b", "-o", cols], { timeoutMs: 15_000 });
      const j = JSON.parse(stdout) as { blockdevices?: LsblkNode[] };
      if (runner === local) warnings.push("Disk details came from inside the container, so some names and serial numbers may be missing.");
      return j.blockdevices ?? [];
    } catch {
      /* try the next way */
    }
  }
  warnings.push("Gluon couldn't list the disks (lsblk failed).");
  return [];
}

function byIdLinks(): Map<string, string> {
  const out = new Map<string, string>();
  const dir = "/dev/disk/by-id";
  let names: string[] = [];
  try {
    names = fs.readdirSync(hostPath(dir));
  } catch {
    return out;
  }
  const rank = (n: string) => (/^(ata|nvme|usb|scsi|mmc)-/.test(n) ? 0 : /^wwn-/.test(n) ? 2 : 1);
  for (const n of names.sort((a, b) => rank(a) - rank(b))) {
    if (/-part\d+$/.test(n) || /^nvme-eui\./.test(n)) continue;
    const target = resolveDevLink(`${dir}/${n}`);
    if (target && !out.has(target)) out.set(target, `${dir}/${n}`);
  }
  return out;
}

function mediaOf(n: LsblkNode): DiskMedia {
  const tran = str(n.tran);
  const model = (str(n.model) ?? "").toLowerCase();
  if (tran === "nvme" || n.name.startsWith("nvme")) return "nvme";
  if (n.name.startsWith("mmcblk") || /card reader|sd\/mmc|cardreader/.test(model)) return "card";
  if (bool(n.rota)) return "hdd";
  if (tran === "usb" && bool(n.rm)) return "flash";
  if (tran === "usb" || tran === "sata" || tran === "sas" || tran === "ata") return "ssd";
  return "unknown";
}

const MEDIA_WORD: Record<DiskMedia, string> = { hdd: "hard drive", ssd: "SSD", nvme: "NVMe SSD", flash: "USB drive", card: "card reader", unknown: "disk" };

function roleOf(n: LsblkNode): VolumeRole {
  const fs = str(n.fstype);
  if (fs === "swap") return "swap";
  if (fs === "LVM2_member") return "lvm-member";
  if (fs === "linux_raid_member") return "raid-member";
  if (fs === "crypto_LUKS") return "encrypted";
  if (/BIOS boot/i.test(n.parttypename ?? "")) return "bios-boot";
  if (fs && /_member$/.test(fs)) return "other";
  if (fs) return "filesystem";
  if ((n.size ?? 0) > 0 && n.type === "part") return "unformatted";
  return "other";
}

function kindOf(t: string): VolumeView["kind"] {
  if (t === "disk" || t === "part" || t === "lvm" || t === "crypt" || t === "loop") return t;
  if (t.startsWith("raid")) return "raid";
  return "other";
}

function stableId(n: LsblkNode): string {
  const s = str(n.serial)?.replace(/[^A-Za-z0-9._-]/g, "");
  if (s) return s;
  const w = str(n.wwn)?.replace(/[^A-Za-z0-9._-]/g, "");
  if (w) return w;
  return n.name;
}

function identity(n: LsblkNode): VolumeIdentity {
  const p = str(n.path) ?? `/dev/${n.name}`;
  const aliases = [`/dev/${n.name}`, `/dev/${n.kname ?? n.name}`].filter((a) => a !== p);
  return { path: p, aliases, uuid: str(n.uuid), label: str(n.label), partUuid: str(n.partuuid), partLabel: str(n.partlabel) };
}

export interface VolumeRecord {
  vol: VolumeView;
  disk: DiskView;
  node: LsblkNode;
  ident: VolumeIdentity;
}

export interface InventoryState {
  view: Inventory;
  volumes: VolumeRecord[];
  mounts: MountEntry[];
  fstabText: string;
  fstab: ParsedFstab;
  containers: ContainerRef[];
  /** Mount targets of every filesystem on a system disk. */
  systemMounts: Set<string>;
  smartTargets: SmartTarget[];
}

function mountViews(majMin: string, devPaths: string[], mounts: MountEntry[]): MountView[] {
  // maj:min is exact (and survives /dev/mapper aliases); the device path is the fallback when lsblk can't report it.
  const mine = mounts.filter((m) => m.source.startsWith("/dev/") && (majMin ? m.majMin === majMin : devPaths.includes(m.source.replace(/\[.*\]$/, ""))));
  let primaryFound = false;
  return mine
    .sort((a, b) => a.id - b.id)
    .map((m) => {
      const bind = m.fsroot !== "/" || primaryFound;
      if (!bind) primaryFound = true;
      return { target: m.target, fsroot: m.fsroot, bind, options: m.options, readOnly: m.options.includes("ro") };
    });
}

function persistenceOf(target: string, ident: VolumeIdentity, parsed: ParsedFstab, units: ReturnType<typeof readMountUnits>): Persistence {
  const none: Persistence = { state: "missing", via: null, line: null, entry: null, matchedBy: null, fragile: false, fstabTarget: null };
  let elsewhere: Persistence | null = null;
  let conflictAt: Persistence | null = null;
  for (const l of parsed.lines) {
    const e = l.entry;
    if (!e || isBindEntry(e) || isSwapEntry(e)) continue;
    const how = matchesVolume(e, ident);
    if (how && e.file === target) {
      return { state: "persistent", via: "fstab", line: l.index + 1, entry: l.raw, matchedBy: how, fragile: how === "device" && !ident.path.startsWith("/dev/mapper/"), fstabTarget: e.file };
    }
    if (how && !elsewhere) elsewhere = { state: "different-target", via: "fstab", line: l.index + 1, entry: l.raw, matchedBy: how, fragile: false, fstabTarget: e.file };
    if (!how && e.file === target && !conflictAt) conflictAt = { state: "conflict", via: "fstab", line: l.index + 1, entry: l.raw, matchedBy: null, fragile: false, fstabTarget: e.file };
  }
  for (const u of units) {
    if (u.where !== target) continue;
    const fake: FstabEntry = { spec: u.what, file: u.where, vfstype: "auto", mntops: [], freq: 0, passno: 0 };
    const how = matchesVolume(fake, ident);
    if (how) return { state: "persistent", via: "systemd", line: null, entry: u.file, matchedBy: how, fragile: how === "device", fstabTarget: u.where };
  }
  return elsewhere ?? conflictAt ?? none;
}

function usageFor(target: string) {
  const f = filesystems().find((x) => x.mount === target);
  if (f) return { size: f.size, used: f.used, avail: f.avail, pct: f.pct };
  try {
    const s = fs.statfsSync(hostPath(target));
    const size = s.blocks * s.bsize;
    const avail = s.bavail * s.bsize;
    const used = size - s.bfree * s.bsize;
    return { size, used, avail, pct: used + avail > 0 ? (used / (used + avail)) * 100 : 0 };
  } catch {
    return null;
  }
}

function appName(c: ContainerRef, names: Map<string, string>): { appId: string; app: string } {
  const appId = c.project ?? c.name;
  return { appId, app: names.get(appId) ?? appId };
}

async function build(): Promise<InventoryState> {
  const warnings: string[] = [];
  const [nodes, containers, apps] = await Promise.all([
    lsblk(warnings),
    listContainerRefs().catch(() => {
      warnings.push("Gluon couldn't ask Docker which apps use each drive.");
      return [] as ContainerRef[];
    }),
    listApps().catch(() => []),
  ]);
  const appNames = new Map(apps.map((a) => [a.id, a.name]));
  const mounts = readMountinfo();
  const swaps = new Set(readSwaps());
  const { text: fstabText, parsed } = readFstab();
  const units = readMountUnits();
  const links = byIdLinks();

  // Bind sources → mount (longest prefix) so we can say which apps use which drive.
  const blockMounts = mounts.filter((m) => m.source.startsWith("/dev/"));
  const bindsByMajMin = new Map<string, VolumeUser[]>();
  for (const c of containers) {
    const { appId, app } = appName(c, appNames);
    for (const b of c.binds) {
      if (b.type !== "bind" || !b.source.startsWith("/")) continue;
      let best: MountEntry | null = null;
      for (const m of blockMounts) if (isWithin(b.source, m.target) && (!best || m.target.length > best.target.length)) best = m;
      if (!best || best.target === "/") continue;
      const user = { appId, app, container: c.name, running: c.running, source: b.source, destination: b.destination };
      for (const key of [best.majMin, best.source.replace(/\[.*\]$/, "")]) {
        const arr = bindsByMajMin.get(key) ?? [];
        arr.push(user);
        bindsByMajMin.set(key, arr);
      }
    }
  }

  const volumes: VolumeRecord[] = [];
  const disks: DiskView[] = [];
  const smartTargets: SmartTarget[] = [];
  const seenIds = new Set<string>();

  const makeVolume = (n: LsblkNode): VolumeView => {
    const ident = identity(n);
    const majMin = n["maj:min"] ?? "";
    const mv = mountViews(majMin, [ident.path, ...(ident.aliases ?? [])], mounts);
    const primary = mv.find((m) => !m.bind)?.target ?? null;
    const swapActive = swaps.has(ident.path) || swaps.has(`/dev/${n.kname ?? n.name}`);
    const role = roleOf(n);
    const fstabLines: number[] = [];
    for (const l of parsed.lines) if (l.entry && !isBindEntry(l.entry) && matchesVolume(l.entry, ident)) fstabLines.push(l.index + 1);
    const system = mv.some((m) => isSystemTarget(m.target)) || swapActive;
    const view: VolumeView = {
      name: n.name,
      path: ident.path,
      majMin,
      kind: kindOf(n.type),
      size: Number(n.size ?? 0),
      partNumber: n.partn !== undefined && n.partn !== null ? Number(n.partn) : null,
      partLabel: str(n.partlabel),
      partType: str(n.parttypename),
      fstype: str(n.fstype),
      fsVersion: str(n.fsver),
      label: str(n.label),
      uuid: str(n.uuid),
      partUuid: str(n.partuuid),
      role,
      mounts: mv,
      primaryMount: primary,
      swapActive,
      usage: primary ? usageFor(primary) : null,
      persistence: primary && role === "filesystem" ? persistenceOf(primary, ident, parsed, units) : null,
      fstabLines,
      deviceReadOnly: bool(n.ro),
      mountedReadOnly: !!primary && !!mv.find((m) => m.target === primary)?.readOnly,
      system,
      usedBy: (majMin && bindsByMajMin.get(majMin)) || bindsByMajMin.get(ident.path) || [],
      children: (n.children ?? []).filter((c) => c.type !== "part").map(makeVolume),
    };
    return view;
  };

  const anySystem = (v: VolumeView): VolumeView | null => (v.system ? v : v.children.map(anySystem).find(Boolean) ?? null);
  const anyActive = (v: VolumeView): boolean => v.mounts.length > 0 || v.swapActive || v.children.some((c) => c.mounts.length > 0 || c.swapActive || anyActive(c)) || v.children.length > 0;

  for (const n of nodes) {
    if (n.type !== "disk") continue;
    if (/^(loop|zram|ram|sr|fd)\d*/.test(n.name)) continue;
    const size = Number(n.size ?? 0);
    let id = stableId(n);
    if (seenIds.has(id)) id = `${id}-${n.name}`;
    seenIds.add(id);
    const media = mediaOf(n);
    const parts = (n.children ?? []).filter((c) => c.type === "part");
    const partitions = parts.map(makeVolume);
    // A filesystem (or LVM/RAID member) written directly on the disk.
    const whole = str(n.fstype) || (n.children ?? []).some((c) => c.type !== "part") ? makeVolume({ ...n, children: (n.children ?? []).filter((c) => c.type !== "part") }) : null;
    const all = [...partitions, ...(whole ? [whole] : [])];
    const sys = all.map(anySystem).find(Boolean) ?? null;
    const flat: VolumeView[] = [];
    const walk = (v: VolumeView) => {
      flat.push(v);
      v.children.forEach(walk);
    };
    all.forEach(walk);

    const mediaPresent = size > 0;
    const inUse = all.some(anyActive);
    const state: DiskView["state"] = !mediaPresent ? "no-media" : sys ? "system" : inUse ? "in-use" : all.length === 0 && !str(n.pttype) ? "empty" : "unused";
    const mountTargets = [...new Set(flat.flatMap((v) => v.mounts.filter((m) => !m.bind).map((m) => m.target)))];
    const usageVols = flat.filter((v) => v.usage && v.primaryMount);
    const usage = usageVols.length ? usageVols.reduce((a, v) => ({ size: a.size + v.usage!.size, used: a.used + v.usage!.used, avail: a.avail + v.usage!.avail }), { size: 0, used: 0, avail: 0 }) : null;

    let systemReason: string | null = null;
    if (sys) {
      const t = sys.mounts.find((m) => isSystemTarget(m.target))?.target;
      systemReason = t === "/" ? `Linux runs from this disk (/ is on ${sys.name}).` : t ? `${t} is on this disk (${sys.name}), so the system needs it.` : `The server's swap space is on this disk (${sys.name}).`;
    }
    const word = MEDIA_WORD[media];
    const title = mediaPresent ? `${formatBytes(size)} ${word}` : `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    let summary: string;
    if (!mediaPresent) summary = "Nothing inserted.";
    else if (state === "system") summary = `Holds the system: ${listJoin(mountTargets.slice(0, 4)) || "swap"}.`;
    else if (state === "in-use") {
      const pct = usage && usage.size ? Math.round((usage.used / usage.size) * 100) : null;
      summary = mountTargets.length ? `Mounted at ${listJoin(mountTargets.slice(0, 3))}${pct !== null ? ` · ${pct}% used` : ""}.` : "In use (LVM, RAID or encryption).";
    } else if (state === "empty") summary = "Blank: nothing on it yet.";
    else {
      const kinds = [...new Set(all.map((v) => (v.role === "filesystem" ? v.fstype ?? "data" : v.role === "lvm-member" ? "LVM" : v.role === "raid-member" ? "RAID" : v.role === "encrypted" ? "encrypted" : v.role === "unformatted" ? "unformatted" : null)).filter(Boolean))];
      summary = `Not in use${kinds.length ? ` · has ${listJoin(kinds as string[])} partition${all.length === 1 ? "" : "s"}` : ""}.`;
    }
    const partTotal = partitions.reduce((a, p) => a + p.size, 0);
    const unallocated = str(n.pttype) && size > 0 ? Math.max(0, size - partTotal - 2 * 1024 * 1024) : 0;
    const path = str(n.path) ?? `/dev/${n.name}`;

    const disk: DiskView = {
      id,
      name: n.name,
      path,
      byId: links.get(path) ?? null,
      model: str(n.model),
      vendor: str(n.vendor),
      serial: str(n.serial),
      wwn: str(n.wwn),
      size,
      media,
      rotational: bool(n.rota),
      transport: str(n.tran),
      removable: bool(n.rm),
      hotplug: bool(n.hotplug),
      mediaPresent,
      readOnly: bool(n.ro),
      partitionTable: str(n.pttype),
      system: !!sys,
      systemReason,
      state,
      title,
      summary,
      wholeDisk: whole,
      partitions,
      unallocated: unallocated > 64 * 1024 * 1024 ? unallocated : 0,
      usage,
      inFstab: flat.some((v) => v.fstabLines.length > 0),
      smart: smartFor(id),
    };
    disks.push(disk);
    smartTargets.push({ id, path, name: n.name, transport: disk.transport, removable: disk.removable, mediaPresent, media });

    const record = (v: VolumeView, node: LsblkNode) => {
      volumes.push({ vol: v, disk, node, ident: identity(node) });
      const kids = (node.children ?? []).filter((c) => c.type !== "part");
      v.children.forEach((c, i) => kids[i] && record(c, kids[i]!));
    };
    partitions.forEach((v, i) => record(v, parts[i]!));
    if (whole) record(whole, n);
  }

  // fstab view.
  const entries: FstabEntryView[] = [];
  const mountedTargets = new Set(mounts.map((m) => m.target));
  for (const l of parsed.lines) {
    const e = l.entry;
    if (!e) continue;
    const ref = sourceRef(e);
    const bind = isBindEntry(e);
    const swap = isSwapEntry(e);
    const match = bind || ref.kind === "network" || ref.kind === "none" ? null : volumes.find((r) => matchesVolume(e, r.ident));
    const present = bind ? fs.existsSync(hostPath(e.spec.startsWith("/") ? e.spec : "/")) : ref.kind === "network" || ref.kind === "none" ? null : !!match;
    const nofail = e.mntops.includes("nofail");
    const noauto = e.mntops.includes("noauto");
    const mounted = swap ? !!match?.vol.swapActive : mountedTargets.has(e.file);
    const issues: string[] = [];
    if (present === false) {
      issues.push(nofail || swap ? "The drive it refers to isn't connected." : "The drive it refers to isn't connected, and without nofail the server may stop at startup waiting for it.");
    }
    if (ref.kind === "device" && !e.spec.startsWith("/dev/mapper/")) issues.push(`It uses the name ${e.spec}, which can change when drives are added or removed. UUID= is safer.`);
    if (present && !mounted && !noauto) issues.push("It isn't mounted right now.");
    if (match && !swap && !bind && e.file !== match.vol.primaryMount && match.vol.primaryMount) issues.push(`That drive is mounted at ${match.vol.primaryMount} instead.`);
    entries.push({
      line: l.index + 1,
      text: l.raw,
      spec: e.spec,
      target: e.file,
      fstype: e.vfstype,
      options: e.mntops,
      dump: e.freq,
      pass: e.passno,
      sourceKind: ref.kind,
      bind,
      swap,
      nofail,
      present,
      device: match?.vol.path ?? null,
      mounted,
      issues,
    });
  }

  const systemMounts = new Set<string>();
  for (const r of volumes) if (r.disk.system) for (const m of r.vol.mounts) systemMounts.add(m.target);

  return {
    view: { disks, fstab: { entries, backups: listBackups() }, generatedAt: Date.now(), smartCheckedAt: smartCheckedAt(), warnings },
    volumes,
    mounts,
    fstabText,
    fstab: parsed,
    containers,
    systemMounts,
    smartTargets,
  };
}

type G = typeof globalThis & { __gluonStorageInv?: { at: number; value: Promise<InventoryState> } | null };
const g = globalThis as G;

/** Inventory, cached for 5 s (operations invalidate it). */
export function getInventoryState(fresh = false): Promise<InventoryState> {
  const c = g.__gluonStorageInv;
  if (!fresh && c && Date.now() - c.at < 5000) return c.value;
  const value = build();
  g.__gluonStorageInv = { at: Date.now(), value };
  value.catch(() => {
    g.__gluonStorageInv = null;
  });
  return value;
}

export async function getInventory(fresh = false): Promise<Inventory> {
  const s = await getInventoryState(fresh);
  // SMART may have refreshed since the inventory was cached.
  for (const d of s.view.disks) d.smart = smartFor(d.id);
  s.view.smartCheckedAt = smartCheckedAt();
  return s.view;
}

export function invalidateInventory() {
  g.__gluonStorageInv = null;
}

/** Find a disk by id, kernel name or /dev path. */
export function findDisk(s: InventoryState, key: string): DiskView | null {
  const k = key.replace(/^\/dev\//, "");
  return s.view.disks.find((d) => d.id === key || d.name === k || d.path === key || d.serial === key) ?? null;
}

/** Find a volume by kernel name, /dev path, UUID or current mount point. */
export function findVolume(s: InventoryState, key: string): VolumeRecord | null {
  const k = key.trim();
  const name = k.replace(/^\/dev\//, "");
  return (
    s.volumes.find((r) => r.vol.name === name || r.vol.path === k) ??
    s.volumes.find((r) => r.vol.uuid && (r.vol.uuid === k || `UUID=${r.vol.uuid}` === k)) ??
    s.volumes.find((r) => r.vol.mounts.some((m) => m.target === k && !m.bind)) ??
    null
  );
}

export function describeVolume(r: VolumeRecord): string {
  const bits = [r.vol.label ? `"${r.vol.label}"` : null, `${formatBytes(r.vol.size)}`, r.disk.model ?? r.disk.title].filter(Boolean);
  return `${r.vol.name} (${bits.join(", ")})`;
}

export const basename = (p: string) => path.posix.basename(p);
