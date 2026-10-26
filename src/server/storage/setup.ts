import "server-only";
import fs from "node:fs";
import { host, CommandError } from "../host/exec";
import { hostPath } from "../host/paths";
import { AppError, conflict, notFound } from "../errors";
import { audit } from "../audit";
import { raise } from "../findings";
import { sha256 } from "../crypto";
import { formatBytes } from "@/lib/format";
import type { User } from "../auth/users";
import { getInventoryState, findDisk } from "./inventory";
import { validateMountTarget, hostMkdirs, hostRemoveEmptyDirs, mountAt } from "./mounts";
import { applyChanges, formatEntry, readFstabText, restoreFstab, writeFstab, isBindEntry, matchesVolume, gluonComment, type FstabChange, type FstabEntry } from "./fstab";
import { acquireLock, Job } from "./oplog";
import { afterChange, mountError, PERSIST_BASE_OPTIONS, type Where } from "./ops";
import { sentence } from "./rename";
import type { DiskView, SetupPlan } from "@/lib/storage-types";

/**
 * Set up a disk for storage: erase it, create a GPT table with one partition, format it ext4 with a
 * label, mount it and add it to /etc/fstab by UUID. Refuses the system disk and anything in use; the
 * person must type the disk's serial number to confirm.
 */

export interface SetupInput {
  disk: string;
  label: string;
  mountPath?: string;
  noatime?: boolean;
}

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/;

function partPath(disk: DiskView, n: number): string {
  return /\d$/.test(disk.path) ? `${disk.path}p${n}` : `${disk.path}${n}`;
}

function flatVolumes(d: DiskView) {
  const out = [...d.partitions, ...(d.wholeDisk ? [d.wholeDisk] : [])];
  const walk = (v: (typeof out)[number]): (typeof out)[number][] => [v, ...v.children.flatMap(walk)];
  return out.flatMap(walk);
}

interface SetupWork {
  plan: SetupPlan;
  disk: DiskView;
  entry: FstabEntry;
  fstabRemovals: FstabChange[];
}

export async function planSetup(input: SetupInput): Promise<SetupWork> {
  const s = await getInventoryState(true);
  const disk = findDisk(s, input.disk);
  if (!disk) throw notFound("That disk");
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (disk.system) blockers.push(`${disk.name} is the system disk. ${disk.systemReason ?? ""}`.trim());
  if (!disk.mediaPresent) blockers.push("There's no disk in it.");
  if (disk.readOnly) blockers.push("The disk is write-protected.");
  if (disk.size < 1024 ** 3) blockers.push("That disk is smaller than 1 GB.");
  const vols = flatVolumes(disk);
  const mounted = vols.filter((v) => v.mounts.length > 0 || v.swapActive);
  if (mounted.length) blockers.push(`Parts of it are in use: ${mounted.map((v) => (v.swapActive ? `${v.name} (swap)` : `${v.name} at ${v.primaryMount ?? v.mounts[0]!.target}`)).join(", ")}. Unmount ${mounted.length === 1 ? "it" : "them"} first.`);
  const active = vols.filter((v) => v.children.length > 0);
  if (active.length) blockers.push(`${active.map((v) => v.name).join(", ")} ${active.length === 1 ? "is" : "are"} active (LVM, RAID or encryption). Deactivate ${active.length === 1 ? "it" : "them"} first.`);
  try {
    const holders = fs.readdirSync(`/sys/block/${disk.name}/holders`);
    if (holders.length && !active.length) blockers.push(`The kernel says ${disk.name} is in use by ${holders.join(", ")}.`);
  } catch {
    /* no holders dir */
  }

  const label = input.label.trim();
  if (!LABEL_RE.test(label)) blockers.push("Use a name of 1–16 letters, numbers, dashes or underscores for the drive (e.g. photos or media-2tb).");
  let mountPath = (input.mountPath?.trim() || `/mnt/${label}`).replace(/\/+$/, "");
  try {
    mountPath = (await validateMountTarget(mountPath, { systemMounts: s.systemMounts })).path;
  } catch (e) {
    if (e instanceof AppError) blockers.push(e.message);
    else throw e;
  }
  if (s.volumes.some((r) => r.vol.label === label && r.disk.id !== disk.id)) warnings.push(`Another drive is already called "${label}". It works, but you may mix them up.`);

  // fstab lines pointing at what's on the disk now would break (or hang boot without nofail).
  const fstabRemovals: FstabChange[] = [];
  const removalView: SetupPlan["fstabRemovals"] = [];
  const recs = s.volumes.filter((r) => r.disk.id === disk.id);
  for (const l of s.fstab.lines) {
    if (!l.entry || isBindEntry(l.entry)) continue;
    if (recs.some((r) => matchesVolume(l.entry!, r.ident))) {
      fstabRemovals.push({ kind: "comment-out", index: l.index, expectRaw: l.raw, note: `Disk erased by Gluon on ${new Date().toISOString().slice(0, 10)}` });
      removalView.push({ line: l.index + 1, text: l.raw });
    }
  }
  if (removalView.length) warnings.push(`/etc/fstab has ${removalView.length === 1 ? "a line" : `${removalView.length} lines`} for what's on this disk now. ${removalView.length === 1 ? "It" : "They"} will be commented out.`);

  const erases = vols
    .filter((v) => v.kind === "part" || v.kind === "disk")
    .map((v) => ({ name: v.name, size: v.size, fstype: v.fstype, label: v.label, used: v.usage?.used ?? null }));
  if (erases.some((e) => e.fstype === "LVM2_member")) warnings.push("It has an LVM volume. Anything stored in it will be erased.");
  if (erases.some((e) => e.fstype && e.fstype !== "swap")) warnings.push("Everything currently on the disk will be erased and can't be recovered.");

  const noatime = input.noatime ?? disk.rotational;
  const entry: FstabEntry = { spec: "UUID=<new>", file: mountPath, vfstype: "ext4", mntops: [...PERSIST_BASE_OPTIONS, ...(noatime ? ["noatime"] : [])], freq: 0, passno: 2 };
  const confirmWith = disk.serial ?? disk.name;
  const steps = [
    `Erase ${disk.name}`,
    "Create a new partition table (GPT) with one partition",
    `Format it as ext4 with the name ${label}`,
    `Create ${mountPath}`,
    ...(fstabRemovals.length ? ["Comment out old /etc/fstab lines for this disk"] : []),
    "Add it to /etc/fstab",
    `Mount it at ${mountPath}`,
  ];
  const plan: SetupPlan = {
    hash: "",
    disk: { id: disk.id, name: disk.name, path: disk.path, title: disk.title, model: disk.model, serial: disk.serial, size: disk.size },
    confirmWith,
    erases,
    label,
    mountPath,
    fstabLine: formatEntry(entry),
    fstabRemovals: removalView,
    warnings,
    blockers,
    steps,
  };
  plan.hash = sha256(JSON.stringify({ id: disk.id, name: disk.name, size: disk.size, erases, label, mountPath, removalView, noatime, blockers })).slice(0, 16);
  return { plan, disk, entry, fstabRemovals };
}

function cmdErr(e: unknown, what: string): AppError {
  const msg = e instanceof CommandError ? e.stderr.trim().split("\n").filter(Boolean).pop() || e.message : (e as Error).message;
  return new AppError("setup_failed", `${what}: ${msg}`, 500);
}

async function waitFor(p: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(hostPath(p))) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new AppError("setup_failed", `${p} didn't appear after partitioning.`, 500);
}

export async function startSetup(user: User, input: SetupInput & { confirmSerial: string; planHash: string }, where: Where): Promise<Job> {
  const release = acquireLock(`setting up ${input.disk}`);
  let work: SetupWork;
  try {
    work = await planSetup(input);
    if (work.plan.blockers.length) throw new AppError("refused", work.plan.blockers[0]!, 409, { blockers: work.plan.blockers });
    if (input.confirmSerial.trim().toLowerCase() !== work.plan.confirmWith.toLowerCase()) {
      throw new AppError("confirm", `Type the disk's serial number (${work.plan.confirmWith}) exactly to confirm.`, 400, { field: "confirmSerial" });
    }
    if (input.planHash !== work.plan.hash) throw conflict("The disk changed since you reviewed this. Review it again.");
  } catch (e) {
    release();
    throw e;
  }
  const { disk, plan } = work;
  const job = new Job("setup", disk.path, `Set up ${disk.title} (${disk.name}) as ${plan.mountPath}`, { disk: disk.id, label: plan.label, mountPath: plan.mountPath, plan }, user);
  job.plan(plan.steps);
  audit(user, { action: "storage.setup.start", target: disk.path, summary: `Started erasing and setting up ${disk.title} (${disk.model ?? disk.name}, serial ${disk.serial ?? "none"})`, detail: { jobId: job.id, plan } }, where);
  void runSetup(job, work, user, where).finally(release);
  return job;
}

async function runSetup(job: Job, w: SetupWork, user: User, where: Where) {
  const { disk, plan } = w;
  const undo: { label: string; fn: () => Promise<unknown> }[] = [];
  let failedAt = "";
  let erased = false;
  try {
    failedAt = `Erase ${disk.name}`;
    await job.step(failedAt, async () => {
      // Re-check right before the point of no return.
      const s = await getInventoryState(true);
      const d = findDisk(s, disk.id);
      if (!d || d.name !== disk.name || d.size !== disk.size) throw conflict("The disk changed (it may have been unplugged or renamed). Nothing was erased.");
      if (d.system || flatVolumes(d).some((v) => v.mounts.length || v.swapActive || v.children.length)) throw conflict("Part of the disk is in use now. Nothing was erased.");
      for (const v of flatVolumes(d).filter((x) => x.kind === "part").reverse()) {
        await host("wipefs", ["--all", "--force", "--", v.path], { timeoutMs: 60_000 }).catch((e) => {
          throw cmdErr(e, `Couldn't erase ${v.name}`);
        });
      }
      erased = true;
      await host("wipefs", ["--all", "--force", "--", disk.path], { timeoutMs: 60_000 }).catch((e) => {
        throw cmdErr(e, `Couldn't erase ${disk.name}`);
      });
    });

    failedAt = "Create a new partition table (GPT) with one partition";
    const part = partPath(disk, 1);
    await job.step(failedAt, async () => {
      await host("sfdisk", ["--quiet", "--wipe", "always", "--wipe-partitions", "always", "--", disk.path], { timeoutMs: 60_000, input: "label: gpt\n,,L\n" }).catch((e) => {
        throw cmdErr(e, "Couldn't partition the disk");
      });
      await host("partprobe", ["--", disk.path], { timeoutMs: 30_000 }).catch(() => undefined);
      await host("udevadm", ["settle", "--timeout=30"], { timeoutMs: 40_000 }).catch(() => undefined);
      await waitFor(part);
    });

    failedAt = `Format it as ext4 with the name ${plan.label}`;
    const uuid = await job.step(failedAt, async ({ detail }) => {
      detail("This can take a minute on large drives.");
      await host("mkfs.ext4", ["-F", "-q", "-L", plan.label, "-m", "1", "--", part], { timeoutMs: 15 * 60_000 }).catch((e) => {
        throw cmdErr(e, "Couldn't format the partition");
      });
      await host("udevadm", ["settle", "--timeout=30"], { timeoutMs: 40_000 }).catch(() => undefined);
      const { stdout } = await host("blkid", ["-c", "/dev/null", "-o", "value", "-s", "UUID", "--", part], { timeoutMs: 20_000 });
      const u = stdout.trim();
      if (!/^[0-9a-f-]{36}$/i.test(u)) throw new AppError("setup_failed", "The new filesystem has no UUID.", 500);
      detail(`UUID ${u}`);
      return u;
    });

    failedAt = `Create ${plan.mountPath}`;
    const created = await job.step(failedAt, async () => {
      if (mountAt(plan.mountPath)) throw conflict(`Something is mounted at ${plan.mountPath} now.`);
      return hostMkdirs(plan.mountPath);
    });
    if (created) undo.push({ label: `Remove ${plan.mountPath}`, fn: () => hostRemoveEmptyDirs(plan.mountPath, created) });

    const entry: FstabEntry = { ...w.entry, spec: `UUID=${uuid}` };
    const changes: FstabChange[] = [...w.fstabRemovals, { kind: "add", entry, comment: gluonComment(`${disk.model ?? disk.title} (${disk.serial ?? disk.name}), set up as "${plan.label}"`) }];
    failedAt = "Add it to /etc/fstab";
    const res = await job.step(failedAt, async ({ detail }) => {
      const cur = readFstabText();
      const r = await writeFstab(applyChanges(cur, changes), cur);
      detail(`Backup saved as ${r.backup}.`);
      return r;
    });
    if (w.fstabRemovals.length) job.setStatus("Comment out old /etc/fstab lines for this disk", "done", `${w.fstabRemovals.length === 1 ? "1 line" : `${w.fstabRemovals.length} lines`}, in the same edit.`);
    undo.push({ label: "Put /etc/fstab back", fn: () => restoreFstab(res.backup) });

    failedAt = `Mount it at ${plan.mountPath}`;
    await job.step(failedAt, async () => {
      try {
        await host("mount", ["--", plan.mountPath], { timeoutMs: 60_000 });
      } catch (e) {
        throw mountError(e, `Couldn't mount it at ${plan.mountPath}`);
      }
      if (!mountAt(plan.mountPath)) throw new AppError("mount_failed", `It didn't end up mounted at ${plan.mountPath}.`, 500);
    });

    const message = `${disk.title} is ready at ${plan.mountPath} (named "${plan.label}", ${formatBytes(disk.size)}). It will come back after a restart.`;
    job.finish("done", { result: { mountPath: plan.mountPath, uuid, label: plan.label, message } });
    audit(user, { action: "storage.setup", target: disk.path, summary: `Set up ${disk.title} (${disk.model ?? disk.name}) at ${plan.mountPath}`, detail: { jobId: job.id, uuid, label: plan.label, backup: res.backup } }, where);
  } catch (e) {
    const reason = sentence((e as Error).message || "it didn't work");
    const failures: string[] = [];
    for (const u of undo.reverse()) {
      try {
        await job.step(u.label, u.fn, { undo: true });
      } catch (err) {
        failures.push(`${u.label}: ${(err as Error).message}`);
      }
    }
    const lost = erased ? " The disk was already erased, so its old contents are gone; you can run the setup again." : " Nothing on the disk was changed.";
    const message = `Setting up ${disk.name} stopped at "${failedAt}": ${reason}${lost}${failures.length ? ` Some clean-up needs you: ${failures.join("; ")}.` : ""}`;
    job.finish(failures.length ? "failed" : erased ? "failed" : "rolled-back", { error: message });
    audit(user, { action: "storage.setup", target: disk.path, summary: `Tried to set up ${disk.title} (${disk.name})`, detail: { jobId: job.id, failedAt, error: reason, erased, undoFailures: failures }, outcome: "failed" }, where);
    if (failures.length) {
      raise({
        id: `storage.job:${job.id}`,
        kind: "storage.job",
        severity: "attention",
        subject: disk.path,
        title: `Setting up ${disk.title} didn't finish cleanly`,
        cause: `It stopped at "${failedAt}" and Gluon couldn't tidy up everything: ${failures.join("; ")}.`,
        detail: { jobId: job.id },
        remedy: { action: "", label: "See what happened", href: `/storage?job=${job.id}` },
      });
    }
  } finally {
    afterChange();
  }
}
