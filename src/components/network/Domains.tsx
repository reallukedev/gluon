"use client";
import * as React from "react";
import Link from "next/link";
import { NavArrowRight } from "iconoir-react";
import { LinkButton } from "@/components/ui/Button";
import { Panel, Skeleton } from "@/components/ui/Surface";
import { StateLine } from "@/components/ui/StateLine";
import { AppIcon } from "@/components/apps/AppIcon";
import type { LineState } from "@/lib/types";
import type { CloudflareStatus, CloudflareZoneT } from "@/lib/cloudflare-types";
import type { RoutesConfigT } from "@/lib/network-types";
import { CLOUDFLARE_ICON } from "@/components/settings/Cloudflare";
import d from "./domains.module.css";

/**
 * The domains public addresses live under. With Cloudflare connected, every domain the token can
 * see, each opening its full DNS records; without it, one line saying what connecting would do.
 */

const inZone = (h: string, z: string) => h === z || h.endsWith(`.${z}`);

/** The most specific domain holding `host`. */
export function zoneOfHost(zones: CloudflareZoneT[], host: string): CloudflareZoneT | null {
  return zones.filter((z) => inZone(host, z.name)).sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}

export function Domains({ cf, config }: { cf: CloudflareStatus | undefined; config: RoutesConfigT }) {
  if (!cf) {
    return (
      <Panel title="Domains" flush>
        <div className={d.pad}>
          <Skeleton height={44} radius={8} />
        </div>
      </Panel>
    );
  }
  if (!cf.connected) {
    return (
      <Panel title="Domains" flush>
        <div className={d.connect}>
          <AppIcon src={CLOUDFLARE_ICON} name="Cloudflare" size={28} />
          <p className={d.connectText}>Connect Cloudflare to give apps addresses in any of your domains. Gluon writes their DNS records and keeps them on this network&rsquo;s address.</p>
          <LinkButton size="sm" href="/settings/integrations#cloudflare">
            Connect Cloudflare
          </LinkButton>
        </div>
      </Panel>
    );
  }

  const base = config.base_domain;
  const hosts = [base, ...config.routes.flatMap((r) => (r.type === "subdomain" && r.enabled !== false ? [r.host] : []))];
  const rows = cf.zones.map((z) => {
    const count = hosts.filter((h) => zoneOfHost(cf.zones, h)?.id === z.id).length;
    const names = cf.sync.names.filter((n) => n.zone === z.name);
    const conflicts = names.filter((n) => n.state === "conflict").length;
    const errors = names.filter((n) => n.state === "error").length;
    const holdsBase = zoneOfHost(cf.zones, base)?.id === z.id;
    const line: { state: LineState; text: string } | null = errors
      ? { state: "unhealthy", text: `Cloudflare refused ${errors === 1 ? "a change" : `${errors} changes`}` }
      : conflicts
        ? { state: "attention", text: `${conflicts === 1 ? "1 name has" : `${conflicts} names have`} records Gluon didn't make` }
        : count
          ? { state: "running", text: `${count === 1 ? "1 address" : `${count} addresses`}${holdsBase ? ", including the base domain" : ""}` }
          : null;
    return { z, line, holdsBase };
  });

  return (
    <Panel
      title="Domains"
      flush
      meta={
        <Link className={d.meta} href="/settings/integrations#cloudflare">
          Cloudflare settings
        </Link>
      }
    >
      <ul className={d.list}>
        {rows.map(({ z, line }) => (
          <li key={z.id}>
            <Link className={d.row} href={`/network/domains/${encodeURIComponent(z.name)}`}>
              <span className={d.name}>
                <span className="mono">{z.name}</span>
                <span className={d.account}>{z.accountName}</span>
              </span>
              <span className={d.state}>{line ? <StateLine state={line.state} size={11} label={line.text} /> : <span className={d.faint}>No addresses yet</span>}</span>
              <span className={d.go}>
                DNS records <NavArrowRight aria-hidden />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
