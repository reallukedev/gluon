"use client";
import * as React from "react";
import type { DeviceT } from "@/lib/router-types";
import { useFormat } from "@/components/PrefsProvider";
import { Button } from "@/components/ui/Button";
import { Input, Segmented } from "@/components/ui/Field";
import { DefinitionList, Panel, Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { connectionWords, matches, twinHint, type Filter } from "./model";
import s from "./router.module.css";

/** Offline devices shown before "Show more": the router remembers every visitor for months. */
const OFFLINE_FIRST = 12;

/** Wi-Fi signal as the router reports it, 0 to 5 bars, drawn as five rising hairline bars. */
function Bars({ n }: { n: number }) {
  return (
    <svg className={s.bars} width="17" height="12" viewBox="0 0 17 12" role="img" aria-label={`Signal ${n} of 5 bars`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <rect key={i} x={i * 3.5} y={12 - (i + 1) * 2.4} width="2" height={(i + 1) * 2.4} rx="0.5" data-on={i < n ? "" : undefined} />
      ))}
    </svg>
  );
}

function DeviceItem({ d, open, onToggle }: { d: DeviceT; open: boolean; onToggle: () => void }) {
  const fmt = useFormat();
  const hint = twinHint(d);
  const id = `device-${d.id.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <li className={s.device} data-offline={d.online ? undefined : ""}>
      <button type="button" className={s.deviceRow} aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <span aria-hidden>
          <StateLine state={d.online ? "running" : "stopped"} label={false} />
        </span>
        <span className={s.cell}>
          <span className={s.devName}>
            <span title={d.name ?? undefined}>{d.name ?? "No name"}</span>
            {d.server && <span className={s.tag}>This server</span>}
          </span>
          {hint && <span className={`${s.devSub} mono`}>{hint}</span>}
        </span>
        <span className={s.conn}>
          {d.kind === "wifi" && d.bars !== null && <Bars n={d.bars} />}
          <span>{connectionWords(d)}</span>
        </span>
        <span className={`${s.ip} mono`}>{d.ipv4 ?? <span className={s.faint}>No address</span>}</span>
        <span className={s.seen}>{d.online ? "Online" : d.lastActivity ? <Time ts={d.lastActivity} /> : "Offline"}</span>
      </button>
      {open && (
        <div className={`${s.details} ${s.dlWrap}`} id={id} data-motion-gentle="">
          <DefinitionList
            items={[
              ["MAC address", d.mac ? <span className="mono">{d.mac}</span> : <span className={s.faint}>Not listed</span>],
              ["IPv4", d.ipv4 ? <span className="mono">{d.ipv4}</span> : <span className={s.faint}>None right now</span>],
              ["IPv6", d.ipv6.length ? <span className={`${s.addr} mono`}>{d.ipv6.map((a) => <span key={a}>{a}</span>)}</span> : <span className={s.faint}>None</span>],
              ["Address from", d.allocation === "dhcp" ? "The router (DHCP)" : d.allocation === "pending" ? "Waiting for one from the router" : d.allocation === "fixed" || d.allocation?.includes("fixed") ? "A fixed address on the router" : (d.allocation ?? <span className={s.faint}>Not listed</span>)],
              ["Connection", connectionWords(d) + (d.kind === "wifi" && d.bars !== null ? `, ${d.bars} of 5 bars` : "")],
              ["Last active", d.lastActivity ? fmt.dateTime(d.lastActivity) : d.online ? "Now" : <span className={s.faint}>Not listed</span>],
            ]}
          />
        </div>
      )}
    </li>
  );
}

export function DevicesPanel({ devices, readAt, loading }: { devices: DeviceT[] | null; readAt: number | undefined; loading: boolean }) {
  const [filter, setFilter] = React.useState<Filter>("all");
  const [q, setQ] = React.useState("");
  const query = React.useDeferredValue(q.trim());
  const [open, setOpen] = React.useState<string | null>(null);
  const [all, setAll] = React.useState(false);

  const list = devices ?? [];
  const online = list.filter((d) => d.online).length;
  const counts = { all: list.length, online, wifi: list.filter((d) => d.kind === "wifi").length, wired: list.filter((d) => d.kind === "ethernet").length };
  const shown = list.filter((d) => matches(d, filter, query));
  const offline = shown.filter((d) => !d.online);
  const capped = !all && !query && filter !== "online" && offline.length > OFFLINE_FIRST + 4;
  const visible = capped ? shown.filter((d) => d.online).concat(offline.slice(0, OFFLINE_FIRST)) : shown;
  const n = (x: number) => <span className="num">{x}</span>;

  return (
    <Panel title="Devices" meta={readAt ? <span className={s.meta}>Read <Time ts={readAt} /></span> : undefined} flush className={s.devices}>
      {!devices ? (
        <div className={s.stack} style={{ padding: "16px 18px" }} aria-busy={loading}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} height={40} radius={6} />
          ))}
        </div>
      ) : (
        <>
          <div className={s.toolbar}>
            <Input className={s.search} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, address or MAC" aria-label="Search devices" autoComplete="off" spellCheck={false} />
            <Segmented
              aria-label="Show"
              value={filter}
              onChange={(v) => {
                setFilter(v);
                setAll(false);
              }}
              options={[
                { value: "all", label: "All" },
                { value: "online", label: "Online", ariaLabel: `Online, ${counts.online}` },
                { value: "wifi", label: "Wi-Fi", ariaLabel: `Wi-Fi, ${counts.wifi}` },
                { value: "wired", label: "Wired", ariaLabel: `Wired, ${counts.wired}` },
              ]}
            />
            <span className={s.toolbarEnd} aria-live="polite">
              {query || filter !== "all" ? (
                <>
                  {n(shown.length)} of {n(list.length)}
                </>
              ) : (
                <>
                  {n(online)} online, {n(list.length - online)} remembered
                </>
              )}
            </span>
          </div>
          {visible.length === 0 ? (
            <p className={s.nothing}>{list.length === 0 ? "The router lists no devices yet." : `No device matches${query ? ` "${query}"` : ""}.`}</p>
          ) : (
            <ul className={s.list}>
              {visible.map((d) => (
                <DeviceItem key={d.id} d={d} open={open === d.id} onToggle={() => setOpen((o) => (o === d.id ? null : d.id))} />
              ))}
            </ul>
          )}
          {capped && (
            <div className={s.more}>
              <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
                Show {offline.length - OFFLINE_FIRST} more offline devices
              </Button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
