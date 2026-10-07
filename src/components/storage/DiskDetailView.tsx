"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Refresh, MoreHoriz } from "iconoir-react";
import { api, useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Page, PageHeader, Panel, Notice, Skeleton, DefinitionList, Empty } from "@/components/ui/Surface";
import { Button, IconButton } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { toast } from "@/components/ui/Toast";
import { TimeChart } from "@/components/charts/TimeChart";
import type { DiskView, SmartDetail, SmartSummary, VolumeView } from "@/lib/storage-types";
import { DiskSegments, DiskFacts, onForText } from "./DiskBar";
import { Legend } from "./StorageView";
import { Persistence, volumeMenu, type Row, type VolumeAction } from "./MountsTable";
import { MountDialog, UnmountDialog, PersistDialog, useRunningJob, errorText } from "./VolumeDialogs";
import { RenameFlow } from "./RenameFlow";
import { SetupWizard } from "./SetupWizard";
import { JobDialog } from "./JobProgress";
import { attributeName, attributeVerdict, diskLine, filesHref, MEDIA_SHORT, smartLine, smartPhrase, transportLabel, volumeLine } from "./shared";
import s from "./storage.module.css";

interface Detail {
  disk: DiskView;
  smart: SmartDetail;
}

function healthSentence(d: DiskView, fmt: ReturnType<typeof useFormat>): string {
  const sm = d.smart;
  if (!d.mediaPresent) return "Nothing is inserted.";
  if (!sm) return "Gluon hasn't read this drive's health yet. It checks every 30 minutes.";
  const bits: string[] = [];
  if (sm.state === "asleep") bits.push("Asleep; Gluon doesn't wake it just to check");
  else if (sm.state === "unavailable") bits.push(sm.message ?? "No health data");
  else bits.push(smartPhrase(sm));
  if (sm.temperature !== null && sm.state !== "asleep") bits.push(fmt.temp(sm.temperature));
  if (sm.powerOnHours) bits.push(`powered on for ${onForText(sm.powerOnHours)}`);
  return `${bits.join(" · ")}.`;
}

function HealthPanel({ disk, detail }: { disk: DiskView; detail: SmartDetail | undefined }) {
  const fmt = useFormat();
  const sm: SmartSummary | null = disk.smart;
  if (!disk.mediaPresent) return null;
  if (!sm) {
    return (
      <Panel title="Health">
        <Empty title="Not checked yet">Gluon reads each drive's own health report (SMART) every 30 minutes. Use “Check drive health” to read it now.</Empty>
      </Panel>
    );
  }
  if (sm.state === "unavailable" && !sm.readAt) {
    return (
      <Panel title="Health">
        <Notice title="This drive doesn't report its health">{sm.message ?? "Some USB adapters and card readers don't pass health data through. Gluon can still mount and measure it."}</Notice>
      </Panel>
    );
  }
  const items: [React.ReactNode, React.ReactNode][] = [
    ["Verdict", <StateLine key="v" state={smartLine(sm)} label={smartPhrase(sm)} />],
    [
      "Temperature",
      sm.temperature === null ? (
        <span className={s.muted}>Not reported</span>
      ) : (
        <span className="num">
          {fmt.temp(sm.temperature)}
          {sm.tempLimit ? <span className={s.muted}> · rated up to {fmt.temp(sm.tempLimit)}</span> : null}
          {sm.tempLimit && sm.temperature >= sm.tempLimit ? <b> · hotter than it's rated for</b> : null}
          {sm.state === "asleep" ? <span className={s.muted}> · last reading</span> : null}
        </span>
      ),
    ],
    ["Powered on", sm.powerOnHours !== null ? <span className="num">{fmt.duration(sm.powerOnHours * 3600, 2)}{sm.powerCycles !== null ? <span className={s.muted}> · started {sm.powerCycles.toLocaleString()} times</span> : null}</span> : "Not reported"],
    ["Bad sectors replaced", sm.reallocated !== null ? <span className="num">{sm.reallocated.toLocaleString()}{sm.reallocatedRising ? <b> · rising</b> : null}</span> : "Not reported"],
    ["Waiting / unreadable", sm.pending !== null || sm.uncorrectable !== null ? <span className="num">{sm.pending ?? "unknown"} / {sm.uncorrectable ?? "unknown"}</span> : "Not reported"],
  ];
  if (sm.wearPercent !== null) items.push(["Write endurance used", <span key="w" className="num">{Math.round(sm.wearPercent)}%</span>]);
  if (sm.nvme) items.push(["Spare space", <span key="n" className="num">{sm.nvme.availableSpare === null ? "Not reported" : `${sm.nvme.availableSpare}%`}{sm.nvme.availableSpareThreshold === null ? "" : ` (warns below ${sm.nvme.availableSpareThreshold}%)`}</span>]);
  if (sm.lastSelfTest) items.push(["Last self-test", `${sm.lastSelfTest.type}: ${sm.lastSelfTest.status}`]);
  items.push(["Checked", sm.readAt ? <Time key="c" ts={sm.readAt} /> : <Time key="c" ts={sm.checkedAt} />]);
  return (
    <Panel title="Health" meta={detail?.firmware ? <span>firmware {detail.firmware}</span> : undefined}>
      <div className={s.stack}>
        {sm.state === "asleep" && <p className={s.muted}>The drive is spun down. These are its last readings; Gluon won't wake it just to look.</p>}
        {sm.notes.length > 0 && (
          <ul className={s.plainList}>
            {sm.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
        <DefinitionList items={items} />
      </div>
    </Panel>
  );
}

function HistoryPanel({ detail }: { detail: SmartDetail | undefined }) {
  const fmt = useFormat();
  const h = detail?.history ?? [];
  const temp = h.filter((x) => x.temperature !== null).map((x) => [x.at, x.temperature!] as [number, number]);
  const realloc = h.filter((x) => x.reallocated !== null).map((x) => [x.at, x.reallocated!] as [number, number]);
  const pending = h.filter((x) => x.pending !== null).map((x) => [x.at, x.pending!] as [number, number]);
  return (
    <Panel title="Last 90 days" className={s.span2}>
      {!detail ? (
        <Skeleton height={150} />
      ) : h.length < 2 ? (
        <Empty title="Not enough history yet">Gluon records the drive's temperature and sector counts every 30 minutes while it's awake. Charts appear after a few readings.</Empty>
      ) : (
        <div className={s.charts}>
          <div>
            <div className={s.chartHead}>
              <span className="label">Temperature</span>
              {temp.length > 0 && <strong className="num">{fmt.temp(temp[temp.length - 1]![1])}</strong>}
            </div>
            <TimeChart series={[{ key: "t", label: "Temperature", points: temp, area: true }]} format={(v) => fmt.temp(v)} formatTime={(t) => fmt.date(t)} windowMs={90 * 86_400_000} height={150} label="Drive temperature over 90 days" />
          </div>
          <div>
            <div className={s.chartHead}>
              <span className="label">Bad and waiting sectors</span>
              {realloc.length > 0 && <strong className="num">{realloc[realloc.length - 1]![1].toLocaleString()}</strong>}
            </div>
            <TimeChart
              series={[
                { key: "r", label: "Replaced", points: realloc },
                { key: "p", label: "Waiting", points: pending, tone: "attn" },
              ]}
              format={(v) => Math.round(v).toLocaleString()}
              formatTime={(t) => fmt.date(t)}
              windowMs={90 * 86_400_000}
              height={150}
              label="Replaced and waiting sectors over 90 days"
            />
          </div>
        </div>
      )}
    </Panel>
  );
}

function AttributesPanel({ disk, detail }: { disk: DiskView; detail: SmartDetail | undefined }) {
  if (!detail || detail.attributes.length === 0) return null;
  const known = !!disk.smart?.known;
  return (
    <Panel title="Everything the drive reports" meta={<span>{known ? "SMART attributes" : "SMART attributes · this model isn't in smartctl's database, so names are guesses"}</span>} flush className={s.span2}>
      <div className={s.attrTable} role="table" aria-label="SMART attributes">
        <div className={`${s.attrRow} ${s.tHead}`} role="row">
          <span role="columnheader">What</span>
          <span role="columnheader">Verdict</span>
          <span role="columnheader" className={s.num}>
            Value
          </span>
          <span role="columnheader" className={s.num}>
            Limit
          </span>
          <span role="columnheader">Raw</span>
        </div>
        {detail.attributes.map((a) => {
          const v = attributeVerdict(a, known, disk.media === "hdd");
          return (
            <div key={a.id} role="row" className={s.attrRow} data-tone={v.tone}>
              <span role="cell" className={s.attrName}>
                <span>{attributeName(a)}</span>
                <span className={`${s.sub} mono`}>
                  {a.id} {a.name}
                </span>
              </span>
              <span role="cell">
                {v.tone === "fault" ? <StateLine state="unhealthy" size={12} label={v.text} /> : v.tone === "attention" ? <StateLine state="attention" size={12} label={v.text} /> : <span className={s.muted}>{v.text}</span>}
              </span>
              <span role="cell" className={`${s.num} num`}>
                {a.value ?? "None"}
              </span>
              <span role="cell" className={`${s.num} num ${s.muted}`}>
                {a.thresh ?? "None"}
              </span>
              <span role="cell" className={`mono ${s.attrRaw}`} title={a.raw}>
                {a.raw}
              </span>
            </div>
          );
        })}
      </div>
      <p className={s.hint + " " + s.pad}>“Value” is the maker's score (higher is better); the drive is in trouble when it falls to the limit. “Raw” is the actual count.</p>
    </Panel>
  );
}

function roleText(v: VolumeView): string {
  if (v.role === "filesystem") return v.fstype ?? "filesystem";
  return { swap: "swap", "lvm-member": "LVM volume", "raid-member": "RAID member", encrypted: "encrypted", "bios-boot": "BIOS boot", unformatted: "unformatted", other: v.fstype ?? "other" }[v.role];
}

function PartitionsPanel({ disk, onAction, busy }: { disk: DiskView; onAction: (a: VolumeAction, r: Row) => void; busy: boolean }) {
  const fmt = useFormat();
  const router = useRouter();
  const vols = [...disk.partitions, ...(disk.wholeDisk ? [disk.wholeDisk] : [])];
  const rows: { v: VolumeView; depth: number }[] = [];
  const walk = (v: VolumeView, depth: number) => {
    rows.push({ v, depth });
    v.children.forEach((c) => walk(c, depth + 1));
  };
  vols.forEach((v) => walk(v, 0));
  return (
    <Panel title={disk.wholeDisk ? "Filesystem" : "Partitions"} meta={disk.partitionTable ? <span>{disk.partitionTable.toUpperCase()} partition table</span> : undefined} flush className={s.span2}>
      {rows.length === 0 ? (
        <Empty title={disk.mediaPresent ? "Nothing on it" : "Nothing inserted"}>{disk.mediaPresent ? "This disk has no partitions or filesystem. Set it up to use it for storage." : "Insert a card or drive and it appears here."}</Empty>
      ) : (
        <ul className={s.parts} role="list">
          {rows.map(({ v, depth }) => {
            const items = volumeMenu(v, disk, onAction, busy, router);
            return (
              <li key={v.name} className={s.part} style={{ paddingLeft: 18 + depth * 22 }}>
                <StateLine state={volumeLine(v, disk)} />
                <div className={s.partMain}>
                  <p className={s.partName}>
                    {v.primaryMount ? (
                      <Link href={filesHref(v.primaryMount)} className="mono">
                        {v.primaryMount}
                      </Link>
                    ) : (
                      <span>{v.swapActive ? "Swap (on)" : v.label ? `“${v.label}”` : v.role === "filesystem" ? "Not mounted" : roleText(v)}</span>
                    )}
                  </p>
                  <p className={s.sub}>
                    <span className="mono">{v.name}</span> · <span className="num">{fmt.bytes(v.size)}</span> · {roleText(v)}
                    {v.label && v.primaryMount ? ` · “${v.label}”` : ""}
                    {v.uuid ? (
                      <>
                        {" · "}
                        <span className="mono" title={v.uuid}>
                          {v.uuid.slice(0, 8)}…
                        </span>
                      </>
                    ) : null}
                    {v.mounts.filter((m) => m.bind).length > 0 && (
                      <>
                        {" · also at "}
                        <span className="mono">{v.mounts.filter((m) => m.bind).map((m) => m.target).join(", ")}</span>
                      </>
                    )}
                  </p>
                  {v.usedBy.length > 0 && (
                    <p className={s.sub}>
                      Used by{" "}
                      {[...new Map(v.usedBy.map((u) => [u.appId, u])).values()].map((u, i) => (
                        <React.Fragment key={u.appId}>
                          {i > 0 && ", "}
                          <Link href={`/apps/${encodeURIComponent(u.appId)}`}>{u.app}</Link>
                        </React.Fragment>
                      ))}
                    </p>
                  )}
                </div>
                <div className={s.partSide}>
                  {v.usage && (
                    <span className={`${s.sub} num`}>
                      {fmt.bytes(v.usage.used)} used · {fmt.bytes(v.usage.avail)} free
                    </span>
                  )}
                  {v.primaryMount && <Persistence vol={v} disk={disk} onPersist={() => onAction("persist", { disk, vol: v })} disabled={busy} />}
                  {!v.primaryMount && v.role === "filesystem" && !disk.system && (
                    <Button size="sm" disabled={busy} onClick={() => onAction("mount", { disk, vol: v })}>
                      Mount…
                    </Button>
                  )}
                </div>
                <div className={s.actions}>
                  {items.length > 0 && (
                    <Menu
                      trigger={
                        <IconButton label={`${v.primaryMount ?? v.name} actions`} size="sm">
                          <MoreHoriz />
                        </IconButton>
                      }
                      items={items}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export function DiskDetailView({ initial }: { initial: Detail }) {
  const fmt = useFormat();
  const router = useRouter();
  const params = useSearchParams();
  const jobParam = params.get("job");
  const url = `/api/storage/disks/${encodeURIComponent(initial.disk.id)}`;
  const { data = initial, error, mutate } = useApi<Detail>(url, { refresh: 15_000, fallbackData: initial });
  const disk = data.disk;
  const running = useRunningJob();
  const busy = !!running;
  const [checking, setChecking] = React.useState(false);
  const [mount, setMount] = React.useState<Row | null>(null);
  const [unmount, setUnmount] = React.useState<string | null>(null);
  const [persist, setPersist] = React.useState<Row | null>(null);
  const [rename, setRename] = React.useState<string | null>(null);
  const [setup, setSetup] = React.useState<DiskView | null>(null);
  const [jobOpen, setJobOpen] = React.useState<string | null>(null);

  // ?job= reattaches after a reload. Only on arrival: flows opened here manage the param themselves.
  const arrivedWithJob = React.useRef(jobParam);
  React.useEffect(() => {
    if (arrivedWithJob.current) setJobOpen(arrivedWithJob.current);
  }, []);

  const refresh = React.useCallback(() => void mutate(), [mutate]);

  const act = (a: VolumeAction, r: Row) => {
    if (a === "usage" && r.vol.primaryMount) router.push(`/storage?tab=space&usage=${encodeURIComponent(r.vol.primaryMount)}`);
    else if (a === "mount") setMount(r);
    else if (a === "unmount" && r.vol.primaryMount) setUnmount(r.vol.primaryMount);
    else if (a === "persist") setPersist(r);
    else if (a === "rename" && r.vol.primaryMount) setRename(r.vol.primaryMount);
  };

  async function checkHealth() {
    setChecking(true);
    try {
      await api.post("/api/storage/smart", { disk: disk.id });
      await mutate();
      toast.success(disk.smart?.state === "asleep" ? "It's still asleep, so Gluon left it alone." : "Health checked.");
    } catch (e) {
      const m = errorText(e);
      if (m) toast.error(m);
    } finally {
      setChecking(false);
    }
  }

  const closeJob = () => {
    setJobOpen(null);
    router.replace(`/storage/${encodeURIComponent(disk.id)}`, { scroll: false });
    refresh();
  };

  const canSetup = (disk.state === "unused" || disk.state === "empty") && !disk.system && disk.mediaPresent;
  const identity: [React.ReactNode, React.ReactNode][] = [
    ["Device", <span key="d" className="mono">{disk.path}</span>],
    ...(disk.byId ? ([["Stable name", <span key="b" className="mono truncate" title={disk.byId}>{disk.byId.replace("/dev/disk/by-id/", "")}</span>]] as [React.ReactNode, React.ReactNode][]) : []),
    ["Model", disk.model ?? "Not reported"],
    ...(disk.vendor ? ([["Maker", disk.vendor]] as [React.ReactNode, React.ReactNode][]) : []),
    ["Serial", <span key="s" className="mono">{disk.serial ?? "Not reported"}</span>],
    ["Size", <span key="z" className="num">{disk.mediaPresent ? `${fmt.bytes(disk.size)} (${disk.size.toLocaleString()} bytes)` : "No disk inserted"}</span>],
    ["Kind", [MEDIA_SHORT[disk.media], transportLabel(disk), disk.removable ? "removable" : null].filter(Boolean).join(" · ")],
    ["Role", disk.system ? disk.systemReason ?? "System disk" : disk.state === "in-use" ? "Data" : disk.state === "no-media" ? "Empty reader" : "Not in use"],
  ];

  return (
    <Page>
      <PageHeader
        back={{ href: "/storage", label: "Storage" }}
        title={
          <>
            {disk.title}
            {disk.model && <span className={s.titleModel}> {disk.model}</span>}
          </>
        }
        summary={
          <span className={s.headerSummary}>
            <StateLine state={diskLine(disk)} label={disk.summary} />
            <span className={s.muted}>{healthSentence(disk, fmt)}</span>
          </span>
        }
        actions={
          <>
            {disk.mediaPresent && !disk.removable && (
              <Button icon={<Refresh />} loading={checking} onClick={() => void checkHealth()}>
                Check health
              </Button>
            )}
            {canSetup && (
              <Button variant="primary" disabled={busy} onClick={() => setSetup(disk)}>
                Set up this disk…
              </Button>
            )}
          </>
        }
      />

      {error && (
        <div className={s.banner}>
          <Notice tone="fault">{error.message} The details below may be out of date.</Notice>
        </div>
      )}
      {running && (
        <div className={s.banner}>
          <Notice
            title={`${running.title} is in progress`}
            action={
              <Button size="sm" onClick={() => setJobOpen(running.id)}>
                Watch
              </Button>
            }
          >
            Other changes to drives wait until it's done.
          </Notice>
        </div>
      )}
      {disk.smart?.state === "failing" && (
        <div className={s.banner}>
          <Notice tone="fault" title="This drive is failing">
            Copy anything important off it now and plan to replace it. {disk.smart.notes[0] ?? ""}
          </Notice>
        </div>
      )}
      {canSetup && (
        <div className={s.banner}>
          <Notice title={disk.state === "empty" ? "This disk is blank" : "Nothing on this disk is in use"}>
            Set it up to add {fmt.bytes(disk.size)} of storage. Gluon erases it, formats it and keeps it mounted after restarts.
          </Notice>
        </div>
      )}

      <div className={s.grid}>
        <Panel className={s.span2} flush>
          <div className={s.detailBar}>
            <DiskSegments disk={disk} tall />
            <DiskFacts disk={disk} />
          </div>
          <Legend />
        </Panel>

        <PartitionsPanel disk={disk} onAction={act} busy={busy} />

        <Panel title="Identity">
          <DefinitionList items={identity} />
        </Panel>

        <HealthPanel disk={disk} detail={data.smart} />

        {disk.mediaPresent && !disk.removable && <HistoryPanel detail={data.smart} />}
        <AttributesPanel disk={disk} detail={data.smart} />
      </div>

      <MountDialog vol={mount?.vol ?? null} disk={mount?.disk ?? null} onClose={() => setMount(null)} onDone={refresh} />
      <UnmountDialog target={unmount} onClose={() => setUnmount(null)} onDone={refresh} />
      <PersistDialog target={persist?.vol.primaryMount ?? null} hdd={disk.rotational} users={persist?.vol.usedBy} onClose={() => setPersist(null)} onDone={refresh} />
      <RenameFlow from={rename} onClose={() => setRename(null)} onDone={refresh} />
      <SetupWizard disk={setup} onClose={() => setSetup(null)} onDone={refresh} />
      <JobDialog id={jobOpen} onClose={closeJob} />
    </Page>
  );
}
