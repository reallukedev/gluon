"use client";
import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Refresh } from "iconoir-react";
import type { Finding } from "@/server/findings";
import { api, useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Page, PageHeader, Panel, Notice, Empty } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { Tabs } from "@/components/ui/Tabs";
import { toast } from "@/components/ui/Toast";
import { Time } from "@/components/ui/Time";
import { NeedsYou } from "@/components/status/NeedsYou";
import type { DiskView, Inventory } from "@/lib/storage-types";
import { DiskRow } from "./DiskBar";
import { MountsTable, mountedRows, type Row, type VolumeAction } from "./MountsTable";
import { UsagePanel, type MountChoice } from "./UsagePanel";
import { CleanupPanel } from "./CleanupPanel";
import { FstabPanel, ChangesPanel } from "./FstabPanel";
import { MountDialog, UnmountDialog, PersistDialog, useRunningJob, errorText } from "./VolumeDialogs";
import { RenameFlow } from "./RenameFlow";
import { JobDialog } from "./JobProgress";
import { allVolumes, notPermanent } from "./shared";
import s from "./storage.module.css";

export type StorageTab = "disks" | "space" | "fstab" | "changes";

export function storageSummary(inv: Inventory, fmt: ReturnType<typeof useFormat>): React.ReactNode {
  const disks = inv.disks.filter((d) => d.mediaPresent);
  const seen = new Set<string>();
  let free = 0;
  for (const d of disks)
    for (const v of allVolumes(d))
      if (v.usage && v.primaryMount && !seen.has(v.majMin || v.path)) {
        seen.add(v.majMin || v.path);
        free += v.usage.avail;
      }
  const loose = disks.flatMap((d) => allVolumes(d).filter((v) => notPermanent(v, d)));
  const failing = disks.filter((d) => d.smart?.state === "failing");
  const wearing = disks.filter((d) => d.smart?.state === "warning");
  const unused = disks.filter((d) => (d.state === "unused" || d.state === "empty") && !d.removable && !d.inFstab);
  const problems: string[] = [];
  for (const d of failing) problems.push(`The ${d.title} is failing.`);
  if (loose.length) problems.push(loose.length === 1 ? `${loose[0]!.primaryMount} won't come back after a restart.` : `${loose.length} drives won't come back after a restart.`);
  for (const d of wearing) problems.push(`The ${d.title} is showing wear.`);
  const quiet = unused.map((d) => `The ${d.title} isn't being used.`);
  return (
    <>
      {fmt.plural(disks.length, "disk")}, <span className="num">{fmt.bytes(free)}</span> free.{" "}
      {problems.length > 0 && <b>{problems.join(" ")} </b>}
      {quiet.join(" ")}
    </>
  );
}

/** Every mounted filesystem people keep things on, by a name a person recognises. */
export function mountChoices(disks: DiskView[]): MountChoice[] {
  const rows = mountedRows(disks).filter((r) => r.vol.primaryMount && r.vol.role === "filesystem" && !r.vol.primaryMount.startsWith("/boot"));
  const perDisk = new Map<string, number>();
  for (const r of rows) perDisk.set(r.disk.id, (perDisk.get(r.disk.id) ?? 0) + 1);
  return rows.map((r) => {
    const m = r.vol.primaryMount!;
    const alone = perDisk.get(r.disk.id) === 1;
    return { path: m, label: alone ? `${r.disk.title} · ${m}` : `${m} on the ${r.disk.title}`, short: alone ? r.disk.title : m, pct: r.vol.usage?.pct ?? 0 };
  });
}

export function StorageView({ initial, tab, usage }: { initial: Inventory; tab: StorageTab; usage: string | null }) {
  const fmt = useFormat();
  const router = useRouter();
  const params = useSearchParams();
  const jobParam = params.get("job");
  const { data: inv = initial, mutate } = useApi<Inventory>("/api/storage", { refresh: 15_000, fallbackData: initial });
  const { data: findings, mutate: mutateFindings } = useApi<Finding[]>("/api/findings", { refresh: 30_000 });
  const running = useRunningJob();
  const [checking, setChecking] = React.useState(false);
  const [mount, setMount] = React.useState<Row | null>(null);
  const [unmount, setUnmount] = React.useState<string | null>(null);
  const [persist, setPersist] = React.useState<Row | null>(null);
  const [rename, setRename] = React.useState<string | null>(null);
  const [jobOpen, setJobOpen] = React.useState<string | null>(null);

  // ?job= reattaches after a reload. Only on arrival: flows opened here manage the param themselves.
  const arrivedWithJob = React.useRef(jobParam);
  React.useEffect(() => {
    if (arrivedWithJob.current) setJobOpen(arrivedWithJob.current);
  }, []);

  const refresh = React.useCallback(() => {
    void mutate();
    void mutateFindings();
  }, [mutate, mutateFindings]);

  const storageFindings = (findings ?? []).filter((f) => f.kind.startsWith("storage"));
  const busy = !!running;

  const act = (a: VolumeAction, r: Row) => {
    if (a === "usage" && r.vol.primaryMount) router.push(`/storage?tab=space&usage=${encodeURIComponent(r.vol.primaryMount)}`, { scroll: false });
    else if (a === "mount") setMount(r);
    else if (a === "unmount" && r.vol.primaryMount) setUnmount(r.vol.primaryMount);
    else if (a === "persist") setPersist(r);
    else if (a === "rename" && r.vol.primaryMount) setRename(r.vol.primaryMount);
  };

  async function checkHealth() {
    setChecking(true);
    try {
      await api.post("/api/storage/smart", {});
      await mutate();
      toast.success("Drive health checked. Sleeping drives were left asleep.");
    } catch (e) {
      const m = errorText(e);
      if (m) toast.error(m);
    } finally {
      setChecking(false);
    }
  }

  const closeJob = () => {
    setJobOpen(null);
    const next = new URLSearchParams(params.toString());
    next.delete("job");
    router.replace(next.toString() ? `/storage?${next}` : "/storage", { scroll: false });
    refresh();
  };

  const mounts = mountChoices(inv.disks);

  return (
    <Page>
      <PageHeader
        title="Storage"
        summary={storageSummary(inv, fmt)}
        actions={
          <Button icon={<Refresh />} loading={checking} onClick={() => void checkHealth()}>
            Check drive health
          </Button>
        }
      />

      <Tabs
        value={tab}
        hrefFor={(v) => (v === "disks" ? "/storage" : `/storage?tab=${v}`)}
        items={[
          { value: "disks", label: "Disks" },
          { value: "space", label: "Space" },
          { value: "fstab", label: "At startup" },
          { value: "changes", label: "History" },
        ]}
        aria-label="Storage sections"
      />

      <div className={s.tabBody}>
        {running && (
          <div className={s.banner}>
            <Notice
              tone="neutral"
              title={`${running.title} is in progress`}
              action={
                <Button size="sm" onClick={() => setJobOpen(running.id)}>
                  Watch
                </Button>
              }
            >
              Other changes to drives wait until it's done. Started <Time ts={running.startedAt} />.
            </Notice>
          </div>
        )}

        {storageFindings.length > 0 && (
          <Panel title="Needs you" meta={<span className="num">{storageFindings.length} open</span>} flush className={s.needsPanel}>
            <NeedsYou findings={storageFindings} onChange={refresh} checkedAt={inv.generatedAt} />
          </Panel>
        )}

        {tab === "disks" && (
          <div className={s.stack}>
            {inv.warnings.map((w) => (
              <Notice key={w} tone="attention">
                {w}
              </Notice>
            ))}
            <Panel title="Disks" meta={inv.smartCheckedAt ? <span>Health checked <Time ts={inv.smartCheckedAt} /></span> : <span>Health check pending</span>} flush>
              {inv.disks.length === 0 ? (
                <Empty title="No disks found">Gluon couldn't list the disks on this server. If this keeps happening, check that lsblk works on the host.</Empty>
              ) : (
                <ul className={s.disks} role="list">
                  {inv.disks.map((d: DiskView) => (
                    <DiskRow key={d.id} disk={d} />
                  ))}
                </ul>
              )}
              <Legend />
            </Panel>
            <Panel title="Mounted" meta={<span className="num">{mountedRows(inv.disks).filter((r) => r.vol.primaryMount).length} filesystems</span>} flush>
              <MountsTable disks={inv.disks} onAction={act} busy={busy} />
            </Panel>
          </div>
        )}
        {tab === "space" && (
          <div className={s.grid}>
            <div className={s.span2}>
              <UsagePanel mounts={mounts.length ? mounts : [{ path: "/", label: "/" }]} initialPath={usage} onChanged={refresh} />
            </div>
            <CleanupPanel onChanged={refresh} />
          </div>
        )}
        {tab === "fstab" && <FstabPanel disks={inv.disks} busy={busy} onPersist={(r) => setPersist(r)} />}
        {tab === "changes" && <ChangesPanel onOpen={(id) => setJobOpen(id)} />}
      </div>

      <MountDialog vol={mount?.vol ?? null} disk={mount?.disk ?? null} onClose={() => setMount(null)} onDone={refresh} />
      <UnmountDialog target={unmount} onClose={() => setUnmount(null)} onDone={refresh} />
      <PersistDialog target={persist?.vol.primaryMount ?? null} hdd={!!persist?.disk.rotational} users={persist?.vol.usedBy} onClose={() => setPersist(null)} onDone={refresh} />
      <RenameFlow from={rename} onClose={() => setRename(null)} onDone={refresh} />
      <JobDialog id={jobOpen} onClose={closeJob} />
    </Page>
  );
}

/** How to read the bars. */
export function Legend() {
  return (
    <p className={s.legend}>
      <span>
        <i className={s.legendFill} aria-hidden /> used
      </span>
      <span>
        <i className={s.legendMark} data-state="attention" aria-hidden /> not kept after a restart
      </span>
      <span>
        <i className={s.legendMark} data-state="unhealthy" aria-hidden /> failing or read-only
      </span>
      <span>
        <i className={s.legendMark} data-state="paused" aria-hidden /> asleep
      </span>
      <span>
        <i className={s.legendMark} data-state="stopped" aria-hidden /> not in use
      </span>
    </p>
  );
}
