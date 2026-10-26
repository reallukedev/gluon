"use client";
import * as React from "react";
import type { DnsResult } from "@/lib/network-types";
import { CopyButton } from "@/components/ui/CopyButton";
import { StateLine } from "@/components/ui/StateLine";
import { useDnsLookup } from "./shared";
import d from "./dns.module.css";

/**
 * What a name needs in DNS, without assuming who hosts the domain: the A (and AAAA) record to add,
 * with copy buttons, or a plain "already points here". Cloudflare's proxy only comes up when the
 * name's answers really are Cloudflare's.
 */

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function useSettled<T>(value: T, ms = 600): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface Props {
  host: string;
  baseDomain: string;
  /** What connects: web browsers go through any proxy, chat and voice apps can't. */
  purpose: "web" | "chat" | "voice";
  /** Known from the last status check, so a saved address doesn't need a lookup. */
  known?: DnsResult | null;
  publicIp: { v4: string | null; v6: string[] } | null;
}

export function DnsHelp({ host, baseDomain, purpose, known, publicIp }: Props) {
  const settled = useSettled(host.trim().toLowerCase());
  const valid = HOST_RE.test(settled) && settled === host.trim().toLowerCase();
  const covered = settled.endsWith(`.${baseDomain}`) && !settled.slice(0, -baseDomain.length - 1).includes(".");
  const look = useDnsLookup(valid && !known ? settled : null);
  if (!valid) return null;
  const dns = known ?? look.data?.dns ?? null;
  const ip = look.data?.publicIp ?? publicIp;
  const apps = purpose === "chat" ? "chat apps" : "voice apps";

  if (!dns) {
    if (look.isLoading) return <p className={d.faint}>Looking up {settled}…</p>;
    if (covered) return <p className={d.faint}>The *.{baseDomain} record already points {settled} at your router, so DNS needs nothing new.</p>;
  }
  if (dns?.status === "ok" && dns.proxied) {
    if (purpose === "web") return <p className={d.faint}>{settled} goes through Cloudflare&rsquo;s proxy, which passes web visits on to this server.</p>;
    return (
      <div className={d.box}>
        <span className={d.state}>
          <StateLine state="attention" label={`${settled} answers with Cloudflare's addresses`} />
        </span>
        <p className={d.text}>Cloudflare&rsquo;s proxy only carries web traffic, so {apps} can&rsquo;t connect through it. In Cloudflare, turn the proxy off for this name (the grey cloud) so it points straight at {ip?.v4 ?? "your internet address"}.</p>
      </div>
    );
  }
  if (dns?.status === "ok" && dns.matchesPublicIp !== false) {
    return (
      <span className={d.state}>
        <StateLine state="running" label={`${settled} already points at this network, so DNS needs nothing new.`} />
      </span>
    );
  }

  const records = [
    { type: "A", value: ip?.v4 ?? null, now: dns?.a ?? [] },
    ...(ip?.v6[0] ? [{ type: "AAAA", value: ip.v6[0], now: dns?.aaaa ?? [] }] : []),
  ];
  const mismatch = dns?.status === "mismatch";
  return (
    <div className={d.box}>
      <p className={d.text}>
        {mismatch ? (
          <>
            {settled} points somewhere else right now ({[...(dns?.a ?? []), ...(dns?.aaaa ?? [])].join(", ")}). Change {records.length > 1 ? "these records" : "its record"} wherever the domain&rsquo;s DNS is managed:
          </>
        ) : (
          <>
            {dns?.status === "error" ? `Gluon couldn't look up ${settled} just now. If it doesn't exist yet, add` : `${settled} has no DNS record yet. Add`} {records.length > 1 ? "these records" : "this record"} wherever the domain&rsquo;s DNS is managed:
          </>
        )}
      </p>
      <div className={d.table} role="table" aria-label={`DNS records for ${settled}`}>
        <div className={d.head} role="row">
          <span role="columnheader">Type</span>
          <span role="columnheader">Name</span>
          <span role="columnheader">Points at</span>
        </div>
        {records.map((r) => (
          <div key={r.type} className={d.rec} role="row">
            <span role="cell" className={`${d.type} mono`}>
              {r.type}
            </span>
            <span role="cell" className={d.cell}>
              <span className="mono">{settled}</span>
              <CopyButton value={settled} label={`Copy the name ${settled}`} />
            </span>
            <span role="cell" className={d.cell}>
              {r.value ? (
                <>
                  <span className="mono">{r.value}</span>
                  <CopyButton value={r.value} label={`Copy ${r.value}`} />
                </>
              ) : (
                <span className={d.faint}>your internet address (Gluon doesn&rsquo;t know it yet)</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
