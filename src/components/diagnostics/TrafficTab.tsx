"use client";
import * as React from "react";
import Link from "next/link";
import type { AppSummary } from "@/server/docker/apps";
import type { InterfaceInfo } from "@/lib/diagnostics-types";
import { useApi } from "@/lib/client/api";
import { useLive } from "@/lib/client/live";
import { useFormat } from "@/components/PrefsProvider";
import { Panel, Skeleton, Empty, Notice } from "@/components/ui/Surface";
import { Segmented } from "@/components/ui/Field";
import { StateLine } from "@/components/ui/StateLine";
import { TimeChart, Sparkline } from "@/components/charts/TimeChart";
import { AppIcon } from "@/components/apps/AppIcon";
import { SortHeader, type SortState } from "./SortHeader";
import s from "./diagnostics.module.css";

const KIND: Record<InterfaceInfo["kind"], string> = {
  ethernet: "Wired",
  wireless: "Wi-Fi",
  bridge: "Docker network",
  veth: "Container link",
  loopback: "Loopback",
  vpn: "VPN",
  other: "Other",
};

export function useContainerApps() {
  const { data } = useApi<AppSummary[]>("/api/apps", { refresh: 30_000 });
  return React.useMemo(() => {
    const m = new Map<string, { id: string; name: string; icon: string | null }>();
    for (const a of data ?? []) for (const c of a.containers) m.set(c.name, { id: a.id, name: a.name, icon: a.icon });
    return m;
  }, [data]);
}

export function TrafficTab() {
  const fmt = useFormat();
  const live = useLive();
  const ifs = useApi<{ interfaces: InterfaceInfo[] }>("/api/diagnostics/interfaces", { refresh: 15_000 });
  const apps = useContainerApps();
  const [which, setWhich] = React.useState<"main" | "all">("main");
  const [sort, setSort] = React.useState<SortState<"name" | "rx" | "tx">>({ key: "rx", dir: "desc" });

  const list = ifs.data?.interfaces ?? [];
  const seen = new Set(Object.keys(live.host.at(-1)?.net.ifaces ?? {}));
  const shown = list.filter((i) => (which === "all" ? i.kind !== "veth" && seen.has(i.name) : i.physical && (i.state === "UP" || i.state === "UNKNOWN") && seen.has(i.name)));
  const fallbackNames = !list.length ? [...seen].filter((n) => !/^(lo|veth|br-|docker)/.test(n)) : [];

  const series = (name: string) => {
    const rx: [number, number][] = [];
    const tx: [number, number][] = [];
    for (const h of live.host) {
      const v = h.net.ifaces[name];
      if (!v) continue;
      rx.push([h.t, v.rx]);
      tx.push([h.t, v.tx]);
    }
    return [
      { key: "rx", label: "In", points: rx, area: true },
      { key: "tx", label: "Out", points: tx, tone: "muted" as const },
    ];
  };

  // ---- containers
  const last = live.containers.at(-1);
  const history = live.containers;
  const rows = (last?.list ?? []).map((c) => {
    const trend = history.map((h) => {
      const x = h.list.find((y) => y.id === c.id);
      return (x?.rx ?? 0) + (x?.tx ?? 0);
    });
    return { c, app: apps.get(c.name), trend };
  });
  rows.sort((a, b) => {
    const d = sort.dir === "asc" ? 1 : -1;
    if (sort.key === "name") return d * (a.app?.name ?? a.c.name).localeCompare(b.app?.name ?? b.c.name);
    const k = sort.key;
    return d * ((a.c[k] ?? -1) - (b.c[k] ?? -1));
  });

  const chartName = (i: { name: string; kind?: InterfaceInfo["kind"]; dockerNetwork?: string | null }) => (i.dockerNetwork ? `${i.name} · ${i.dockerNetwork}` : i.kind ? `${i.name} · ${KIND[i.kind]}` : i.name);

  return (
    <div className={s.stack}>
      <Panel
        title="Throughput"
        meta={
          <Segmented
            aria-label="Interfaces"
            value={which}
            onChange={setWhich}
            options={[
              { value: "main", label: "Wired and Wi-Fi" },
              { value: "all", label: "All interfaces" },
            ]}
          />
        }
      >
        {live.host.length < 2 ? (
          <div className={s.charts}>
            <Skeleton height={170} />
            <Skeleton height={170} />
          </div>
        ) : shown.length === 0 && fallbackNames.length === 0 ? (
          <Empty title="No active interfaces">Gluon doesn't see traffic on any {which === "main" ? "wired or Wi-Fi " : ""}interface yet.</Empty>
        ) : (
          <div className={s.charts}>
            {(shown.length ? shown : fallbackNames.map((name) => ({ name }) as { name: string })).map((i) => {
              const now = live.host.at(-1)?.net.ifaces[i.name];
              return (
                <div key={i.name} className={s.chartBlock}>
                  <div className={s.chartHead}>
                    <span className={s.chartTitle} title={chartName(i)}>
                      {chartName(i)}
                    </span>
                    <span className={`${s.chartNow} num`}>
                      <span title="In">↓ {fmt.rate(now?.rx ?? 0)}</span>
                      <span title="Out" className={s.faint}>↑ {fmt.rate(now?.tx ?? 0)}</span>
                    </span>
                  </div>
                  <TimeChart series={series(i.name)} format={(v) => fmt.rate(v)} formatTime={(t) => fmt.time(t, true)} windowMs={5 * 60_000} live height={150} label={`${i.name} throughput`} />
                </div>
              );
            })}
          </div>
        )}
        <p className={s.legend}>
          <span data-tone="ink">In</span>
          <span data-tone="muted">Out</span>
          <span>Last 5 minutes. Hover a chart to read an exact moment.</span>
        </p>
      </Panel>

      <Panel title="By container" meta={last ? <span className="num">{fmt.plural(rows.length, "container")}</span> : undefined} flush>
        {!last ? (
          <div className={s.pad}>
            <Skeleton height={180} />
          </div>
        ) : rows.length === 0 ? (
          <Empty title="No containers running">Start an app and its traffic shows up here.</Empty>
        ) : (
          <div role="table" aria-label="Traffic by container" className={s.table}>
            <div role="row" className={`${s.head} ${s.ctrGrid}`}>
              <SortHeader label="Container" k="name" sort={sort} onSort={setSort} />
              <SortHeader label="In" k="rx" sort={sort} onSort={setSort} align="end" />
              <SortHeader label="Out" k="tx" sort={sort} onSort={setSort} align="end" />
              <span role="columnheader">Last few minutes</span>
            </div>
            {rows.map(({ c, app, trend }) => (
              <div role="row" key={c.id} className={`${s.row} ${s.ctrGrid}`}>
                <span role="cell" className={s.who}>
                  <AppIcon src={app?.icon} name={app?.name ?? c.name} size={24} />
                  <span className={s.whoText}>
                    {app ? (
                      <Link href={`/apps/${encodeURIComponent(app.id)}`} className={s.whoName} title={app.name}>
                        {app.name}
                      </Link>
                    ) : (
                      <span className={s.whoName} title={c.name}>{c.name}</span>
                    )}
                    {app && app.name !== c.name && <span className={`${s.whoSub} mono`} title={c.name}>{c.name}</span>}
                  </span>
                </span>
                {c.rx === null && c.tx === null ? (
                  <span role="cell" className={`${s.span2} ${s.faint}`}>Uses the host's network; counted under the interfaces above</span>
                ) : (
                  <>
                    <span role="cell" className={`${s.numCell} num`}>{fmt.rate(c.rx)}</span>
                    <span role="cell" className={`${s.numCell} num`}>{fmt.rate(c.tx)}</span>
                  </>
                )}
                <span role="cell" className={s.spark}>
                  {c.rx !== null && trend.length > 1 ? <Sparkline points={trend} height={24} label={`${app?.name ?? c.name} traffic trend`} /> : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Interfaces" flush>
        {ifs.error && !ifs.data ? (
          <div className={s.pad}>
            <Notice tone="fault" title="Couldn't list the interfaces">{ifs.error.message}</Notice>
          </div>
        ) : !ifs.data ? (
          <div className={s.pad}>
            <Skeleton height={160} />
          </div>
        ) : (
          <ul className={s.ifList} role="list">
            {list
              .filter((i) => which === "all" || i.kind !== "veth")
              .map((i) => (
                <li key={i.name} className={s.ifRow}>
                  <div className={s.ifName}>
                    <span className="mono">{i.name}</span>
                    <span className={s.faint}>{i.dockerNetwork ? `Docker network “${i.dockerNetwork}”` : KIND[i.kind]}</span>
                  </div>
                  <StateLine state={i.state === "UP" ? "running" : i.state === "DOWN" ? "stopped" : "unknown"} label={i.state === "UP" ? `Up${i.speedMbps ? ` · ${i.speedMbps >= 1000 ? `${i.speedMbps / 1000} Gb/s` : `${i.speedMbps} Mb/s`}` : ""}` : i.state === "DOWN" ? "Down" : i.state.toLowerCase()} />
                  <div className={`${s.ifAddrs} mono`}>
                    {i.addresses.length ? i.addresses.map((a) => <span key={a.address} title={`${a.scope} scope`}>{a.address}/{a.prefix}</span>) : <span className={s.faint}>No addresses</span>}
                  </div>
                  <div className={`${s.ifTotals} num`}>
                    <span>↓ {fmt.bytes(i.rxTotal)}</span>
                    <span>↑ {fmt.bytes(i.txTotal)}</span>
                    {i.rxErrors + i.txErrors > 0 && <span className={s.bad}>{fmt.plural(i.rxErrors + i.txErrors, "error")}</span>}
                  </div>
                  {i.mac && <span className={`${s.ifMac} mono`}>{i.mac}</span>}
                </li>
              ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
