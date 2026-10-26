"use client";
import * as React from "react";
import Link from "next/link";
import type { MonitorDetail as Detail } from "@/lib/alerts-types";
import { statusHref } from "@/lib/settings-links";
import { useApi } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Notice, Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { TimeChart } from "@/components/charts/TimeChart";
import { checksToBuckets, monitorLine, ms, pct, Trace, TraceLegend } from "./monitorBits";
import s from "./alerts.module.css";

/** Everything about one monitor: uptime, the week at a glance, response times, outages, raw checks. */
export function MonitorDetailDialog({ id, open, onOpenChange, footer }: { id: string | null; open: boolean; onOpenChange: (o: boolean) => void; footer: (d: Detail) => React.ReactNode }) {
  const fmt = useFormat();
  const { data, error } = useApi<Detail>(open && id ? `/api/alerts/monitors/${encodeURIComponent(id)}` : null, { refresh: 30_000 });
  const d = data && data.id === id ? data : null;
  const st = d ? monitorLine(d) : null;
  const recent = React.useMemo(() => (d ? checksToBuckets(d.checks.slice(0, 120)) : []), [d]);
  const points = React.useMemo(
    () => (d ? d.checks.filter((c) => c.ok && c.latencyMs !== null).map((c) => [c.at, c.latencyMs!] as [number, number]).reverse() : []),
    [d],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="xwide" title={d?.name ?? "Monitor"} description={d ? <span className="mono">{d.target}</span> : undefined} footer={d ? footer(d) : undefined}>
      {error && !d ? (
        <Notice tone="fault" title="Couldn't load this monitor">
          {error.message}
        </Notice>
      ) : !d ? (
        <div className={s.detailGrid}>
          <Skeleton height={20} width="40%" />
          <Skeleton height={56} />
          <Skeleton height={140} />
        </div>
      ) : (
        <div className={s.detailGrid}>
          <div className={s.detailHead}>
            <StateLine state={st!.line} label={st!.label} size={18} />
            {d.since && (
              <span className={s.muted}>
                since <Time ts={d.since} kind="dateTime" />
              </span>
            )}
            {d.last && (
              <span className={s.muted}>
                last check <Time ts={d.last.at} />
                {d.last.status ? ` · answered ${d.last.status}` : ""}
                {d.last.latencyMs !== null ? ` in ${ms(d.last.latencyMs)}` : ""}
              </span>
            )}
            {d.findingId && <Link href={statusHref(d.findingId)}>See the problem on Status</Link>}
          </div>
          {d.last && !d.last.ok && d.last.error && (
            <Notice tone="fault" title="The last check failed">
              {d.last.error.charAt(0).toUpperCase() + d.last.error.slice(1)}.
            </Notice>
          )}

          <div className={s.figures}>
            {(
              [
                ["Last 24 hours", d.uptime.h24],
                ["7 days", d.uptime.d7],
                ["30 days", d.uptime.d30],
                ["90 days", d.uptime.d90],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className={s.figure}>
                <span className="label">{k}</span>
                <strong className="num">{pct(v)}</strong>
              </div>
            ))}
          </div>

          <div className={s.block}>
            <div className={s.blockHead}>
              <span className="label">Latest checks</span>
              <span className={`${s.muted} num`} style={{ fontSize: "var(--text-sm)" }}>
                {recent.length ? `last ${recent.length}, one line each` : ""}
              </span>
            </div>
            {recent.length ? <Trace buckets={recent} bucketMs={0} label={`${d.name}, latest checks`} tall /> : <p className={s.muted}>No checks yet.</p>}
          </div>

          <div className={s.block}>
            <div className={s.blockHead}>
              <span className="label">Last 7 days, by hour</span>
            </div>
            <Trace buckets={d.week} bucketMs={3_600_000} since={d.createdAt} label={`${d.name}, last 7 days`} tall />
            <TraceLegend />
          </div>

          <div className={s.block}>
            <div className={s.blockHead}>
              <span className="label">Response time</span>
              <span className={`${s.muted} num`} style={{ fontSize: "var(--text-sm)" }}>
                median {ms(d.latency.p50)} · 95% under {ms(d.latency.p95)}
              </span>
            </div>
            {points.length > 1 ? (
              <TimeChart series={[{ key: "ms", label: "Response time", points, area: true }]} format={(v) => ms(v)} formatTime={(t) => fmt.time(t)} height={130} label={`${d.name} response time`} />
            ) : (
              <p className={s.muted}>Not enough successful checks yet to draw this.</p>
            )}
          </div>

          <div className={s.block}>
            <div className={s.blockHead}>
              <span className="label">Outages, last 30 days</span>
            </div>
            {d.incidents.length === 0 ? (
              <p className={s.muted}>None. Every check passed.</p>
            ) : (
              <ul className={s.outages} role="list">
                {d.incidents.map((o) => (
                  <li key={o.start} className={s.outage}>
                    <span>
                      <Time ts={o.start} kind="dateTime" className="num" />
                      {o.error && <span className={s.muted}> · {o.error}</span>}
                    </span>
                    <span className={`${s.muted} num`}>
                      {o.end ? `${o.checks === 1 ? "one failed check" : `lasted ${fmt.duration(Math.max(1, (o.end - o.start) / 1000), 2)}`}` : "still going"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className={s.block}>
            <div className={s.blockHead}>
              <span className="label">Recent checks</span>
              <span className={`${s.muted} num`} style={{ fontSize: "var(--text-sm)" }}>
                {d.checks.length}
              </span>
            </div>
            {d.checks.length === 0 ? (
              <p className={s.muted}>No checks yet.</p>
            ) : (
              <ul className={s.checks} role="list">
                {d.checks.map((c) => (
                  <li key={c.at} className={s.check} data-ok={String(c.ok)}>
                    <Time ts={c.at} kind="dateTime" seconds className="num" />
                    <span className={s.checkMark} aria-label={c.ok ? "Passed" : "Failed"} />
                    <span className={s.checkText}>{c.ok ? (c.status ? `Answered ${c.status}` : "Answered") : (c.error ?? "Failed")}</span>
                    <span className={`${s.muted} num`}>{ms(c.latencyMs)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
