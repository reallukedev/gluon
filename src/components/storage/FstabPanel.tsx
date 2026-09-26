"use client";
import * as React from "react";
import { useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Panel, Empty, Notice, Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import type { DiskView, FstabBackup, FstabEntryView, StorageJob, VolumeView } from "@/lib/storage-types";
import type { Row } from "./MountsTable";
import { allVolumes, JOB_STATUS, jobLine, notPermanent } from "./shared";
import s from "./storage.module.css";

function sourceWords(e: FstabEntryView): string {
  switch (e.sourceKind) {
    case "uuid":
      return "it by its UUID, an ID that never changes";
    case "label":
      return `the drive named “${e.spec.replace(/^LABEL=/, "")}”`;
    case "partuuid":
    case "partlabel":
      return "it by its partition's ID";
    case "device":
      return `whatever is called ${e.spec} at startup, a name that can change when drives are added`;
    case "link":
      return e.spec;
    case "network":
      return `the network share ${e.spec}`;
    case "path":
      return e.spec;
    default:
      return e.spec;
  }
}

/** One fstab line in plain words. */
function explain(e: FstabEntryView): string {
  if (e.swap) return `Uses ${e.device ?? sourceWords(e)} as swap space.`;
  if (e.bind) return `Shows ${e.spec} also at ${e.target}.`;
  const opts: string[] = [];
  if (e.options.includes("noauto")) opts.push("only when asked (noauto)");
  if (e.nofail) opts.push("the server starts even if it's missing");
  if (e.options.includes("ro")) opts.push("read-only");
  if (e.options.includes("noatime")) opts.push("no access times");
  return `Finds ${sourceWords(e)}${e.device && e.sourceKind !== "device" ? ` (now ${e.device})` : ""}. ${[e.fstype, ...opts].join(" · ")}.`;
}

function entryLine(e: FstabEntryView) {
  if (e.issues.some((i) => /stop at startup/.test(i))) return "unhealthy" as const;
  if (e.issues.length) return "attention" as const;
  if (!e.mounted && !e.options.includes("noauto")) return "stopped" as const;
  return "running" as const;
}

/** Which disk a device path belongs to, by name a person recognises. */
function diskFor(disks: DiskView[], device: string | null): { disk: DiskView; vol: VolumeView } | null {
  if (!device) return null;
  for (const d of disks) for (const v of allVolumes(d)) if (v.path === device) return { disk: d, vol: v };
  return null;
}

/**
 * The startup list (/etc/fstab) as what it means: each line is a drive connected to a folder when the
 * server starts. Drives that are connected now but missing from it are listed first, with the fix.
 */
export function FstabPanel({ disks, onPersist, busy }: { disks: DiskView[]; onPersist: (r: Row) => void; busy: boolean }) {
  const fmt = useFormat();
  const { data, error } = useApi<{ text: string; entries: FstabEntryView[]; backups: FstabBackup[] }>("/api/storage/fstab", { refresh: 30_000 });
  const loose = disks.flatMap((d) => allVolumes(d).filter((v) => notPermanent(v, d)).map((v) => ({ disk: d, vol: v })));
  return (
    <div className={s.stack}>
      <Panel title="What connects at startup" meta={<span className="mono">/etc/fstab</span>} flush>
        <div className={s.explainWrap}>
          <p className={s.explain}>
          When the server starts, Linux reads a short list called <b>fstab</b> and connects each drive to its folder. A drive that isn't on the list stays disconnected after a restart, and apps that keep files on it find their folders empty.
          </p>
        </div>
        {error && (
          <div className={s.pad}>
            <Notice tone="fault">Gluon couldn't read /etc/fstab: {error.message}</Notice>
          </div>
        )}
        {!data && !error && (
          <div className={s.pad}>
            <Skeleton height={120} />
          </div>
        )}
        {loose.length > 0 && (
          <ul className={s.fstab} role="list" aria-label="Connected now, but not on the list">
            {loose.map(({ disk, vol }) => (
              <li key={vol.path} className={s.fstabRow} data-loose="">
                <StateLine state="attention" size={14} />
                <div className={s.fstabText}>
                  <p className={s.fstabHead}>
                    <span>{disk.title}</span>
                    <span className={s.fstabArrow} aria-label="connects to">→</span>
                    <span className="mono">{vol.primaryMount}</span>
                  </p>
                  <p className={s.fstabWords}>
                    Connected now, but not on the list: after a restart it won't be.
                    {vol.usedBy.length > 0 && ` ${[...new Set(vol.usedBy.map((u) => u.app))].join(", ")} would find ${vol.usedBy.length === 1 ? "its folder" : "their folders"} empty.`}
                  </p>
                </div>
                <Button size="sm" disabled={busy} onClick={() => onPersist({ disk, vol })}>
                  Add to the list
                </Button>
              </li>
            ))}
          </ul>
        )}
        {data && data.entries.length === 0 && !loose.length && <Empty title="The list is empty">Only what the system connects by itself is there at startup.</Empty>}
        {data && data.entries.length > 0 && (
          <ul className={s.fstab} role="list" aria-label="On the list">
            {data.entries.map((e) => {
              const hit = diskFor(disks, e.device);
              return (
                <li key={e.line} className={s.fstabRow}>
                  <StateLine state={entryLine(e)} size={14} />
                  <div className={s.fstabText}>
                    <p className={s.fstabHead}>
                      <span>{e.swap ? "Swap" : e.bind ? <span className="mono">{e.spec}</span> : hit ? (hit.disk.partitions.length > 1 || hit.disk.system ? `${hit.vol.name} on the ${hit.disk.title}` : hit.disk.title) : (e.device ?? e.spec)}</span>
                      {!e.swap && (
                        <>
                          <span className={s.fstabArrow} aria-label="connects to">→</span>
                          <span className="mono">{e.target}</span>
                        </>
                      )}
                    </p>
                    <p className={s.fstabWords}>{explain(e)}</p>
                    <code className={s.fstabLine} title={`Line ${e.line} of /etc/fstab`}>
                      <span className={s.muted}>{e.line}</span> {e.text}
                    </code>
                    {e.issues.map((i) => (
                      <p key={i} className={s.fstabIssue}>
                        {i}
                      </p>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {data && (
          <Disclosure summary="The whole file" meta={<span className="mono">/etc/fstab</span>} variant="panel">
            <pre className={s.code}>{data.text || "(empty)"}</pre>
          </Disclosure>
        )}
      </Panel>

      <Panel title="Earlier versions" meta={<span>Gluon keeps the last 10</span>} flush>
        {!data ? (
          <div className={s.pad}>
            <Skeleton height={40} />
          </div>
        ) : data.backups.length === 0 ? (
          <Empty title="No backups yet">Every time Gluon changes the startup list it first saves a copy, named with the date and time.</Empty>
        ) : (
          <ul className={s.simpleRows} role="list">
            {data.backups.map((b) => (
              <li key={b.path}>
                <span className="mono truncate" title={b.path}>
                  {b.path}
                </span>
                <Time ts={b.at} kind="dateTime" className={`${s.muted} num`} />
                <span className={`${s.muted} num`}>{fmt.bytes(b.size)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

export function ChangesPanel({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, error } = useApi<StorageJob[]>("/api/storage/operations?limit=50", { refresh: 10_000 });
  const rows = data?.filter((j) => j.kind !== "usage");
  return (
    <Panel title="History" meta={<span>Mounts, renames, setups and cleanups</span>} flush>
      {error && (
        <div className={s.pad}>
          <Notice tone="fault">{error.message}</Notice>
        </div>
      )}
      {!data && !error && (
        <div className={s.pad}>
          <Skeleton height={80} />
        </div>
      )}
      {rows && rows.length === 0 && <Empty title="No changes yet">When you mount, rename or set up a drive here, each step is recorded so you can see exactly what happened.</Empty>}
      {rows && rows.length > 0 && (
        <ul className={s.simpleRows} role="list">
          {rows.map((j) => (
            <li key={j.id}>
              <button type="button" className={s.jobRow} onClick={() => onOpen(j.id)}>
                <StateLine state={jobLine(j)} label={JOB_STATUS[j.status]} size={12} />
                <span className="truncate" title={j.title}>
                  {j.title}
                </span>
                <span className={s.muted}>{j.username ?? "Gluon"}</span>
                <Time ts={j.startedAt} className={`${s.muted} num`} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
