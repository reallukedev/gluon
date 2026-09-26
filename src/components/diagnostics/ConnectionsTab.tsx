"use client";
import * as React from "react";
import { Pause, Play, Search } from "iconoir-react";
import type { AddrScope, Connection, ConnectionsSnapshot } from "@/lib/diagnostics-types";
import { useStream } from "@/lib/client/api";
import { useFormat } from "@/components/PrefsProvider";
import { Panel, Skeleton, Empty, Notice } from "@/components/ui/Surface";
import { Segmented, Checkbox } from "@/components/ui/Field";
import { Button, IconButton } from "@/components/ui/Button";
import { LiveStatus } from "./LiveStatus";
import ins from "./instruments.module.css";
import s from "./diagnostics.module.css";

export const SCOPE_WORD: Record<AddrScope, string> = { internet: "Internet", lan: "Home network", containers: "Container", local: "This machine" };

const fmtAddr = (ip: string, port: number) => (ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`);

export function ConnectionsTab() {
  const fmt = useFormat();
  const [resolve, setResolve] = React.useState(false);
  const [local, setLocal] = React.useState(false);
  const [paused, setPaused] = React.useState(false);
  const [snap, setSnap] = React.useState<ConnectionsSnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [dir, setDir] = React.useState<"all" | "in" | "out">("all");
  const [scope, setScope] = React.useState<"all" | AddrScope>("all");
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const pausedRef = React.useRef(paused);
  pausedRef.current = paused;

  const url = `/api/diagnostics/connections?resolve=${resolve ? 1 : 0}&local=${local ? 1 : 0}`;
  const status = useStream(
    url,
    {
      connections: (d) => {
        setError(null);
        if (!pausedRef.current) setSnap(d as ConnectionsSnapshot);
      },
      error: (d) => setError((d as { message: string }).message),
    },
    [url],
  );

  const term = q.trim().toLowerCase();
  const rows = (snap?.connections ?? []).filter((c) => {
    if (dir !== "all" && c.direction !== dir) return false;
    if (scope !== "all" && c.remote.scope !== scope) return false;
    if (term) {
      const hay = `${c.ownerLabel} ${c.process?.name ?? ""} ${c.remote.ip} ${c.remote.host ?? ""} ${c.remote.container ?? ""} ${c.local.port} ${c.remote.port}`.toLowerCase();
      if (!hay.includes(term)) return false;
    }
    return true;
  });
  const groups = new Map<string, Connection[]>();
  for (const c of rows) groups.set(c.ownerLabel, [...(groups.get(c.ownerLabel) ?? []), c]);
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  return (
    <div className={s.stack}>
      <div className={s.toolbar}>
        <label className={s.filter}>
          <Search aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by app, address or port" aria-label="Filter connections" spellCheck={false} />
        </label>
        <Segmented aria-label="Direction" value={dir} onChange={setDir} options={[{ value: "all", label: "Both ways" }, { value: "in", label: "Incoming" }, { value: "out", label: "Outgoing" }]} />
        <span className={s.spacer} />
        <LiveStatus status={status} paused={paused} />
        <IconButton label={paused ? "Resume" : "Pause"} size="sm" onClick={() => setPaused((p) => !p)}>
          {paused ? <Play /> : <Pause />}
        </IconButton>
      </div>
      <div className={s.opts}>
        <Checkbox checked={resolve} onChange={setResolve}>
          Look up names for addresses
        </Checkbox>
        <Checkbox checked={local} onChange={setLocal}>
          Include connections inside this machine
        </Checkbox>
      </div>

      {error && <Notice tone="fault" title="The connection list stopped updating">{error}</Notice>}

      {!snap ? (
        <div className={s.stack}>
          <Skeleton height={90} radius={12} />
          <Skeleton height={320} radius={12} />
        </div>
      ) : (
        <>
          <Reach snap={snap} scope={scope} onScope={setScope} includeLocal={local} />

          <div className={s.cols}>
            <Panel title="Busiest outside addresses" flush>
              {snap.topRemotes.length === 0 ? (
                <p className={s.pad}>Nothing outside this server is connected right now.</p>
              ) : (
                <ol className={s.topList}>
                  {snap.topRemotes.map((r) => (
                    <li key={r.ip}>
                      <span className={s.topMain}>
                        <span className={`${s.topName} mono`} title={r.ip}>
                          {r.host ?? r.ip}
                        </span>
                        <span className={s.topSub}>
                          {SCOPE_WORD[r.scope]}
                          {r.host ? ` · ${r.ip}` : ""} · {r.owners.join(", ")}
                        </span>
                      </span>
                      <span className="num">{r.count}</span>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>
            <Panel title="Busiest apps and processes" flush>
              {snap.topOwners.length === 0 ? (
                <p className={s.pad}>Nothing is connected.</p>
              ) : (
                <ol className={s.topList}>
                  {snap.topOwners.map((o) => (
                    <li key={o.label}>
                      <span className={s.topMain}>
                        <span className={s.topName}>{o.label}</span>
                        <span className={s.topSub}>
                          {o.inbound} in · {o.outbound} out
                        </span>
                      </span>
                      <span className="num">{o.total}</span>
                    </li>
                  ))}
                </ol>
              )}
            </Panel>
          </div>

          <Panel
            title="Open connections, by who holds them"
            meta={
              <span className="num">
                {rows.length === snap.connections.length ? fmt.plural(rows.length, "connection") : `${rows.length} of ${snap.connections.length}`}
                {snap.counts.hiddenLocal ? ` · ${snap.counts.hiddenLocal} inside this machine not shown` : ""}
              </span>
            }
            flush
          >
            {snap.truncated && <p className={s.panelNote}>Showing the first 1,500 connections.</p>}
            {rows.length === 0 ? (
              <Empty title={term || dir !== "all" || scope !== "all" ? "Nothing matches" : "No connections"}>
                {term || dir !== "all" || scope !== "all" ? "Try a different filter." : "Nothing on this server is talking to anything right now."}
              </Empty>
            ) : (
              <div role="table" aria-label="Connections" className={s.table}>
                <div role="row" className={`${s.head} ${s.connGrid}`}>
                  <span role="columnheader">Direction</span>
                  <span role="columnheader">Port here</span>
                  <span role="columnheader">Other end</span>
                  <span role="columnheader">Where</span>
                  <span role="columnheader" className={s.end} title="Data waiting to be read / sent. Usually zero; a growing number means one side is stuck.">Backlog</span>
                </div>
                {ordered.map(([label, list]) => {
                  const open = expanded.has(label);
                  const shown = open ? list : list.slice(0, 20);
                  return (
                    <div role="rowgroup" key={label}>
                      <div role="row" className={s.groupRow}>
                        <span role="cell" className={s.groupName}>
                          {label}
                        </span>
                        <span role="cell" className={s.faint}>
                          {list.filter((c) => c.direction === "in").length} in · {list.filter((c) => c.direction === "out").length} out
                        </span>
                      </div>
                      {shown.map((c, i) => (
                        <div role="row" key={`${c.proto}-${c.local.ip}-${c.local.port}-${c.remote.ip}-${c.remote.port}-${i}`} className={`${s.row} ${s.connGrid}`}>
                          <span role="cell" className={s.dir} data-dir={c.direction}>
                            {c.direction === "in" ? "↓ In" : "↑ Out"}
                          </span>
                          <span role="cell" className="mono num">
                            {c.local.port}/{c.proto}
                            {c.process && <span className={s.cellSub}>{c.process.name}</span>}
                          </span>
                          <span role="cell" className={s.cellMain}>
                            <span className={`${s.cellText} mono`} title={fmtAddr(c.remote.ip, c.remote.port)}>
                              {c.remote.host ?? c.remote.container ?? c.remote.ip}
                              <span className={s.faint}>:{c.remote.port}</span>
                            </span>
                            {(c.remote.host || c.remote.container) && <span className={`${s.cellSub} mono`}>{c.remote.ip}</span>}
                          </span>
                          <span role="cell" className={s.cellText}>{SCOPE_WORD[c.remote.scope]}</span>
                          <span role="cell" className={`${s.numCell} num`} title="Bytes waiting to be read / sent">
                            {c.recvQ || c.sendQ ? `${fmt.bytes(c.recvQ)} / ${fmt.bytes(c.sendQ)}` : <span className={s.faint}>—</span>}
                          </span>
                        </div>
                      ))}
                      {list.length > 20 && (
                        <div className={s.moreRow}>
                          <Button size="sm" variant="ghost" onClick={() => setExpanded((e) => {
                            const n = new Set(e);
                            if (open) n.delete(label);
                            else n.add(label);
                            return n;
                          })}>
                            {open ? "Show fewer" : `Show all ${list.length}`}
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className={s.stat}>
      <span className="label">{label}</span>
      <strong className="num">{value}</strong>
      {sub && <span className={s.statSub}>{sub}</span>}
    </div>
  );
}

const SCOPES: AddrScope[] = ["internet", "lan", "containers", "local"];
const REACH_WORD: Record<AddrScope, string> = { internet: "Internet", lan: "Home network", containers: "Between apps", local: "Inside this machine" };

/** Where the other ends are: one cell per place, split into incoming (solid) and outgoing (dashed). Click to filter. */
function Reach({ snap, scope, onScope, includeLocal }: { snap: ConnectionsSnapshot; scope: "all" | AddrScope; onScope: (s: "all" | AddrScope) => void; includeLocal: boolean }) {
  const per = new Map<AddrScope, { in: number; out: number }>(SCOPES.map((x) => [x, { in: 0, out: 0 }]));
  for (const c of snap.connections) {
    const p = per.get(c.remote.scope);
    if (p) p[c.direction]++;
  }
  const shown = SCOPES.filter((x) => x !== "local" || includeLocal);
  const max = Math.max(1, ...shown.map((x) => per.get(x)!.in + per.get(x)!.out));
  return (
    <div className={ins.reach} style={{ "--cols": shown.length } as React.CSSProperties} role="group" aria-label="Filter by where the other end is">
      {shown.map((x) => {
        const p = per.get(x)!;
        const total = p.in + p.out;
        return (
          <button key={x} type="button" className={ins.reachCell} aria-pressed={scope === x} onClick={() => onScope(scope === x ? "all" : x)}>
            <span className={ins.reachTop}>
              <span className="label">{REACH_WORD[x]}</span>
              <span className={ins.figure}>{total}</span>
            </span>
            <span className={ins.reachBar} aria-hidden>
              {p.in > 0 && <span className={ins.reachIn} style={{ width: `${(p.in / max) * 100}%` }} />}
              {p.out > 0 && <span className={ins.reachOut} style={{ width: `${(p.out / max) * 100}%` }} />}
            </span>
            <span className={ins.reachSub}>
              {p.in} coming in · {p.out} going out
            </span>
          </button>
        );
      })}
    </div>
  );
}
