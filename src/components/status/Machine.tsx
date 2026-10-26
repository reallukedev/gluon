"use client";
import { useLive } from "@/lib/client/live";
import { useFormat } from "@/components/PrefsProvider";
import { TimeChart } from "@/components/charts/TimeChart";
import { UsageBar, Skeleton } from "@/components/ui/Surface";
import type { FsUsage } from "@/server/metrics/sampler";
import s from "./status.module.css";

/** CPU, memory, network and temperature, live, ending at "now". */
export function MachineVitals({ compact }: { compact?: boolean }) {
  const { host, status } = useLive();
  const fmt = useFormat();
  const last = host.at(-1);
  const window = 5 * 60_000;

  if (!last) {
    return (
      <div className={s.vitals}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={s.vital}>
            <Skeleton width={80} height={11} />
            <Skeleton width={70} height={26} style={{ marginTop: 10 }} />
            <Skeleton height={compact ? 28 : 56} style={{ marginTop: 12 }} />
          </div>
        ))}
      </div>
    );
  }

  const cpu = host.map((h) => [h.t, h.cpu] as [number, number]);
  const mem = host.map((h) => [h.t, h.mem.used] as [number, number]);
  const rx = host.map((h) => [h.t, h.net.rx] as [number, number]);
  const tx = host.map((h) => [h.t, h.net.tx] as [number, number]);
  const t = (ts: number) => fmt.time(ts, true);

  return (
    <div className={s.vitals} data-offline={status === "offline" ? "" : undefined}>
      <div className={s.vital}>
        <span className="label">Processor</span>
        <strong className={`${s.vitalValue} num`}>
          {Math.round(last.cpu)}
          <small>%</small>
        </strong>
        <span className={`${s.vitalSub} num`}>
          load {last.load[0].toFixed(2)}
          {last.temp !== null && ` · ${fmt.temp(last.temp)}`}
        </span>
        <TimeChart series={[{ key: "cpu", label: "CPU", points: cpu, area: true }]} yMax={100} format={(v) => `${Math.round(v)}%`} formatTime={t} windowMs={window} live compact height={compact ? 32 : 56} label="Processor use, last 5 minutes" />
      </div>
      <div className={s.vital}>
        <span className="label">Memory</span>
        <strong className={`${s.vitalValue} num`}>
          {fmt.bytes(last.mem.used, 1).split(" ")[0]}
          <small>
            {" "}
            {fmt.bytes(last.mem.used, 1).split(" ")[1]} of {fmt.bytes(last.mem.total, 0)}
          </small>
        </strong>
        <span className={`${s.vitalSub} num`}>{fmt.bytes(last.mem.available)} free</span>
        <TimeChart series={[{ key: "mem", label: "Memory", points: mem, area: true }]} yMax={last.mem.total} format={(v) => fmt.bytes(v)} formatTime={t} windowMs={window} live compact height={compact ? 32 : 56} label="Memory use, last 5 minutes" />
      </div>
      <div className={s.vital}>
        <span className="label">Network</span>
        <strong className={`${s.vitalValue} num`}>
          {fmt.rate(last.net.rx).split(" ")[0]}
          <small> {fmt.rate(last.net.rx).split(" ")[1]} in</small>
        </strong>
        <span className={`${s.vitalSub} num`}>{fmt.rate(last.net.tx)} out</span>
        <TimeChart
          series={[
            { key: "rx", label: "In", points: rx, area: true },
            { key: "tx", label: "Out", points: tx, tone: "muted" },
          ]}
          format={(v) => fmt.rate(v)}
          formatTime={t}
          windowMs={window}
          live
          compact
          height={compact ? 32 : 56}
          label="Network traffic, last 5 minutes"
        />
      </div>
      <div className={s.vital}>
        <span className="label">Disks</span>
        <strong className={`${s.vitalValue} num`}>
          {fmt.rate(last.disk.read + last.disk.write).split(" ")[0]}
          <small> {fmt.rate(last.disk.read + last.disk.write).split(" ")[1]}</small>
        </strong>
        <span className={`${s.vitalSub} num`}>
          {fmt.rate(last.disk.read)} read · {fmt.rate(last.disk.write)} write
        </span>
        <TimeChart
          series={[
            { key: "w", label: "Write", points: host.map((h) => [h.t, h.disk.write] as [number, number]), area: true },
            { key: "r", label: "Read", points: host.map((h) => [h.t, h.disk.read] as [number, number]), tone: "muted" },
          ]}
          format={(v) => fmt.rate(v)}
          formatTime={t}
          windowMs={window}
          live
          compact
          height={compact ? 32 : 56}
          label="Disk activity, last 5 minutes"
        />
      </div>
    </div>
  );
}

export function StorageBars({ filesystems, attentionMounts }: { filesystems: FsUsage[]; attentionMounts: Set<string> }) {
  const fmt = useFormat();
  const rows = filesystems.filter((f) => f.size > 512 * 1024 * 1024);
  return (
    <ul className={s.fsList} role="list">
      {rows.map((f) => (
        <li key={f.mount} className={s.fsRow}>
          <div className={s.fsHead}>
            <span className={`${s.fsName} mono`}>{f.mount}</span>
            <span className={`${s.fsVal} num`} data-attn={attentionMounts.has(f.mount) ? "" : undefined}>
              {Math.round(f.pct)}% · {fmt.bytes(f.avail)} free
            </span>
          </div>
          <UsageBar value={f.pct} attention={85} fault={95} label={`${f.mount} ${Math.round(f.pct)}% used`} />
        </li>
      ))}
    </ul>
  );
}
