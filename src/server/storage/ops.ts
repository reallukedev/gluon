import "server-only";
import { host, CommandError } from "../host/exec";
import { AppError, notFound } from "../errors";
import { audit } from "../audit";
import { publish } from "../events";
import { sampleFilesystems } from "../metrics/sampler";
import { formatBytes, listJoin } from "@/lib/format";
import type { User } from "../auth/users";
import { getInventoryState, invalidateInventory, findVolume, type InventoryState, type VolumeRecord } from "./inventory";
import { validateMountTarget, hostMkdirs, hostRemoveEmptyDirs, readMountinfo, mountAt, isSystemTarget } from "./mounts";
import { applyChanges, writeFstab, formatEntry, gluonComment, isBindEntry, isSwapEntry, matchesVolume, type FstabChange, type FstabEntry } from "./fstab";
import { findHolders } from "./holders";
import { withLock } from "./oplog";
import type { MountPlan, PersistPlan, UnmountPlan } from "@/lib/storage-types";

export interface Where {
  ip?: string;
  zone?: string;
}

/** Filesystems Gluon knows how to mount. */
const MOUNTABLE = new Set(["ext4", "ext3", "ext2", "xfs", "btrfs", "vfat", "exfat", "ntfs", "ntfs3", "f2fs"]);
const NON_POSIX = new Set(["vfat", "exfat", "ntfs", "ntfs3"]);

export const PERSIST_BASE_OPTIONS = ["defaults", "nofail", "x-systemd.device-timeout=30s"];

/** Turn mount/umount stderr into something a person can act on. */
export function mountError(e: unknown, what: string): AppError {
  const stderr = e instanceof CommandError ? `${e.stderr}\n${e.message}` : (e as Error).message ?? "";
  const s = stderr.toLowerCase();
  let msg: string;
  if (/target is busy|device is busy/.test(s)) msg = `${what}: it's still in use. Close whatever is using it and try again.`;
  else if (/wrong fs type|bad superblock|bad option/.test(s)) msg = `${what}: Linux couldn't read the filesystem. It may need checking (fsck), or it isn't formatted the way it looks.`;
  else if (/already mounted|is busy/.test(s)) msg = `${what}: it's already mounted somewhere.`;
  else if (/can't find|no such file|does not exist/.test(s)) msg = `${what}: the drive or folder couldn't be found. It may have been unplugged.`;
  else if (/not mounted/.test(s)) msg = `${what}: it isn't mounted.`;
  else if (/write-protected|read-only/.test(s)) msg = `${what}: the drive is write-protected.`;
  else if (/unknown filesystem type/.test(s)) msg = `${what}: this server doesn't support that kind of filesystem.`;
  else msg = `${what}: ${stderr.trim().split("\n").filter(Boolean).pop() ?? "it didn't work"}.`;
  return new AppError("mount_failed", msg, 500, { stderr: stderr.slice(0, 2000) });
}

export function afterChange() {
  invalidateInventory();
  try {
    sampleFilesystems();
  } catch {
    /* next sample will catch up */
  }
  publish("storage.changed", { at: Date.now() });
}

export function persistEntry(r: VolumeRecord, target: string, opts: { noatime?: boolean; currentOptions?: string[]; superOptions?: string[] } = {}): FstabEntry {
  const fstype = r.vol.fstype ?? "auto";
  const mntops = [...PERSIST_BASE_OPTIONS];
  const noatime = opts.noatime ?? r.disk.rotational;
  if (noatime) mntops.push("noatime");
  // FAT/exFAT/NTFS have no Unix owners: keep the uid/gid/umask the drive is mounted with now.
  if (NON_POSIX.has(fstype)) {
    for (const o of [...(opts.superOptions ?? []), ...(opts.currentOptions ?? [])]) {
      if (/^(uid|gid|umask|fmask|dmask)=/.test(o) && !mntops.some((x) => x.split("=")[0] === o.split("=")[0])) mntops.push(o);
    }
  }
  const spec = r.vol.uuid ? `UUID=${r.vol.uuid}` : r.vol.partUuid ? `PARTUUID=${r.vol.partUuid}` : r.vol.path;
  const pass = /^ext[234]$/.test(fstype) ? 2 : 0;
  return { spec, file: target, vfstype: fstype === "ntfs" ? "ntfs3" : fstype, mntops, freq: 0, passno: pass };
}

function volumeOrThrow(s: InventoryState, key: string): VolumeRecord {
  const r = findVolume(s, key);
  if (!r) throw notFound("That drive or partition");
  return r;
}

// ---------------------------------------------------------------- mount

export async function planMount(input: { device: string; target: string; persist?: boolean; noatime?: boolean }): Promise<MountPlan & { entry: FstabEntry | null; record: VolumeRecord }> {
  const s = await getInventoryState(true);
  const r = volumeOrThrow(s, input.device);
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (r.vol.primaryMount) blockers.push(`${r.vol.name} is already mounted at ${r.vol.primaryMount}. To move it, use Rename mount point.`);
  if (r.vol.role !== "filesystem") {
    const why: Record<string, string> = {
      swap: "It's swap space, not a place for files.",
      "lvm-member": "It's part of an LVM volume group; its volumes are mounted instead.",
      "raid-member": "It's part of a RAID array; the array is mounted instead.",
      encrypted: "It's encrypted and has to be unlocked first.",
      "bios-boot": "It's a boot partition used by the BIOS.",
      unformatted: "It doesn't have a filesystem yet. Set up the disk first.",
    };
    blockers.push(why[r.vol.role] ?? "It doesn't contain a filesystem Gluon can mount.");
  } else if (r.vol.fstype && !MOUNTABLE.has(r.vol.fstype)) blockers.push(`Gluon doesn't mount ${r.vol.fstype} filesystems.`);
  if (r.disk.system) warnings.push("This partition is on the system disk.");
  if (r.vol.deviceReadOnly) warnings.push("The drive is write-protected, so it will be mounted read-only.");
  let target = input.target;
  try {
    target = (await validateMountTarget(input.target, { systemMounts: s.systemMounts })).path;
  } catch (e) {
    if (e instanceof AppError) blockers.push(e.message);
    else throw e;
  }
  const entry = input.persist ? persistEntry(r, target, { noatime: input.noatime }) : null;
  if (entry && !r.vol.uuid) warnings.push("This filesystem has no UUID, so fstab will refer to it by a name that could change.");
  return { device: r.vol.path, target, fstype: r.vol.fstype, fstabLine: entry ? formatEntry(entry) : null, warnings, blockers, entry, record: r };
}

export async function mountVolume(user: User, input: { device: string; target: string; readOnly?: boolean; persist?: boolean; noatime?: boolean }, where: Where): Promise<{ message: string; target: string }> {
  return withLock(`mounting ${input.device}`, async () => {
    const plan = await planMount(input);
    if (plan.blockers.length) throw new AppError("refused", plan.blockers[0]!, 409, { blockers: plan.blockers });
    const r = plan.record;
    const created = await hostMkdirs(plan.target);
    const opts = [input.readOnly || r.vol.deviceReadOnly ? "ro" : null, input.noatime ?? r.disk.rotational ? "noatime" : null].filter(Boolean) as string[];
    try {
      await host("mount", [...(opts.length ? ["-o", opts.join(",")] : []), "--", r.vol.path, plan.target], { timeoutMs: 60_000 });
    } catch (e) {
      if (created) await hostRemoveEmptyDirs(plan.target, created).catch(() => undefined);
      const err = mountError(e, `Couldn't mount ${r.vol.name} at ${plan.target}`);
      audit(user, { action: "storage.mount", target: plan.target, summary: `Tried to mount ${r.vol.name} at ${plan.target}`, detail: { device: r.vol.path, error: err.message }, outcome: "failed" }, where);
      throw err;
    }
    let note = "";
    if (plan.entry) {
      try {
        const s = await getInventoryState(true);
        await writeFstab(applyChanges(s.fstabText, [{ kind: "add", entry: plan.entry, comment: gluonComment(`${r.disk.model ?? r.disk.title} (${r.vol.name})`) }]), s.fstabText);
        note = " It will come back after a restart.";
      } catch (e) {
        note = ` It's mounted, but making it permanent failed: ${(e as Error).message}`;
      }
    }
    afterChange();
    const message = `Mounted ${r.vol.name} (${formatBytes(r.vol.size)}) at ${plan.target}.${note}`;
    audit(user, { action: "storage.mount", target: plan.target, summary: message, detail: { device: r.vol.path, uuid: r.vol.uuid, readOnly: !!input.readOnly, persist: !!input.persist } }, where);
    return { message, target: plan.target };
  });
}

// ---------------------------------------------------------------- unmount

export async function planUnmount(target: string): Promise<UnmountPlan & { record: VolumeRecord | null; fstabIndex: number | null }> {
  const s = await getInventoryState(true);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const m = mountAt(target, s.mounts);
  if (!m) throw notFound(`A mount at ${target}`);
  const r = s.volumes.find((v) => v.vol.mounts.some((x) => x.target === m.target)) ?? null;
  if (isSystemTarget(m.target) || (r && r.disk.system)) blockers.push(`${m.target} is on the system disk. Unmounting it could stop the server from working.`);
  const mv = r?.vol.mounts.find((x) => x.target === m.target);
  if (mv?.bind) warnings.push(`${m.target} is a second view (bind mount) of ${r?.vol.primaryMount ?? "another folder"}; the drive itself stays mounted.`);
  const { holders } = await findHolders(m.target, { containers: s.containers });
  if (holders.length) blockers.push(`It's in use: ${holders.map((h) => h.label).slice(0, 5).join(" ")}`);
  let fstabLine: UnmountPlan["fstabLine"] = null;
  let fstabIndex: number | null = null;
  for (const l of s.fstab.lines) {
    if (l.entry && l.entry.file === m.target && !isSwapEntry(l.entry)) {
      fstabLine = { line: l.index + 1, text: l.raw };
      fstabIndex = l.index;
      break;
    }
  }
  if (fstabLine) warnings.push(`/etc/fstab mounts it again at the next restart (line ${fstabLine.line}) unless you remove that line too.`);
  return { target: m.target, device: m.source, holders, fstabLine, warnings, blockers, record: r, fstabIndex };
}

export async function unmountTarget(user: User, input: { target: string; removeFromFstab?: boolean }, where: Where): Promise<{ message: string }> {
  return withLock(`unmounting ${input.target}`, async () => {
    const plan = await planUnmount(input.target);
    if (plan.blockers.length) {
      throw new AppError("busy", plan.blockers.join(" "), 409, { holders: plan.holders, blockers: plan.blockers });
    }
    try {
      await host("umount", ["--", plan.target], { timeoutMs: 120_000 });
    } catch (e) {
      const again = await findHolders(plan.target).catch(() => null);
      const err = mountError(e, `Couldn't unmount ${plan.target}`);
      audit(user, { action: "storage.unmount", target: plan.target, summary: `Tried to unmount ${plan.target}`, detail: { error: err.message }, outcome: "failed" }, where);
      if (again?.holders.length) throw new AppError("busy", `${err.message} ${again.holders.map((h) => h.label).join(" ")}`, 409, { holders: again.holders });
      throw err;
    }
    let note = "";
    if (input.removeFromFstab && plan.fstabLine && plan.fstabIndex !== null) {
      try {
        const s = await getInventoryState(true);
        await writeFstab(applyChanges(s.fstabText, [{ kind: "remove", index: plan.fstabIndex, expectRaw: plan.fstabLine.text }]), s.fstabText);
        note = " It was also removed from /etc/fstab.";
      } catch (e) {
        note = ` It's unmounted, but removing it from /etc/fstab failed: ${(e as Error).message}`;
      }
    } else if (plan.fstabLine) note = " It will be mounted again at the next restart (it's in /etc/fstab).";
    afterChange();
    const message = `Unmounted ${plan.target}.${note}`;
    audit(user, { action: "storage.unmount", target: plan.target, summary: message, detail: { device: plan.device, removeFromFstab: !!input.removeFromFstab } }, where);
    return { message };
  });
}

// ---------------------------------------------------------------- make permanent

interface PersistWork {
  plan: PersistPlan;
  changes: FstabChange[];
  text: string;
}

/** Mounted filesystems that won't come back after a restart. */
export function notPersistent(s: InventoryState): VolumeRecord[] {
  return s.volumes.filter(
    (r) =>
      r.vol.role === "filesystem" &&
      r.vol.primaryMount &&
      r.vol.persistence &&
      r.vol.persistence.state !== "persistent" &&
      !r.disk.removable &&
      !isWithin2(r.vol.primaryMount, ["/media", "/run/media"]),
  );
}

function isWithin2(p: string, roots: string[]) {
  return roots.some((root) => p === root || p.startsWith(`${root}/`));
}

export async function planPersist(targets: string[] | null, opts: { noatime?: boolean } = {}): Promise<PersistWork> {
  const s = await getInventoryState(true);
  const mounts = readMountinfo();
  const candidates = notPersistent(s);
  const wanted = targets ?? candidates.map((r) => r.vol.primaryMount!);
  const plan: PersistPlan = { items: [], skipped: [] };
  const changes: FstabChange[] = [];
  for (const t of wanted) {
    const r = s.volumes.find((v) => v.vol.primaryMount === t);
    if (!r) {
      plan.skipped.push({ target: t, reason: "Nothing is mounted there any more." });
      continue;
    }
    if (r.vol.role !== "filesystem") {
      plan.skipped.push({ target: t, reason: "It isn't a regular filesystem." });
      continue;
    }
    if (r.vol.persistence?.state === "persistent") {
      plan.skipped.push({ target: t, reason: "It's already permanent." });
      continue;
    }
    if (!r.vol.uuid && !r.vol.partUuid) {
      plan.skipped.push({ target: t, reason: "It has no UUID, so it can't be referred to reliably." });
      continue;
    }
    const m = mounts.find((x) => x.target === t);
    const entry = persistEntry(r, t, { noatime: opts.noatime, currentOptions: m?.options, superOptions: m?.superOptions });
    const after = formatEntry(entry);
    // An existing line for this filesystem elsewhere, or for another filesystem here: fix it rather than duplicate.
    const sameFs = s.fstab.lines.find((l) => l.entry && !isBindEntry(l.entry) && !isSwapEntry(l.entry) && matchesVolume(l.entry, r.ident));
    const sameTarget = s.fstab.lines.find((l) => l.entry && l.entry.file === t && !isSwapEntry(l.entry));
    if (sameFs) {
      changes.push({ kind: "replace", index: sameFs.index, expectRaw: sameFs.raw, entry: { ...entry, mntops: mergeOptions(sameFs.entry!.mntops, entry.mntops) } });
      plan.items.push({ target: t, device: r.vol.path, action: "update", line: sameFs.index + 1, before: sameFs.raw, after: formatEntry({ ...entry, mntops: mergeOptions(sameFs.entry!.mntops, entry.mntops) }) });
      if (sameTarget && sameTarget.index !== sameFs.index) {
        changes.push({ kind: "comment-out", index: sameTarget.index, expectRaw: sameTarget.raw, note: `Replaced by Gluon on ${new Date().toISOString().slice(0, 10)}` });
      }
    } else if (sameTarget) {
      changes.push({ kind: "comment-out", index: sameTarget.index, expectRaw: sameTarget.raw, note: `Replaced by Gluon on ${new Date().toISOString().slice(0, 10)}` });
      changes.push({ kind: "add", entry, comment: gluonComment(`${r.disk.model ?? r.disk.title} (${r.vol.name})`) });
      plan.items.push({ target: t, device: r.vol.path, action: "replace-conflict", line: sameTarget.index + 1, before: sameTarget.raw, after });
    } else {
      changes.push({ kind: "add", entry, comment: gluonComment(`${r.disk.model ?? r.disk.title} (${r.vol.name})`) });
      plan.items.push({ target: t, device: r.vol.path, action: "add", line: null, before: null, after });
    }
  }
  return { plan, changes, text: s.fstabText };
}

/** Keep hand-added options from an existing line, but make sure ours are there. */
function mergeOptions(existing: string[], ours: string[]): string[] {
  const keys = new Set(ours.map((o) => o.split("=")[0]));
  const kept = existing.filter((o) => o !== "defaults" && !keys.has(o.split("=")[0]) && o !== "auto");
  return [...ours, ...kept];
}

export async function persistMounts(user: User | null, input: { targets: string[] | null; noatime?: boolean }, where: Where = {}): Promise<{ message: string; backup: string | null; plan: PersistPlan }> {
  return withLock("making mounts permanent", async () => {
    const work = await planPersist(input.targets, { noatime: input.noatime });
    if (!work.changes.length) {
      const why = work.plan.skipped.map((x) => `${x.target}: ${x.reason}`).join(" ");
      throw new AppError("nothing_to_do", why || "Every mounted drive is already permanent.", 409);
    }
    const res = await writeFstab(applyChanges(work.text, work.changes), work.text);
    afterChange();
    const targets = work.plan.items.map((i) => i.target);
    const message = `${listJoin(targets)} will now come back after a restart.`;
    if (user) audit(user, { action: "storage.persist", target: targets.join(", "), summary: `Made ${listJoin(targets)} permanent`, detail: { lines: work.plan.items.map((i) => i.after), backup: res.backup } }, where);
    return { message, backup: res.backup || null, plan: work.plan };
  });
}
