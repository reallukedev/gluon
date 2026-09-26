"use client";
import * as React from "react";
import { Refresh } from "iconoir-react";
import type { ExposureReport, LanExposure, ListenScope, LoginInfo } from "@/lib/network-types";
import type { LineState } from "@/lib/types";
import { useFormat } from "@/components/PrefsProvider";
import { Panel, Notice, Skeleton, Empty } from "@/components/ui/Surface";
import { IconButton, LinkButton } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Field";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import { Disclosure } from "@/components/ui/Disclosure";
import s from "./network.module.css";

/**
 * Everything else on this server that answers connections, which only devices at home can reach
 * (the router forwards web traffic to the web server alone). Problems first, the full list folded.
 */

const SCOPE: Record<ListenScope, string> = {
  all: "Every device at home",
  lan: "Devices at home, one address",
  link: "Nearby devices only",
  containers: "Apps on this server",
  local: "This server only",
};

function loginLine(l: LoginInfo | null | undefined): { state: LineState; label: string } {
  if (!l) return { state: "unknown", label: "—" };
  if (l.verdict === "login") return { state: "running", label: l.declared === "yes" ? "Has its own login" : "Asks for a login" };
  if (l.verdict === "no-login") return { state: "attention", label: "No login" };
  return { state: "unknown", label: "Not sure" };
}

export function HomeReach({ report, error, refreshing, onRefresh }: { report: ExposureReport | undefined; error: string | null; refreshing: boolean; onRefresh: () => void }) {
  const fmt = useFormat();
  const [showAll, setShowAll] = React.useState(false);
  const [showSystem, setShowSystem] = React.useState(false);
  const [showLocal, setShowLocal] = React.useState(false);

  const flags = (report?.flags ?? []).filter((f) => f.id.startsWith("exposure.db:") || f.id.startsWith("exposure.lan:"));
  const flagged = new Set(flags.map((f) => f.id.split(":").slice(1).join(":")));
  const rows = (report?.lan ?? [])
    .filter((l) => (showSystem || !l.system) && (showLocal || l.scope !== "local"))
    .sort((a, b) => Number(flagged.has(b.key)) - Number(flagged.has(a.key)));
  const hiddenSystem = report?.lan.filter((l) => l.system).length ?? 0;
  const hiddenLocal = report?.lan.filter((l) => !l.system && l.scope === "local").length ?? 0;

  return (
    <Panel
      title="Only reachable at home"
      meta={
        <>
          {report && (
            <span className={s.metaHide}>
              Checked <Time ts={report.checkedAt} />
            </span>
          )}
          <IconButton label="Check again" size="sm" loading={refreshing} onClick={onRefresh}>
            <Refresh />
          </IconButton>
        </>
      }
      flush
    >
      {error && !report ? (
        <div className={s.pad}>
          <Notice tone="fault" title="Couldn't look at what's listening">{error}</Notice>
        </div>
      ) : !report ? (
        <div className={s.pad}>
          <Skeleton height={16} width="60%" />
          <Skeleton height={44} radius={8} style={{ marginTop: 12 }} />
        </div>
      ) : (
        <>
          <p className={s.panelNote}>
            {report.counts.lanAllInterfaces === 0
              ? "Nothing else on this server accepts connections from other devices."
              : `${fmt.plural(report.counts.lanAllInterfaces, "other service")} on this server ${report.counts.lanAllInterfaces === 1 ? "accepts" : "accept"} connections from devices at home (and anything on your Wi-Fi). They aren't reachable from the internet.`}
          </p>
          {flags.length > 0 && (
            <ul className={s.flags} role="list">
              {flags.map((f) => (
                <li key={f.id} className={s.fix} data-tone={f.severity === "info" ? "info" : "attention"}>
                  <span className={s.fixMark} aria-hidden />
                  <p className={s.fixText}>
                    <b>{f.title}.</b> {f.detail}
                  </p>
                  {f.href && (
                    <span className={s.fixActions}>
                      <LinkButton size="sm" href={f.href}>
                        Open the app
                      </LinkButton>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <Disclosure variant="panel" summary="Everything listening" meta={<span className="num">{report.lan.filter((l) => !l.system && l.scope !== "local").length}</span>} open={showAll} onOpenChange={setShowAll}>
            {(hiddenLocal > 0 || hiddenSystem > 0) && (
              <div className={s.foldRow}>
                <span className={s.metaChecks}>
                  {hiddenLocal > 0 && (
                    <Checkbox checked={showLocal} onChange={setShowLocal}>
                      Also this server only ({hiddenLocal})
                    </Checkbox>
                  )}
                  {hiddenSystem > 0 && (
                    <Checkbox checked={showSystem} onChange={setShowSystem}>
                      Also housekeeping ({hiddenSystem})
                    </Checkbox>
                  )}
                </span>
              </div>
            )}
            {rows.length === 0 ? (
              <Empty title="Nothing to show">Gluon couldn&rsquo;t list what&rsquo;s listening, or the filters hide everything.</Empty>
            ) : (
              <div role="table" aria-label="Reachable at home" className={`${s.table} ${s.flushTable}`}>
                <div role="row" className={`${s.thead} ${s.lanGrid}`}>
                  <span role="columnheader">Port</span>
                  <span role="columnheader">Service</span>
                  <span role="columnheader">Who can connect</span>
                  <span role="columnheader">Login</span>
                </div>
                {rows.map((l) => (
                  <LanRow key={l.key} l={l} flagged={flagged.has(l.key)} />
                ))}
              </div>
            )}
          </Disclosure>
        </>
      )}
    </Panel>
  );
}

function LanRow({ l, flagged }: { l: LanExposure; flagged: boolean }) {
  const ll = loginLine(l.login);
  const owner = l.container ? l.container.name : l.unit ? l.unit.replace(/\.service$/, "") : l.process;
  return (
    <div role="row" className={`${s.trow} ${s.lanGrid}`} data-flagged={flagged ? "" : undefined}>
      <span role="cell" className={`${s.portCell} mono num`}>
        {l.port}/{l.proto}
      </span>
      <span role="cell" className={s.cellMain}>
        <span className={s.cellText} title={l.label}>
          {l.label}
        </span>
        <span className={s.cellSub}>
          {owner && owner !== l.label ? owner : null}
          {l.published ? `${owner && owner !== l.label ? " · " : ""}container port ${l.published.containerPort}` : ""}
          {l.publicRoutes.length ? " · also on the internet" : ""}
        </span>
      </span>
      <span role="cell" className={s.cellMain}>
        <span className={s.cellText}>{SCOPE[l.scope]}</span>
        <span className={`${s.cellSub} mono`} title={l.addresses.join(", ")}>
          {l.addresses.join(" ")}
        </span>
      </span>
      <span role="cell" className={s.cellMain} title={l.login?.evidence ?? undefined}>
        {l.login ? <StateLine state={ll.state} label={ll.label} /> : <span className={s.faint}>{l.scope === "local" ? "Not reachable from other devices" : "—"}</span>}
      </span>
    </div>
  );
}
