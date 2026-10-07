"use client";
import * as React from "react";
import { Refresh, Code, ClockRotateRight } from "iconoir-react";
import type { DdnsStatus, DnsResult, NetworkStatus, RoutesResponse, TlsResult } from "@/lib/network-types";
import type { LineState } from "@/lib/types";
import { useFormat } from "@/components/PrefsProvider";
import { Notice, Skeleton, Empty, DefinitionList } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { Disclosure } from "@/components/ui/Disclosure";
import { certRows } from "./model";
import { DriftSentence } from "./DriftNotice";
import s from "./network.module.css";

/** What each hop of the map opens: DNS records, the router and its address updater, the web server. */

function dnsLine(d: DnsResult): { state: LineState; label: string } {
  if (d.status === "ok") return { state: "running", label: d.proxied ? "Through Cloudflare" : d.matchesPublicIp === false ? "Points elsewhere" : "Points to your router" };
  if (d.status === "missing") return { state: "unhealthy", label: "No record" };
  if (d.status === "mismatch") return { state: "attention", label: "Points elsewhere" };
  return { state: "unknown", label: "Lookup failed" };
}

function tlsLine(t: TlsResult, own: boolean): { state: LineState; label: string } {
  switch (t.status) {
    case "ok":
      return { state: "running", label: own ? `Yours · ${t.daysLeft} d left` : `Renews on its own · ${t.daysLeft} d left` };
    case "expiring":
      return { state: "attention", label: `Ends in ${t.daysLeft} d` };
    case "expired":
      return { state: "unhealthy", label: "Expired" };
    case "pending":
      return t.issueError ? { state: "attention", label: "Couldn't be issued" } : { state: "starting", label: "Being issued" };
    case "invalid":
      return { state: "attention", label: "Not trusted" };
    default:
      return { state: "unknown", label: "Check failed" };
  }
}

function CheckedLine({ status, onRecheck, checking }: { status: NetworkStatus | undefined; onRecheck: () => void; checking: boolean }) {
  return (
    <div className={s.checked}>
      {status ? (
        <span>
          Checked <Time ts={status.checkedAt} /> from outside, the way visitors see it.
        </span>
      ) : (
        <span>Checking…</span>
      )}
      <Button size="sm" icon={<Refresh />} loading={checking} onClick={onRecheck}>
        Check now
      </Button>
    </div>
  );
}

export function DnsDetails({ status, statusError, onRecheck, checking }: { status: NetworkStatus | undefined; statusError: string | null; onRecheck: () => void; checking: boolean }) {
  const records: { key: string; dns: DnsResult; note: string }[] = [];
  if (status) {
    if (status.wildcard) records.push({ key: "*", dns: status.wildcard, note: "Direct lane: covers every name.subdomain without its own record" });
    if (status.base) records.push({ key: "base", dns: status.base, note: "Cloudflare lane: short links and everything else" });
    const seen = new Set<string>();
    for (const r of status.routes) {
      if (!r.enabled || !r.dns || r.type !== "subdomain" || seen.has(r.host)) continue;
      seen.add(r.host);
      records.push({ key: r.host, dns: r.dns, note: r.app?.name ?? r.name });
    }
  }
  return (
    <div className={s.hopBody}>
      <p className={s.hopLead}>
        When someone types an address, DNS tells their browser where to go. Direct names point at your router{status?.base?.proxied ? <>; <span className="mono">{status.baseDomain}</span> points at Cloudflare, which passes visits on</> : null}. Names outside <span className="mono">{status?.baseDomain ?? "the main domain"}</span> need records wherever their own DNS is managed.
      </p>
      {statusError && !status && (
        <Notice tone="fault" title="Couldn't check DNS" action={<Button size="sm" onClick={onRecheck}>Try again</Button>}>
          {statusError}
        </Notice>
      )}
      {!status ? (
        !statusError && <Skeleton height={150} radius={8} />
      ) : (
        <div role="table" aria-label="DNS records" className={s.table}>
          <div role="row" className={`${s.thead} ${s.dnsGrid}`}>
            <span role="columnheader">Name</span>
            <span role="columnheader">Points at</span>
            <span role="columnheader">State</span>
          </div>
          {records.map((r) => {
            const l = dnsLine(r.dns);
            const ips = [...r.dns.a, ...r.dns.aaaa];
            return (
              <div role="row" key={r.key} className={`${s.trow} ${s.dnsGrid}`}>
                <span role="cell" className={s.cellMain}>
                  <span className={`${s.cellText} mono`} title={r.dns.name}>
                    {r.dns.name}
                  </span>
                  <span className={s.cellSub}>{r.note}</span>
                </span>
                <span role="cell" className={`${s.addrList} mono`} title={ips.join(", ")}>
                  {ips.length ? ips.slice(0, 3).map((ip) => <span key={ip}>{ip}</span>) : <span className={s.faint}>nothing</span>}
                  {ips.length > 3 && <span className={s.faint}>+{ips.length - 3} more</span>}
                </span>
                <span role="cell" className={s.cellMain} title={r.dns.message}>
                  <StateLine state={l.state} label={l.label} />
                  {r.dns.status !== "ok" && <span className={s.cellSub}>{r.dns.message}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <CheckedLine status={status} onRecheck={onRecheck} checking={checking} />
    </div>
  );
}

export function RouterDetails({ status, ddns, ddnsError }: { status: NetworkStatus | undefined; ddns: DdnsStatus | undefined; ddnsError: string | null }) {
  const fmt = useFormat();
  const d = ddns;
  const v6 = status?.publicIp.v6 ?? d?.ipv6?.addresses ?? [];
  return (
    <div className={s.hopBody}>
      <p className={s.hopLead}>
        Your internet provider gives your home one public address, and it can change. An updater keeps the DNS records pointing at it. Your router forwards web traffic (ports 80 and 443) to this server; Gluon can&rsquo;t see the router&rsquo;s own settings.
      </p>
      {ddnsError && !d ? (
        <Notice tone="fault" title="Couldn't read the address updater">{ddnsError}</Notice>
      ) : !d ? (
        <Skeleton height={160} radius={8} />
      ) : (
        <>
          <p className={s.hopState}>
            <StateLine state={!d.container.exists ? "unknown" : d.state === "ok" ? "running" : d.state === "fault" ? "unhealthy" : d.state === "attention" ? "attention" : "unknown"} label={d.container.exists ? d.summary : "No address updater found"} />
          </p>
          {!d.container.exists && (
            <Empty title="No address updater found">
              Gluon looks for a container named cloudflare-ddns (favonia/cloudflare-ddns). Without one, your DNS records won&rsquo;t follow if your internet address changes.
            </Empty>
          )}
          {d.errors.length > 0 && (
            <Notice tone="attention" title="On its last check">
              <ul className={s.plainList}>
                {d.errors.slice(-4).map((e, i) => (
                  <li key={i}>{e.message}</li>
                ))}
              </ul>
            </Notice>
          )}
          <DefinitionList
            items={[
              ["Internet address", status?.publicIp.v4 ?? d.ipv4?.address ? <span className="mono">{status?.publicIp.v4 ?? d.ipv4?.address}</span> : <span className={s.faint}>Unknown</span>],
              ["IPv6", v6.length ? <span className={`mono ${s.addrList}`}>{v6.map((a) => <span key={a}>{a}</span>)}</span> : <span className={s.faint}>None</span>],
              ...(d.container.exists
                ? ([
                    ["Last check", d.lastCheckAt ? <Time ts={d.lastCheckAt} /> : <span className={s.faint}>Not in the recent log</span>],
                    ["Last change", d.lastChange ? <>{d.lastChange.at ? <><Time ts={d.lastChange.at} /> · </> : null}{d.lastChange.message}</> : <span className={s.faint}>No changes in the recent log</span>],
                    [
                      "Keeps updated",
                      <span key="d" className={`mono ${s.addrList}`}>
                        {[...new Set([...d.config.domains, ...d.config.ip4Domains, ...d.config.ip6Domains])].map((x) => (
                          <span key={x}>
                            {x}
                            {d.config.proxiedDomains.includes(x) ? <span className={s.faint}> · through Cloudflare</span> : ""}
                          </span>
                        ))}
                      </span>,
                    ],
                    ["Checks", d.config.updateSchedule ? <span className="mono">{d.config.updateSchedule}</span> : <span className={s.faint}>Default schedule</span>],
                    ["Updater", <span key="u" className="mono">{d.container.name}{d.container.version ? ` v${d.container.version}` : ""}{d.container.running ? "" : " (stopped)"}</span>],
                  ] as [React.ReactNode, React.ReactNode][])
                : []),
            ]}
          />
          {d.recent.length > 0 && (
            <Disclosure summary="Updater log" meta={fmt.plural(d.recent.length, "line")}>
              <ol className={s.log}>
                {d.recent.slice(-40).map((l, i) => (
                  <li key={i} data-level={l.level}>
                    {l.at ? <Time ts={l.at} kind="time" seconds className="num" /> : <span />}
                    <span>{l.message}</span>
                  </li>
                ))}
              </ol>
            </Disclosure>
          )}
        </>
      )}
    </div>
  );
}

export function CaddyDetails({
  data,
  status,
  onRecheck,
  checking,
  onCaddyfile,
  onHistory,
}: {
  data: RoutesResponse;
  status: NetworkStatus | undefined;
  onRecheck: () => void;
  checking: boolean;
  onCaddyfile: () => void;
  onHistory: () => void;
}) {
  const certs = certRows(status);
  return (
    <div className={s.hopBody}>
      <p className={s.hopLead}>
        Caddy is the web server on this machine that answers every visit: it holds the HTTPS certificates (from Let&rsquo;s Encrypt and renewed on their own, unless you supplied your own) and hands each address to its app. Gluon writes its settings file, the Caddyfile, every time you save.
      </p>
      <p className={s.hopState}>
        <StateLine state={data.caddyRunning ? "running" : "unhealthy"} label={data.caddyRunning ? "Answering on ports 80 and 443" : "Not answering: Gluon can't reach it, so changes can't be applied"} />
      </p>
      {data.drift && (
        <Notice tone="attention" action={<Button size="sm" onClick={onCaddyfile}>Review</Button>}>
          <DriftSentence info={data.driftInfo ?? null} />
        </Notice>
      )}
      <h4 className={s.subhead}>Certificates</h4>
      {!status ? (
        <Skeleton height={120} radius={8} />
      ) : certs.length === 0 ? (
        <p className={s.faint}>No certificates yet. Put an app on the internet and Caddy fetches one within a minute.</p>
      ) : (
        <div role="table" aria-label="Certificates" className={s.table}>
          <div role="row" className={`${s.thead} ${s.certGrid}`}>
            <span role="columnheader">Name</span>
            <span role="columnheader">Valid until</span>
            <span role="columnheader">State</span>
          </div>
          {certs.map((c) => {
            const l = tlsLine(c.tls, c.own);
            return (
              <div role="row" key={c.host} className={`${s.trow} ${s.certGrid}`}>
                <span role="cell" className={s.cellMain}>
                  <span className={`${s.cellText} mono`} title={c.host}>
                    {c.host}
                  </span>
                  <span className={s.cellSub} title={[c.names.join(", "), c.tls.issuer].filter(Boolean).join(" · ")}>
                    {c.names.slice(0, 3).join(", ")}
                    {c.names.length > 3 ? ` +${c.names.length - 3}` : ""}
                    {c.tls.issuer ? ` · ${c.tls.issuer}` : ""}
                  </span>
                </span>
                <span role="cell" className={`${s.cellText} num`}>
                  {c.tls.validTo ? <Time ts={Date.parse(c.tls.validTo)} kind="date" /> : <span className={s.faint}>Not known</span>}
                </span>
                <span role="cell" className={s.cellMain} title={c.tls.message}>
                  <StateLine state={l.state} label={l.label} />
                  {c.tls.status !== "ok" && <span className={s.cellSub}>{c.tls.issueError ?? c.tls.message}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div className={s.hopActions}>
        <Button size="sm" icon={<Code />} onClick={onCaddyfile}>
          View the Caddyfile
        </Button>
        <Button size="sm" icon={<ClockRotateRight />} onClick={onHistory}>
          History
        </Button>
        <span className={s.hopActionsEnd}>
          <Button size="sm" variant="ghost" icon={<Refresh />} loading={checking} onClick={onRecheck}>
            Check now
          </Button>
        </span>
      </div>
    </div>
  );
}
