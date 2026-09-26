"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MoreHoriz, Folder, Search, EditPencil, Eject, Lock } from "iconoir-react";
import { useFormat } from "@/components/PrefsProvider";
import { StateLine } from "@/components/ui/StateLine";
import { Button, IconButton } from "@/components/ui/Button";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Empty, UsageBar } from "@/components/ui/Surface";
import type { DiskView, VolumeView } from "@/lib/storage-types";
import { allVolumes, filesHref, notPermanent } from "./shared";
import s from "./storage.module.css";

export type VolumeAction = "mount" | "unmount" | "persist" | "rename" | "usage";

export interface Row {
  disk: DiskView;
  vol: VolumeView;
}

export function mountedRows(disks: DiskView[]): Row[] {
  const rows: Row[] = [];
  for (const d of disks) for (const v of allVolumes(d)) if (v.primaryMount || v.swapActive) rows.push({ disk: d, vol: v });
  return rows.sort((a, b) => (a.vol.primaryMount ?? "~").localeCompare(b.vol.primaryMount ?? "~"));
}

/** What happens after a restart, in words, with the state line. */
export function Persistence({ vol, disk, onPersist, disabled }: { vol: VolumeView; disk: DiskView; onPersist?: () => void; disabled?: boolean }) {
  if (vol.swapActive && !vol.primaryMount) return <span className={s.muted}>{vol.fstabLines.length ? "In /etc/fstab" : "Turned on by hand"}</span>;
  const p = vol.persistence;
  if (!p) return <span className={s.muted}>—</span>;
  if (p.state === "persistent") {
    return (
      <span className={s.persist}>
        <StateLine state="running" size={12} label={p.via === "systemd" ? "Permanent (systemd)" : p.fragile ? "Permanent, by device name" : "Permanent"} />
      </span>
    );
  }
  const text = p.state === "different-target" ? `fstab puts it at ${p.fstabTarget}` : p.state === "conflict" ? "fstab mounts another drive here" : "Not after a restart";
  if (!notPermanent(vol, disk)) return <span className={s.muted}>{text}</span>;
  return (
    <span className={s.persist}>
      <StateLine state="attention" size={12} label={text} />
      {onPersist && (
        <Button size="sm" variant="secondary" onClick={onPersist} disabled={disabled}>
          Make permanent
        </Button>
      )}
    </span>
  );
}

export function volumeMenu(vol: VolumeView, disk: DiskView, act: (a: VolumeAction, r: Row) => void, busy: boolean, router: ReturnType<typeof useRouter>): MenuEntry[] {
  const r = { disk, vol };
  const mounted = !!vol.primaryMount;
  const system = disk.system;
  const items: MenuEntry[] = [];
  if (mounted) {
    items.push({ label: "Open in Files", icon: <Folder />, onSelect: () => router.push(filesHref(vol.primaryMount!)) });
    items.push({ label: "See what's using space", icon: <Search />, onSelect: () => act("usage", r) });
    items.push("separator");
    if (notPermanent(vol, disk)) items.push({ label: "Make permanent", icon: <Lock />, disabled: busy, onSelect: () => act("persist", r) });
    items.push({ label: "Rename mount point…", icon: <EditPencil />, disabled: busy || system, description: system ? "Not for the system disk" : undefined, onSelect: () => act("rename", r) });
    items.push({ label: "Unmount…", icon: <Eject />, disabled: busy || system, description: system ? "Not for the system disk" : undefined, onSelect: () => act("unmount", r) });
  } else if (vol.role === "filesystem") {
    items.push({ label: "Mount…", icon: <Folder />, disabled: busy, onSelect: () => act("mount", r) });
  }
  return items;
}

export function MountsTable({ disks, onAction, busy }: { disks: DiskView[]; onAction: (a: VolumeAction, r: Row) => void; busy: boolean }) {
  const fmt = useFormat();
  const router = useRouter();
  const rows = mountedRows(disks);
  if (!rows.length) {
    return <Empty title="Nothing is mounted">Drives appear here once they're mounted. Open a disk above to mount it.</Empty>;
  }
  return (
    <div className={s.table} role="table" aria-label="Mounted filesystems">
      <div className={`${s.tRow} ${s.tHead}`} role="row">
        <span role="columnheader">Mount point</span>
        <span role="columnheader">Device</span>
        <span role="columnheader">Space</span>
        <span role="columnheader">After a restart</span>
        <span role="columnheader">Options</span>
        <span role="columnheader" className="sr-only">
          Actions
        </span>
      </div>
      {rows.map(({ disk, vol }) => {
        const binds = vol.mounts.filter((m) => m.bind);
        const primary = vol.mounts.find((m) => !m.bind);
        const u = vol.usage;
        const items = volumeMenu(vol, disk, onAction, busy, router);
        return (
          <div key={`${disk.id}:${vol.name}`} role="row" className={s.tRow}>
            <span role="cell" className={s.mountCell}>
              {vol.primaryMount ? (
                <Link href={filesHref(vol.primaryMount)} className={`${s.mountName} mono`} title={vol.primaryMount}>
                  {vol.primaryMount}
                </Link>
              ) : (
                <span className={`${s.mountName} mono`}>swap</span>
              )}
              {binds.length > 0 && (
                <span className={s.sub} title={binds.map((b) => b.target).join(", ")}>
                  also at <span className="mono">{binds.map((b) => b.target).join(", ")}</span>
                </span>
              )}
              {vol.mountedReadOnly && !vol.deviceReadOnly && (
                <span className={s.sub}>
                  <StateLine state="unhealthy" size={11} label="Read-only" />
                </span>
              )}
            </span>
            <span role="cell" className={s.devCell}>
              <Link href={`/storage/${encodeURIComponent(disk.id)}`} className="mono">
                {vol.name}
              </Link>
              <span className={s.sub}>
                {[vol.fstype, vol.label ? `“${vol.label}”` : null, disk.title].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span role="cell" className={s.spaceCell}>
              {u ? (
                <>
                  <UsageBar value={u.pct} attention={85} fault={95} label={`${vol.primaryMount} ${Math.round(u.pct)}% used`} />
                  <span className={`${s.sub} num`}>
                    {fmt.bytes(u.avail)} free of {fmt.bytes(u.size)}
                  </span>
                </>
              ) : (
                <span className={`${s.sub} num`}>{fmt.bytes(vol.size)}</span>
              )}
            </span>
            <span role="cell">
              <Persistence vol={vol} disk={disk} onPersist={() => onAction("persist", { disk, vol })} disabled={busy} />
            </span>
            <span role="cell" className={`${s.optCell} mono`} title={primary?.options.join(",")}>
              {primary?.options.join(",") ?? ""}
            </span>
            <span role="cell" className={s.actions}>
              {items.length > 0 && (
                <Menu
                  trigger={
                    <IconButton label={`${vol.primaryMount ?? vol.name} actions`} size="sm">
                      <MoreHoriz />
                    </IconButton>
                  }
                  items={items}
                />
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
