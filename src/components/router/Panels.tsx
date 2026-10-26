"use client";
import * as React from "react";
import type { FirewallT, RouterOverview, WifiNetworkT } from "@/lib/router-types";
import { useFormat } from "@/components/PrefsProvider";
import { TimeChart } from "@/components/charts/TimeChart";
import { CopyButton } from "@/components/ui/CopyButton";
import { DefinitionList, Panel, Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { mbps, since } from "./model";
import s from "./router.module.css";

const dbm = (v: number) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)} dBm`;

function Loading({ rows = 5 }: { rows?: number }) {
  return (
    <div className={s.stack} aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={16} width={`${70 - i * 6}%`} />
      ))}
    </div>
  );
}

const Faint = ({ children }: { children: React.ReactNode }) => <span className={s.faint}>{children}</span>;

// ---------------------------------------------------------------- Internet

export function InternetPanel({ o }: { o: RouterOverview }) {
  const fmt = useFormat();
  const bb = o.broadband;
  const op = o.optical;
  const boot = o.facts?.bootAt ?? null;
  const fiber = /fiber/i.test(bb?.source ?? "");
  const words = !bb ? null : bb.up === false ? "Down" : bb.up ? "Connected" : "Unknown";
  const verdict = { good: "normal", weak: "weak", strong: "too strong", alarm: "outside the router's alarm limits", unknown: null }[op?.verdict ?? "unknown"];
  const light =
    op?.rxDbm != null ? (
      <span className={s.addr}>
        <span>
          <span className="num">{dbm(op.rxDbm)}</span>
          {verdict ? `, ${verdict}` : ""}
        </span>
        {op.rxWarn && (
          <span className={s.muted}>
            The router expects {dbm(op.rxWarn.low)} to {dbm(op.rxWarn.high)}
          </span>
        )}
      </span>
    ) : (
      <Faint>{o.readAt.optical ? "Not shown by the router" : "Reading…"}</Faint>
    );
  return (
    <Panel title="Internet" meta={o.readAt.broadband ? <span className={s.meta}>Read <Time ts={o.readAt.broadband} /></span> : undefined}>
      {!bb ? (
        <Loading rows={6} />
      ) : (
        <div className={s.stack}>
          <div className={s.state}>
            <StateLine state={bb.up === false ? "unhealthy" : bb.up ? "running" : "unknown"} size={18} />
            <p className={s.stateWords}>{words}</p>
            <span className={s.stateSub}>{[bb.source, mbps(bb.lineMbps)].filter(Boolean).join(", ")}</span>
          </div>
          <div className={s.dlWrap}>
          <DefinitionList
            items={[
              [
                "Public address",
                bb.ipv4 ? (
                  <span className={s.withCopy}>
                    <span className="mono">{bb.ipv4}</span>
                    <CopyButton value={bb.ipv4} size="sm" label="Copy the public address" />
                  </span>
                ) : (
                  <Faint>None</Faint>
                ),
              ],
              ["AT&T's gateway", bb.gateway4 ? <span className="mono">{bb.gateway4}</span> : <Faint>None</Faint>],
              [
                "IPv6",
                bb.ipv6.available ? (
                  <span className={s.addr}>
                    <span>Available{bb.ipv6.kind ? `, ${bb.ipv6.kind.replace(/^native IPv6$/i, "native")}` : ""}</span>
                    {bb.ipv6.address && <span className="mono">{bb.ipv6.address}</span>}
                  </span>
                ) : (
                  <Faint>{bb.ipv6.available === false ? "Not available" : "Not shown"}</Faint>
                ),
              ],
              ["DNS servers", bb.dns.length ? <span className={`${s.addr} mono`}>{bb.dns.map((d) => <span key={d}>{d}</span>)}</span> : <Faint>None</Faint>],
              ...(fiber || op ? ([["Fiber light", light]] as [React.ReactNode, React.ReactNode][]) : []),
              ["Router on since", boot ? <span>{fmt.dateTime(boot)} <span className={s.muted}>({since(Date.now() - boot)})</span></span> : <Faint>Not shown</Faint>],
              ["Since then", bb.rxBytes != null && bb.txBytes != null ? <span className="num">{fmt.bytes(bb.rxBytes)} in, {fmt.bytes(bb.txBytes)} out{bb.errors ? `, ${fmt.plural(bb.errors, "error")}` : ""}</span> : <Faint>Not shown</Faint>],
              ...(op?.module ? ([["Fiber module", op.module]] as [React.ReactNode, React.ReactNode][]) : []),
            ]}
          />
          </div>
          {o.events.length > 0 && (
            <>
              <h3 className={s.subhead}>Lately</h3>
              <ol className={s.history}>
                {o.events.slice(0, 6).map((e) => (
                  <li key={`${e.at}-${e.kind}`}>
                    <Time ts={e.at} kind="dateTime" />
                    <span>{e.text}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- Traffic

export function TrafficPanel({ o }: { o: RouterOverview }) {
  const fmt = useFormat();
  const pts = o.traffic.points;
  const rx = React.useMemo(() => pts.filter((p) => p.rx !== null).map((p) => [p.t, p.rx!] as [number, number]), [pts]);
  const tx = React.useMemo(() => pts.filter((p) => p.tx !== null).map((p) => [p.t, p.tx!] as [number, number]), [pts]);
  const now = o.traffic.now;
  const measured = rx.length > 0;
  // Show the history there is (at least half an hour), up to six hours.
  const first = rx[0]?.[0] ?? Date.now();
  const windowMs = Math.min(6 * 3_600_000, Math.max(30 * 60_000, Math.ceil((Date.now() - first) / 1_800_000) * 1_800_000));
  const span = windowMs >= 3_600_000 ? fmt.plural(windowMs / 3_600_000, "hour") : `${windowMs / 60_000} minutes`;
  return (
    <Panel title="Internet traffic" meta={<span className={s.meta}>Whole home, last {span}</span>}>
      {!o.broadband ? (
        <Loading rows={3} />
      ) : (
        <>
          <div className={s.figures} aria-live="off">
            <div className={s.figure}>
              <span className={`label ${s.figureHead}`}>
                <i className={s.swatch} aria-hidden />
                In
              </span>
              <strong>{now ? fmt.rate(now.rx) : <small>Measuring</small>}</strong>
            </div>
            <div className={s.figure} data-out="">
              <span className={`label ${s.figureHead}`}>
                <i className={s.swatch} data-tone="muted" aria-hidden />
                Out
              </span>
              <strong>{now ? fmt.rate(now.tx) : <small>Measuring</small>}</strong>
            </div>
            {now && (
              <span className={s.figuresNote}>
                Over the last read, <Time ts={now.at} />
              </span>
            )}
          </div>
          {measured ? (
            <TimeChart
              series={[
                { key: "in", label: "In", points: rx, area: true },
                { key: "out", label: "Out", points: tx, tone: "muted" },
              ]}
              height={150}
              format={(v) => fmt.rate(v)}
              formatTime={(t) => fmt.time(t)}
              windowMs={windowMs}
              live
              label={`Internet traffic for the whole home over the last ${span}`}
            />
          ) : (
            <p className={s.lead}>The line starts after the router&rsquo;s second reading.</p>
          )}
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- Wi-Fi

function wifiSub(n: WifiNetworkT): string {
  return [n.band, n.kind === "guest" ? "Guest" : "Home", n.on ? n.security : null, n.radioOn ? null : "radio off"].filter(Boolean).join(" · ");
}

export function WifiPanel({ o }: { o: RouterOverview }) {
  const nets = o.wifi;
  return (
    <Panel title="Wi-Fi" flush>
      {!nets ? (
        <div style={{ padding: "16px 18px" }}>
          <Loading rows={3} />
        </div>
      ) : nets.length === 0 ? (
        <p className={s.note} style={{ borderTop: 0 }}>
          The router&rsquo;s status page lists no Wi-Fi networks.
        </p>
      ) : (
        <>
          <ul className={s.rows}>
            {nets.map((n) => (
              <li key={`${n.band}-${n.ssid}`}>
                <span className={s.rowMain}>
                  <span className={s.rowName}>{n.ssid}</span>
                  <span className={s.rowSub}>{wifiSub(n)}</span>
                </span>
                <StateLine state={n.on && n.radioOn ? "running" : "stopped"} label={n.on && n.radioOn ? "On" : "Off"} />
              </li>
            ))}
          </ul>
          <p className={s.note}>
            Names and passwords are changed on the router itself, on its{" "}
            <a href={`http://${o.gateway}/cgi-bin/wconfig_unified.ha`} target="_blank" rel="noreferrer">
              Wi-Fi page
            </a>{" "}
            (it asks for the access code).
          </p>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- Firewall

const FIREWALL: { key: keyof FirewallT; name: string; on: string; off: string }[] = [
  { key: "packetFilter", name: "Packet filter", on: "Blocks traffic by the rules set on the router", off: "No extra rules" },
  { key: "ipPassthrough", name: "IP passthrough", on: "One device gets the public address directly", off: "The router shares its address with everything" },
  { key: "natDefaultServer", name: "NAT default server", on: "Unrequested traffic all goes to one device", off: "Unrequested traffic is dropped" },
  { key: "advanced", name: "Attack protection", on: "Drops floods and malformed packets", off: "Off" },
];

function firewallNote(f: FirewallT): string {
  if (f.ipPassthrough) return "IP passthrough is on, so one device answers for your public address and the port forwarding below doesn't apply to it.";
  if (f.natDefaultServer) return "Everything nobody asked for goes to one device. That device is open to the whole internet.";
  return "Only the ports you forward reach devices at home. Everything else from outside stops at the router.";
}

export function FirewallPanel({ o }: { o: RouterOverview }) {
  const f = o.firewall;
  return (
    <Panel title="Firewall" flush>
      {!f ? (
        <div style={{ padding: "16px 18px" }}>
          <Loading rows={4} />
        </div>
      ) : (
        <>
          <ul className={s.rows}>
            {FIREWALL.map((x) => (
              <li key={x.key}>
                <span className={s.rowMain}>
                  <span className={s.rowName}>{x.name}</span>
                  <span className={s.rowSub}>{f[x.key] === null ? "Not shown by the router" : f[x.key] ? x.on : x.off}</span>
                </span>
                <StateLine state={f[x.key] === null ? "unknown" : f[x.key] ? "running" : "stopped"} label={f[x.key] === null ? "Unknown" : f[x.key] ? "On" : "Off"} />
              </li>
            ))}
          </ul>
          <p className={s.note}>{firewallNote(f)}</p>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- the router itself

export function FactsPanel({ o, access }: { o: RouterOverview; access: React.ReactNode }) {
  const fmt = useFormat();
  const f = o.facts;
  return (
    <Panel title="This router">
      {!f ? (
        <Loading rows={5} />
      ) : (
        <div className={s.stack}>
          <div className={s.dlWrap}>
          <DefinitionList
            items={[
              ["Model", [f.manufacturer, f.model].filter(Boolean).join(" ") || <Faint>Not shown</Faint>],
              ["Software", f.firmware ? <span className="mono">{f.firmware}</span> : <Faint>Not shown</Faint>],
              ["Hardware", f.hardware ? <span className="mono">{f.hardware}</span> : <Faint>Not shown</Faint>],
              ["Serial number", f.serial ? <span className="mono">{f.serial}</span> : <Faint>Not shown</Faint>],
              ["Address", <span key="a" className="mono">{o.gateway}</span>],
              ["Internet-side MAC", f.wanMac ? <span className="mono">{f.wanMac}</span> : <Faint>Not shown</Faint>],
              ["First used", f.firstUse ? fmt.date(f.firstUse, { year: true }) : <Faint>Not shown</Faint>],
            ]}
          />
          </div>
          {access}
        </div>
      )}
    </Panel>
  );
}
