"use client";
import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Pause, Play, Search, Trash } from "iconoir-react";
import type { CaddyNotice, RequestEntry, RequestFeedState, RequestStats } from "@/lib/diagnostics-types";
import { useStream } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Panel, Skeleton, Empty, Notice } from "@/components/ui/Surface";
import { Segmented, Checkbox } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { Button, IconButton } from "@/components/ui/Button";
import { Time } from "@/components/ui/Time";
import { LiveStatus } from "./LiveStatus";
import ins from "./instruments.module.css";
import s from "./diagnostics.module.css";

const MAX = 5000;
type Cls = "all" | "2xx" | "3xx" | "4xx" | "5xx";
const clsOf = (st: number): Exclude<Cls, "all"> | "other" => (st >= 200 && st < 600 ? (`${Math.floor(st / 100)}xx` as Exclude<Cls, "all">) : "other");

export function RequestsTab() {
  const fmt = useFormat();
  const [internal, setInternal] = React.useState(false);
  const [entries, setEntries] = React.useState<RequestEntry[]>([]);
  const [notices, setNotices] = React.useState<CaddyNotice[]>([]);
  const [stats, setStats] = React.useState<RequestStats | null>(null);
  const [feed, setFeed] = React.useState<RequestFeedState | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [paused, setPaused] = React.useState<RequestEntry[] | null>(null);
  const [q, setQ] = React.useState("");
  const [host, setHost] = React.useState("");
  const [cls, setCls] = React.useState<Cls>("all");
  const parent = React.useRef<HTMLDivElement>(null);

  const url = `/api/diagnostics/requests?internal=${internal ? 1 : 0}&window=15&limit=500`;
  React.useEffect(() => {
    setLoaded(false);
    setEntries([]);
  }, [url]);
  const status = useStream(
    url,
    {
      snapshot: (d) => {
        const x = d as { state: RequestFeedState; requests: RequestEntry[]; notices: CaddyNotice[]; stats: RequestStats };
        setEntries(x.requests);
        setNotices(x.notices);
        setStats(x.stats);
        setFeed(x.state);
        setLoaded(true);
      },
      requests: (d) => {
        const add = d as RequestEntry[];
        setEntries((prev) => (prev.length + add.length > MAX ? [...prev.slice(prev.length + add.length - MAX), ...add] : [...prev, ...add]));
      },
      notice: (d) => setNotices((n) => [...n.slice(-99), d as CaddyNotice]),
      stats: (d) => setStats(d as RequestStats),
      state: (d) => setFeed(d as RequestFeedState),
    },
    [url],
  );

  const source = paused ?? entries;
  const hosts = React.useMemo(() => [...new Set(entries.map((e) => e.host).filter(Boolean))].sort(), [entries]);
  const term = q.trim().toLowerCase();
  const visible = React.useMemo(() => {
    const out: RequestEntry[] = [];
    for (let i = source.length - 1; i >= 0; i--) {
      const e = source[i]!;
      if (host && e.host !== host) continue;
      if (cls !== "all" && clsOf(e.status) !== cls) continue;
      if (term && !`${e.uri} ${e.remoteIp} ${e.userAgent} ${e.method}`.toLowerCase().includes(term)) continue;
      out.push(e);
    }
    return out;
  }, [source, host, cls, term]);
  const newSincePause = paused ? entries.length - paused.length : 0;

  const v = useVirtualizer({ count: visible.length, getScrollElement: () => parent.current, estimateSize: () => 34, overscan: 20 });

  const recentNotices = notices.filter((n) => n.level === "error" || n.level === "warn" || /certificate/i.test(n.message)).slice(-5).reverse();

  return (
    <div className={s.stack}>
      {feed && !feed.following && feed.error && (
        <Notice tone="fault" title="Not receiving requests">
          {feed.error}
        </Notice>
      )}
      {feed?.format === "console" && (
        <Notice title="Caddy is still using its older log format">
          Requests are read from its console log for now. Saving any public address switches Caddy to structured logs, which are more reliable.
        </Notice>
      )}

      {!stats ? <Skeleton height={150} radius={12} /> : <LastHour stats={stats} cls={cls} onCls={setCls} />}

      {stats && stats.total > 0 && (
        <div className={s.cols3}>
          <TopList title="Busiest paths" items={stats.topPaths} mono />
          <TopList title="Busiest visitors" items={stats.topClients} mono />
          <TopList title="By address" items={stats.topHosts} mono />
        </div>
      )}

      <Panel
        title="Live requests"
        meta={
          <>
            <span className="num">{fmt.plural(visible.length, "request")}</span>
            <LiveStatus status={status} paused={!!paused} />
          </>
        }
        flush
      >
        <div className={`${s.toolbar} ${s.panelToolbar}`}>
          <label className={s.filter}>
            <Search aria-hidden />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by path, visitor or browser" aria-label="Filter requests" spellCheck={false} />
          </label>
          {hosts.length > 1 && (
            <Select aria-label="Address" value={host} onChange={setHost} options={[{ value: "", label: "Every address" }, ...hosts.map((h) => ({ value: h, label: h }))]} />
          )}
          <Segmented
            aria-label="Result"
            value={cls}
            onChange={setCls}
            options={[
              { value: "all", label: "All" },
              { value: "2xx", label: "OK" },
              { value: "3xx", label: "Redirects" },
              { value: "4xx", label: "Refused" },
              { value: "5xx", label: "Errors" },
            ]}
          />
          <Checkbox checked={!internal} onChange={(c) => setInternal(!c)}>
            Hide health checks
          </Checkbox>
          <span className={s.spacer} />
          {paused ? (
            <Button size="sm" icon={<Play />} onClick={() => setPaused(null)}>
              {newSincePause > 0 ? `${fmt.plural(newSincePause, "new request")}` : "Resume"}
            </Button>
          ) : (
            <IconButton label="Pause" size="sm" onClick={() => setPaused(entries)}>
              <Pause />
            </IconButton>
          )}
          <IconButton label="Clear" size="sm" onClick={() => (setEntries([]), setPaused(null))}>
            <Trash />
          </IconButton>
        </div>
        <div className={`${s.reqHead} ${s.reqGrid}`} aria-hidden>
          <span>Time</span>
          <span>Status</span>
          <span>Request</span>
          <span className={s.end}>Took</span>
          <span className={s.end}>Size</span>
          <span>Visitor</span>
        </div>
        <div ref={parent} className={s.feed} role="log" aria-label="Live requests" aria-live="off">
          {!loaded ? (
            <p className={s.feedEmpty}>Connecting to Caddy's log…</p>
          ) : visible.length === 0 ? (
            <div className={s.feedEmpty}>
              <Empty title={entries.length ? "Nothing matches" : "No requests yet"}>
                {entries.length ? "Try another filter." : "Visits to your public addresses appear here the moment Caddy handles them."}
              </Empty>
            </div>
          ) : (
            <div style={{ height: v.getTotalSize(), position: "relative" }}>
              {v.getVirtualItems().map((item) => {
                const e = visible[item.index]!;
                const c = clsOf(e.status);
                return (
                  <div key={e.id} className={`${s.reqRow} ${s.reqGrid}`} style={{ transform: `translateY(${item.start}px)` }} data-internal={e.internal ? "" : undefined} title={e.userAgent}>
                    <Time ts={e.time} kind="time" seconds className={`${s.faint} num`} />
                    <span className={s.code} data-class={c}>
                      {e.status || "No reply"}
                    </span>
                    <span className={s.reqPath}>
                      <span className={s.method}>{e.method}</span>
                      <span className={s.reqHost}>{e.host}</span>
                      <span className="mono">{e.uri}</span>
                    </span>
                    <span className={`${s.end} num`} title={e.status === 101 ? "A live connection (WebSocket) that stayed open" : undefined}>
                      {e.status === 101 ? "live" : `${e.duration < 1 ? "<1" : Math.round(e.duration)} ms`}
                    </span>
                    <span className={`${s.end} num`}>{e.size ? fmt.bytes(e.size) : "None"}</span>
                    <span className={`${s.reqIp} mono`}>{e.remoteIp}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Panel>

      {recentNotices.length > 0 && (
        <Panel title="From Caddy" flush>
          <ul className={s.notices}>
            {recentNotices.map((n, i) => (
              <li key={i} data-level={n.level}>
                <Time ts={n.time} kind="dateTime" className="num" />
                <span>
                  {n.host && <span className="mono">{n.host} · </span>}
                  {n.message}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function TopList({ title, items, mono }: { title: string; items: { key: string; count: number; errors: number }[]; mono?: boolean }) {
  return (
    <Panel title={title} flush>
      {items.length === 0 ? (
        <p className={s.pad}>Nothing yet.</p>
      ) : (
        <ol className={s.topList}>
          {items.slice(0, 8).map((x) => (
            <li key={x.key}>
              <span className={s.topMain}>
                <span className={`${s.topName} ${mono ? "mono" : ""}`} title={x.key}>
                  {x.key}
                </span>
                {x.errors > 0 && <span className={s.topSub}>{x.errors} failed</span>}
              </span>
              <span className="num">{x.count}</span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

const CLASS_WORD: Record<Exclude<Cls, "all">, string> = { "2xx": "OK", "3xx": "Redirected", "4xx": "Refused or not found", "5xx": "Server errors" };

/** The last hour as one hairline per minute (height = requests, red below the rail = failures), with totals. */
function LastHour({ stats, cls, onCls }: { stats: RequestStats; cls: Cls; onCls: (c: Cls) => void }) {
  const fmt = useFormat();
  const [active, setActive] = React.useState<number | null>(null);
  const max = Math.max(1, ...stats.series.map((x) => x[1]));
  const hovered = active !== null ? stats.series[active] : null;
  const hourTotal = stats.series.reduce((a, x) => a + x[1], 0);
  const hourFail = stats.series.reduce((a, x) => a + x[2], 0);
  return (
    <div className={ins.plate}>
      <section className={ins.plateCell} aria-label="Requests in the last hour">
        <div className={ins.plateHead}>
          <span className={ins.plateLabel}>Last hour</span>
          <span className={ins.figure}>
            {hourTotal.toLocaleString()}
            <small>{hourTotal === 1 ? "request" : "requests"}</small>
          </span>
        </div>
        <div>
          <div className={ins.minutes} data-isolate={active !== null ? "" : undefined} onPointerLeave={() => setActive(null)} role="img" aria-label={`${hourTotal} requests in the last hour, ${hourFail} with server errors`}>
            {stats.series.map(([t, n, bad], i) => (
              <span key={t} className={ins.minute} data-empty={n === 0 ? "" : undefined} data-active={active === i ? "" : undefined} onPointerEnter={() => setActive(i)}>
                <span className={ins.minuteLine} style={{ height: `${Math.max(4, (n / max) * 100)}%` }} />
                {bad > 0 && <span className={ins.minuteFail} />}
              </span>
            ))}
          </div>
          <div className={ins.minuteAxis} aria-hidden>
            {hovered ? (
              <span style={{ color: "var(--ink-2)" }}>
                {fmt.time(hovered[0])} · {fmt.plural(hovered[1], "request")}
                {hovered[2] ? ` · ${hovered[2]} failed` : ""}
              </span>
            ) : (
              <>
                <span>{stats.series[0] ? fmt.time(stats.series[0][0]) : ""}</span>
                <span>now</span>
              </>
            )}
          </div>
        </div>
      </section>
      <section className={ins.plateCell} aria-label="Last 15 minutes">
        <div className={ins.plateHead}>
          <span className={ins.plateLabel}>Last 15 minutes</span>
          <span className={ins.figure}>
            {stats.perMinute.toLocaleString(undefined, { maximumFractionDigits: 1 })}
            <small>a minute</small>
          </span>
        </div>
        <div className={ins.classes} role="group" aria-label="Show only">
          {(["2xx", "3xx", "4xx", "5xx"] as const).map((c) => (
            <button key={c} type="button" className={ins.classBtn} aria-pressed={cls === c} onClick={() => onCls(cls === c ? "all" : c)}>
              <span className={s.code} data-class={c} aria-hidden />
              {CLASS_WORD[c]} <strong className="num">{stats.statusClasses[c]}</strong>
            </button>
          ))}
        </div>
        <div className={ins.plateFoot}>
          <span data-bad={stats.errorRate >= 0.05 ? "" : undefined}>
            <strong>{fmt.percent(stats.errorRate * 100, stats.errorRate > 0 && stats.errorRate < 0.1 ? 1 : 0)}</strong> server errors
          </span>
          <span>
            Slowest 5% took <strong>{stats.p95Ms !== null ? `${Math.round(stats.p95Ms)} ms` : "not measured yet"}</strong>
          </span>
          <span>
            <strong>{fmt.bytes(stats.bytes)}</strong> sent
          </span>
          {stats.internalExcluded > 0 && <span>{fmt.plural(stats.internalExcluded, "health check")} not counted</span>}
        </div>
      </section>
    </div>
  );
}
