"use client";
import * as React from "react";
import { Internet, Cloud, CloudSync, HomeSimpleDoor, Server, AppWindow, Xmark } from "iconoir-react";
import type { LineState } from "@/lib/types";
import { StateLine } from "@/components/ui/StateLine";
import { IconButton } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Surface";
import { prefersReducedMotion } from "@/lib/client/motion";
import type { HopId, HopState } from "./model";
import m from "./map.module.css";

/**
 * The map: how a visitor reaches an app. Internet → Cloudflare (two lanes: direct, where Cloudflare
 * only answers the DNS lookup, and proxied, where its servers carry the traffic) → your router →
 * the web server (Caddy) on this machine → apps. Every hop is a button carrying its health in
 * StateLine grammar; pressing one opens its details under the map. Horizontal on wide screens,
 * vertical on phones (the two lanes then sit side by side).
 */

export interface MapModel {
  baseDomain: string;
  serverName: string;
  direct: HopState;
  proxy: HopState;
  router: HopState & { ip: string | null };
  caddy: HopState & { certs: number; nextDays: number | null };
  apps: HopState & { count: number };
  directCount: number;
  proxyCount: number;
}

interface Props {
  model: MapModel;
  open: HopId | null;
  onOpen: (hop: HopId | null) => void;
  onApps: () => void;
  detailsId: string;
  children?: React.ReactNode;
  detailsTitle?: string;
}

export function NetworkMap({ model, open, onOpen, onApps, detailsId, children, detailsTitle }: Props) {
  const toggle = (hop: HopId) => onOpen(open === hop ? null : hop);
  // On phones the details sit below the whole vertical map: bring them into view.
  React.useEffect(() => {
    if (!open || open === "apps" || !window.matchMedia("(max-width: 900px)").matches) return;
    document.getElementById(detailsId)?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [open, detailsId]);
  const b = model.baseDomain;
  return (
    <div className={m.wrap}>
      <figure className={m.map} aria-label="How visitors reach your apps">
        <div className={m.zones} aria-hidden>
          <span className={m.zoneCf}>Cloudflare DNS</span>
          <span className={m.zoneHome}>Your home</span>
        </div>
        <div className={m.grid}>
          <div className={`${m.node} ${m.visitor}`}>
            <span className={m.nodeHead}>
              <Internet className={m.icon} />
              <span className={m.nodeTitle}>Anyone</span>
            </span>
            <span className={m.nodeSub}>on the internet</span>
          </div>

          <Wire kind="fork" area={m.fork} />

          <Hop
            area={m.direct}
            icon={<Cloud />}
            title="Direct"
            sub={`name.${b}`}
            st={model.direct}
            count={model.directCount}
            selected={open === "dns"}
            controls={detailsId}
            onClick={() => toggle("dns")}
            label={`Direct lane, DNS for name.${b}`}
          />
          <Hop
            area={m.proxy}
            icon={<CloudSync />}
            title="Through Cloudflare"
            sub={`${b}/…`}
            st={model.proxy}
            count={model.proxyCount}
            selected={open === "dns"}
            controls={detailsId}
            onClick={() => toggle("dns")}
            label={`Cloudflare lane, proxy for ${b}`}
          />

          <Wire kind="merge" area={m.merge} />

          <Hop
            area={m.router}
            icon={<HomeSimpleDoor />}
            title="Your router"
            sub={model.router.ip ?? "address unknown"}
            subMono={!!model.router.ip}
            st={model.router}
            selected={open === "router"}
            controls={detailsId}
            onClick={() => toggle("router")}
            label="Your router and internet address"
          />
          <Wire kind="line" area={m.w1} />
          <Hop
            area={m.caddy}
            icon={<Server />}
            title="Web server"
            sub={`Caddy on ${model.serverName}`}
            st={model.caddy}
            selected={open === "caddy"}
            controls={detailsId}
            onClick={() => toggle("caddy")}
            label="Web server (Caddy) and certificates"
          />
          <Wire kind="line" area={m.w2} />
          <Hop
            area={m.apps}
            icon={<AppWindow />}
            title="Apps"
            sub={model.apps.state === null && !model.apps.count ? "" : `${model.apps.count} on the internet`}
            st={model.apps}
            onClick={onApps}
            label="Apps on the internet: go to the list"
          />
        </div>
        <figcaption className={m.lanes}>
          <p>
            <Cloud className={m.laneKey} aria-hidden />
            <span>
              <b>Direct</b> <span className="mono">name.{b}</span>: visitors connect straight to your home. No size limits, so it suits video and big uploads; your home&rsquo;s internet address is visible to them.
            </span>
          </p>
          <p>
            <CloudSync className={m.laneKey} aria-hidden />
            <span>
              <b>Through Cloudflare</b> <span className="mono">{b}/…</span>: Cloudflare stands in between and hides your address, but uploads over 100 MB fail and streaming video breaks its rules.
            </span>
          </p>
        </figcaption>
      </figure>

      {open && open !== "apps" && (
        <section id={detailsId} className={m.details} aria-label={detailsTitle} data-motion-gentle="">
          <div className={m.detailsHead}>
            <h3 className={m.detailsTitle}>{detailsTitle}</h3>
            <IconButton label="Close details" size="sm" onClick={() => onOpen(null)}>
              <Xmark />
            </IconButton>
          </div>
          {children}
        </section>
      )}
    </div>
  );
}

function Hop({
  area,
  icon,
  title,
  sub,
  subMono,
  st,
  count,
  selected,
  controls,
  onClick,
  label,
}: {
  area: string;
  icon: React.ReactNode;
  title: string;
  sub: string;
  subMono?: boolean;
  st: HopState;
  count?: number;
  selected?: boolean;
  controls?: string;
  onClick: () => void;
  label: string;
}) {
  return (
    <div className={area}>
      <button
        type="button"
        className={m.node}
        data-selected={selected ? "" : undefined}
        aria-expanded={controls ? !!selected : undefined}
        aria-controls={controls && selected ? controls : undefined}
        aria-label={`${label}. ${st.label || "Checking"}.`}
        title={st.sentence || undefined}
        onClick={onClick}
      >
        <span className={m.nodeHead}>
          <span className={m.icon} aria-hidden>
            {icon}
          </span>
          <span className={m.nodeTitle}>{title}</span>
          {count !== undefined && count > 0 && (
            <span className={`${m.count} num`} title={`${count} address${count === 1 ? "" : "es"} use this lane`}>
              {count}
            </span>
          )}
        </span>
        {sub && <span className={`${m.nodeSub} ${subMono ? "mono" : ""}`}>{sub}</span>}
        <span className={m.nodeState}>{st.state ? <StateLine state={st.state as LineState} label={st.label} /> : <Skeleton width={96} height={12} />}</span>
      </button>
    </div>
  );
}

/** Connectors drawn in hairlines. The SVG stretches to its cell; the stroke stays 1px. */
function Wire({ kind, area }: { kind: "fork" | "merge" | "line"; area: string }) {
  if (kind === "line") return <span className={`${area} ${m.wire}`} aria-hidden />;
  const h = kind === "fork" ? ["M0,50 C50,50 50,25 100,25", "M0,50 C50,50 50,75 100,75"] : ["M0,25 C50,25 50,50 100,50", "M0,75 C50,75 50,50 100,50"];
  const v = kind === "fork" ? ["M50,0 C50,50 25,50 25,100", "M50,0 C50,50 75,50 75,100"] : ["M25,0 C25,50 50,50 50,100", "M75,0 C75,50 50,50 50,100"];
  return (
    <span className={`${area} ${m.split}`} aria-hidden>
      <svg className={m.splitH} viewBox="0 0 100 100" preserveAspectRatio="none">
        <path d={h[0]} data-lane="direct" />
        <path d={h[1]} data-lane="cloudflare" />
      </svg>
      <svg className={m.splitV} viewBox="0 0 100 100" preserveAspectRatio="none">
        <path d={v[0]} data-lane="direct" />
        <path d={v[1]} data-lane="cloudflare" />
      </svg>
    </span>
  );
}
