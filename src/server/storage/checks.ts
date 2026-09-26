import "server-only";
import { z } from "zod";
import { registerCheck, registerRemedy } from "../alerts/engine";
import { raise, resolve, resolveMissing, type Remedy } from "../findings";
import { AppError } from "../errors";
import { formatBytes, listJoin } from "@/lib/format";
import { getInventoryState, type InventoryState } from "./inventory";
import { notPersistent, planPersist, persistMounts, afterChange } from "./ops";
import { applyChanges, readFstabText, writeFstab, parseFstab } from "./fstab";
import { withLock } from "./oplog";
import type { DiskView } from "@/lib/storage-types";

const diskHref = (d: DiskView) => `/storage/${encodeURIComponent(d.id)}`;
const named = (d: DiskView) => `${d.title}${d.model ? ` (${d.model})` : ""}`;

// ---------------------------------------------------------------- mounts that won't survive a restart

async function checkPersistence(s: InventoryState) {
  const missing = notPersistent(s);
  if (!missing.length) {
    resolve("storage.not-persistent");
    return;
  }
  const targets = missing.map((r) => r.vol.primaryMount!);
  const describe = missing.map((r) => {
    const where = r.vol.persistence?.state === "different-target" ? ` (/etc/fstab puts it at ${r.vol.persistence.fstabTarget})` : r.vol.persistence?.state === "conflict" ? " (/etc/fstab mounts a different drive there)" : "";
    return `${r.vol.primaryMount} (${r.disk.title}${r.disk.model ? `, ${r.disk.model}` : ""})${where}`;
  });
  const apps = [...new Set(missing.flatMap((r) => r.vol.usedBy.map((u) => u.app)))];
  const n = missing.length;
  let remedy: Remedy = { action: "", label: "Open Storage", href: "/storage" };
  try {
    const work = await planPersist(targets);
    if (work.plan.items.length) {
      remedy = {
        action: "storage.persistMounts",
        label: n === 1 ? "Make it permanent" : "Make them permanent",
        params: { targets: work.plan.items.map((i) => i.target) },
        confirm: {
          title: n === 1 ? "Add this drive to the startup list?" : "Add these drives to the startup list?",
          consequences: [
            ...work.plan.items.map((i) => (i.before ? `Line ${i.line} becomes: ${i.after}` : `Adds: ${i.after}`)),
            "A backup of the startup list (/etc/fstab) is saved first, and the new list is checked before it's used.",
            "\"nofail\" means the server still starts normally if a drive is missing.",
          ],
        },
      };
    }
  } catch {
    /* keep the link remedy */
  }
  raise({
    id: "storage.not-persistent",
    kind: "storage.not-persistent",
    severity: "attention",
    subject: targets.join(", "),
    title: n === 1 ? `${targets[0]} won't come back after a restart` : `${n} drives won't come back after a restart`,
    cause: `${listJoin(describe)} ${n === 1 ? "was" : "were"} mounted by hand and ${n === 1 ? "isn't" : "aren't"} on the startup list (/etc/fstab). After a restart ${n === 1 ? "it" : "they"} won't be mounted${apps.length ? `, and ${listJoin(apps)} would find ${apps.length === 1 ? "its" : "their"} folders empty` : ""}.`,
    detail: { targets },
    remedy,
  });
}

// ---------------------------------------------------------------- unused disks

function checkUnused(s: InventoryState) {
  const open = new Set<string>();
  for (const d of s.view.disks) {
    if ((d.state !== "unused" && d.state !== "empty") || d.inFstab || d.removable || !d.mediaPresent || d.size < 8 * 1000 ** 3) continue;
    const id = `storage.unused:${d.id}`;
    open.add(id);
    const kinds = [...new Set(d.partitions.map((p) => (p.role === "lvm-member" ? "an LVM volume" : p.role === "filesystem" ? `a ${p.fstype} partition` : p.role === "unformatted" ? "an unformatted partition" : null)).filter(Boolean))] as string[];
    raise({
      id,
      kind: "storage.unused",
      severity: "info",
      subject: d.path,
      title: `${d.title} isn't being used`,
      cause: `${d.model ?? d.name} (${d.name}) ${d.state === "empty" ? "is blank" : `has ${kinds.length ? listJoin(kinds) : "old partitions"} but nothing on it is mounted`}. It could be set up as ${formatBytes(d.size)} of extra storage.`,
      detail: { disk: d.id, name: d.name, size: d.size },
      remedy: { action: "", label: "Set it up", href: diskHref(d) },
    });
  }
  resolveMissing("storage.unused", open);
}

// ---------------------------------------------------------------- SMART and temperature

function tempLimits(d: DiskView): { attention: number; fault: number } {
  const limit = d.smart?.tempLimit ?? null;
  if (d.media === "hdd") {
    const att = limit ? Math.min(limit, 55) : 55;
    return { attention: att, fault: att + 5 };
  }
  if (d.media === "nvme") return { attention: limit ? limit - 5 : 75, fault: limit ?? 82 };
  return { attention: limit ? limit - 5 : 70, fault: limit ?? 80 };
}

function checkSmart(s: InventoryState) {
  const openSmart = new Set<string>();
  const openTemp = new Set<string>();
  for (const d of s.view.disks) {
    const sm = d.smart;
    if (!sm) continue;
    const smartId = `storage.smart:${d.id}`;
    const tempId = `storage.temp:${d.id}`;
    if (sm.state === "asleep") {
      // Keep whatever we last knew about its health; a sleeping disk isn't hot.
      openSmart.add(smartId);
      continue;
    }
    const where = d.partitions.concat(d.wholeDisk ? [d.wholeDisk] : []).map((v) => v.primaryMount).filter(Boolean) as string[];
    const whereText = where.length ? ` (mounted at ${listJoin(where)})` : "";
    if (sm.state === "failing") {
      openSmart.add(smartId);
      raise({
        id: smartId,
        kind: "storage.smart",
        severity: "fault",
        subject: d.path,
        title: `The ${named(d)} is failing`,
        cause: `${sm.notes.slice(0, 3).join(" ")} Copy anything important off it${whereText} and plan to replace it.`,
        detail: { disk: d.id, smart: sm },
        remedy: { action: "", label: "See drive health", href: diskHref(d) },
      });
    } else if (sm.state === "warning") {
      openSmart.add(smartId);
      raise({
        id: smartId,
        kind: "storage.smart",
        severity: "attention",
        subject: d.path,
        title: `The ${named(d)} is showing signs of wear`,
        cause: `${sm.notes.slice(0, 3).join(" ")} It still works, but make sure what's on it${whereText} is backed up.`,
        detail: { disk: d.id, smart: sm },
        remedy: { action: "", label: "See drive health", href: diskHref(d) },
      });
    } else if (sm.state === "ok" && (sm.reallocated ?? 0) > 0 && (d.media === "hdd" || sm.known)) {
      openSmart.add(smartId);
      raise({
        id: smartId,
        kind: "storage.smart",
        severity: "info",
        subject: d.path,
        title: `The ${named(d)} has ${sm.reallocated} replaced bad sector${sm.reallocated === 1 ? "" : "s"}`,
        cause: "The number hasn't gone up recently, so the drive is coping. Gluon will tell you if it starts rising.",
        detail: { disk: d.id, smart: sm },
        remedy: { action: "", label: "See drive health", href: diskHref(d) },
      });
    }

    const t = sm.temperature;
    if (t === null || sm.readAt === null) continue;
    const lim = tempLimits(d);
    const hot = t >= lim.attention;
    const wasHot = t >= lim.attention - 3; // hysteresis: stay open until it cools a bit
    if (hot || wasHot) {
      openTemp.add(tempId);
      if (!hot) continue;
      raise({
        id: tempId,
        kind: "storage.temperature",
        severity: t >= lim.fault ? "fault" : "attention",
        subject: d.path,
        title: `The ${named(d)} is running hot (${Math.round(t)}°C)`,
        cause: `${sm.tempLimit ? `It's rated for up to ${sm.tempLimit}°C.` : `Above ${lim.attention}°C shortens a ${d.media === "hdd" ? "hard drive's" : "drive's"} life.`} Check the airflow around it${d.media === "hdd" ? ", and that it isn't packed against another hot drive" : ""}.`,
        detail: { disk: d.id, temperature: t, limit: sm.tempLimit, attention: lim.attention, fault: lim.fault },
        remedy: { action: "", label: "See drive health", href: diskHref(d) },
      });
    }
  }
  resolveMissing("storage.smart", openSmart);
  resolveMissing("storage.temperature", openTemp);
}

// ---------------------------------------------------------------- read-only filesystems

const RO_BY_NATURE = new Set(["iso9660", "squashfs", "udf", "erofs", "cramfs"]);

function checkReadOnly(s: InventoryState) {
  const open = new Set<string>();
  for (const r of s.volumes) {
    const v = r.vol;
    if (!v.primaryMount || !v.mountedReadOnly || v.deviceReadOnly || RO_BY_NATURE.has(v.fstype ?? "")) continue;
    const line = s.fstab.lines.find((l) => l.entry && l.entry.file === v.primaryMount);
    if (line?.entry?.mntops.includes("ro")) continue;
    const id = `storage.readonly:${v.primaryMount}`;
    open.add(id);
    raise({
      id,
      kind: "storage.readonly",
      severity: line ? "fault" : "attention",
      subject: v.primaryMount,
      title: `${v.primaryMount} has switched to read-only`,
      cause: `Linux does this when it finds errors on a drive, to protect what's on it. Apps can't save anything to ${v.primaryMount} (${r.disk.title}) until the drive is checked and mounted again. The kernel log usually says why.`,
      detail: { device: v.path, mount: v.primaryMount },
      remedy: { action: "", label: "Read the kernel log", href: "/diagnostics?tab=kernel" },
    });
  }
  resolveMissing("storage.readonly", open);
}

// ---------------------------------------------------------------- fstab that could stop a boot

function checkFstab(s: InventoryState) {
  const open = new Set<string>();
  for (const e of s.view.fstab.entries) {
    if (e.present !== false || e.nofail || e.swap || e.bind || e.options.includes("noauto")) continue;
    if (!["uuid", "label", "partuuid", "partlabel", "device", "link"].includes(e.sourceKind)) continue;
    const id = `storage.fstab-missing:${e.spec}`;
    open.add(id);
    raise({
      id,
      kind: "storage.fstab-missing",
      severity: "fault",
      subject: e.target,
      title: "The server may not start after a restart",
      cause: `/etc/fstab line ${e.line} needs ${e.spec} at ${e.target}, but that drive isn't connected. Without "nofail", Linux waits for it at startup and can end up in emergency mode.`,
      detail: { line: e.line, text: e.text },
      remedy: {
        action: "storage.fstabNofail",
        label: "Let it start without this drive",
        params: { line: e.line, text: e.text },
        confirm: { title: "Mark this drive as optional?", consequences: [`Adds nofail,x-systemd.device-timeout=30s to line ${e.line} of /etc/fstab.`, "The drive is still mounted when it's connected.", "A backup of /etc/fstab is saved first."] },
      },
    });
  }
  resolveMissing("storage.fstab-missing", open);
}

// ---------------------------------------------------------------- registration

registerCheck("storage", 5 * 60_000, async () => {
  const s = await getInventoryState(true);
  if (!s.view.disks.length) return; // lsblk failed: don't resolve everything on a bad read
  await checkPersistence(s);
  checkUnused(s);
  checkSmart(s);
  checkReadOnly(s);
  checkFstab(s);
});

registerRemedy("storage.persistMounts", {
  recent: true,
  async run({ params }) {
    const targets = z.array(z.string().startsWith("/").max(4096)).min(1).max(20).safeParse(params.targets);
    if (!targets.success) throw new AppError("invalid", "Which drives should be made permanent?");
    // The remedy engine audits this run; don't record it twice.
    const r = await persistMounts(null, { targets: targets.data });
    return { message: r.message };
  },
});

registerRemedy("storage.fstabNofail", {
  recent: true,
  async run({ params }) {
    const p = z.object({ line: z.number().int().min(1), text: z.string().max(4096) }).safeParse(params);
    if (!p.success) throw new AppError("invalid", "That fix is missing its details.");
    return withLock("editing /etc/fstab", async () => {
      const cur = readFstabText();
      const l = parseFstab(cur).lines[p.data.line - 1];
      if (!l || l.raw !== p.data.text || !l.entry) throw new AppError("conflict", "/etc/fstab changed since this was noticed. Gluon will look again shortly.", 409);
      const mntops = l.entry.mntops.filter((o) => o !== "defaults" || l.entry!.mntops.length === 1);
      const add = ["nofail", "x-systemd.device-timeout=30s"].filter((o) => !mntops.some((m) => m.split("=")[0] === o.split("=")[0]));
      const next = applyChanges(cur, [{ kind: "replace", index: l.index, expectRaw: l.raw, entry: { ...l.entry, mntops: [...mntops, ...add] } }]);
      await writeFstab(next, cur);
      afterChange();
      return { message: `${l.entry.file} is now optional at startup.` };
    });
  },
});
