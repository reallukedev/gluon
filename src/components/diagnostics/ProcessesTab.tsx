"use client";
import * as React from "react";
import Link from "next/link";
import { Collapsible } from "@base-ui/react/collapsible";
import { Pause, Play, Search } from "iconoir-react";
import type { ProcessInfo, ProcessSnapshot } from "@/lib/diagnostics-types";
import { useStream } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Panel, Skeleton, Empty, Notice } from "@/components/ui/Surface";
import { Segmented, Checkbox } from "@/components/ui/Field";
import { IconButton } from "@/components/ui/Button";
import { UsageBar } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import { LiveStatus } from "./LiveStatus";
import { Faceplate } from "./Faceplate";
import s from "./diagnostics.module.css";

export function ProcessesTab() {
  const [snap, setSnap] = React.useState<ProcessSnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [paused, setPaused] = React.useState(false);
  const [by, setBy] = React.useState<"cpu" | "mem">("cpu");
  const [q, setQ] = React.useState("");
  const [kernel, setKernel] = React.useState(false);
  const [open, setOpen] = React.useState<number | null>(null);
  const pausedRef = React.useRef(paused);
  pausedRef.current = paused;

  const status = useStream("/api/diagnostics/processes", {
    processes: (d) => {
      setError(null);
      if (!pausedRef.current) setSnap(d as ProcessSnapshot);
    },
    error: (d) => setError((d as { message: string }).message),
  });

  const term = q.trim().toLowerCase();
  const list = (snap ? (by === "cpu" ? snap.byCpu : snap.byMem) : []).filter(
    (p) => (kernel || !p.kernel) && (!term || `${p.name} ${p.cmd} ${p.ownerLabel} ${p.user} ${p.pid}`.toLowerCase().includes(term)),
  );

  return (
    <div className={s.stack}>
      {error && <Notice tone="fault" title="The process list stopped updating">{error}</Notice>}
      <Faceplate snap={snap} />

      <div className={s.toolbar}>
        <label className={s.filter}>
          <Search aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, command, app or user" aria-label="Filter processes" spellCheck={false} />
        </label>
        <Segmented aria-label="Sort by" value={by} onChange={setBy} options={[{ value: "cpu", label: "Most CPU" }, { value: "mem", label: "Most memory" }]} />
        <Checkbox checked={kernel} onChange={setKernel}>
          Include the kernel&apos;s own work
        </Checkbox>
        <span className={s.spacer} />
        <LiveStatus status={status} paused={paused} />
        <IconButton label={paused ? "Resume" : "Pause"} size="sm" onClick={() => setPaused((p) => !p)}>
          {paused ? <Play /> : <Pause />}
        </IconButton>
      </div>

      <Panel flush>
        {!snap ? (
          <div className={s.pad}>
            <Skeleton height={360} />
          </div>
        ) : list.length === 0 ? (
          <Empty title="Nothing matches">Only the 30 busiest processes are listed; try a broader filter.</Empty>
        ) : (
          <div role="table" aria-label="Processes" className={s.table}>
            <div role="row" className={`${s.head} ${s.procGrid}`}>
              <span role="columnheader" className={s.end}>PID</span>
              <span role="columnheader">Process</span>
              <span role="columnheader">Belongs to</span>
              <span role="columnheader" className={s.end}>CPU</span>
              <span role="columnheader" className={s.end}>Memory</span>
              <span role="columnheader">State</span>
            </div>
            {list.map((p) => (
              <ProcRow key={p.pid} p={p} by={by} open={open === p.pid} onToggle={() => setOpen(open === p.pid ? null : p.pid)} />
            ))}
          </div>
        )}
      </Panel>
      <p className={s.faint}>The 30 busiest programs, updated every few seconds. CPU is a share of one thread, like top: 200% means two threads are fully busy.</p>
    </div>
  );
}

function ProcRow({ p, by, open, onToggle }: { p: ProcessInfo; by: "cpu" | "mem"; open: boolean; onToggle: () => void }) {
  const fmt = useFormat();
  const owner =
    p.owner.kind === "container" ? (
      p.owner.appId ? (
        <Link href={`/apps/${encodeURIComponent(p.owner.appId)}`}>{p.ownerLabel}</Link>
      ) : (
        p.ownerLabel
      )
    ) : p.owner.kind === "service" ? (
      <Link href={`/system?tab=services&unit=${encodeURIComponent(p.owner.unit)}`}>{p.ownerLabel}</Link>
    ) : (
      <span className={s.faint}>{p.kernel ? "Kernel" : "This machine"}</span>
    );
  return (
    <Collapsible.Root open={open} onOpenChange={onToggle} render={<div role="row" />} className={s.procRow} data-open={open ? "" : undefined}>
      <div className={`${s.procGrid} ${s.procLine}`}>
        <span role="cell" className={`${s.end} num mono`}>{p.pid}</span>
        <span role="cell" className={s.cellMain}>
          <Collapsible.Trigger className={s.procName}>{p.name}</Collapsible.Trigger>
          <span className={`${s.cellSub} mono ${s.oneLine}`} title={p.cmd}>
            {p.cmd}
          </span>
          <span className={`${s.cellSub} ${s.ownerInline}`}>{p.ownerLabel}</span>
        </span>
        <span role="cell" className={s.cellText}>{owner}</span>
        <span role="cell" className={`${s.end} ${s.meter}`}>
          <span className="num">{fmt.percent(p.cpuCore, 1)}</span>
          {by === "cpu" && <UsageBar value={Math.min(100, p.cpuCore)} label={`${p.name} CPU`} />}
        </span>
        <span role="cell" className={`${s.end} ${s.meter}`}>
          <span className="num">{fmt.bytes(p.memBytes)}</span>
          {by === "mem" && <UsageBar value={p.memPct} max={100} label={`${p.name} memory`} />}
        </span>
        <span role="cell" className={s.cellText} data-state={p.state}>
          {p.stateLabel}
        </span>
      </div>
      <Collapsible.Panel className={s.procPanel} data-motion-gentle="">
        <dl className={s.procMore}>
          <dt>Command</dt>
          <dd className="mono">{p.cmd}</dd>
          <dt>User</dt>
          <dd>{p.user}</dd>
          <dt>Threads</dt>
          <dd className="num">{p.threads}</dd>
          <dt>Parent</dt>
          <dd className="num mono">{p.ppid}</dd>
          <dt>Started</dt>
          <dd>{p.startedAt ? <Time ts={p.startedAt} kind="dateTime" /> : "Not known"}</dd>
          <dt>Share of machine</dt>
          <dd className="num">
            {fmt.percent(p.cpu, 1)} CPU · {fmt.percent(p.memPct, 1)} memory
          </dd>
        </dl>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
