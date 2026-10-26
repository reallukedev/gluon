"use client";
// Coolify: what it's deploying, what failed, and what isn't running. Admins only.
import * as React from "react";
import type { WidgetProps } from "../../types";
import { useFormat, usePrefs } from "@/components/PrefsProvider";
import { StateLine } from "@/components/ui/StateLine";
import { Time } from "@/components/ui/Time";
import type { CoolifyDeployment, CoolifyDeploymentsData, CoolifyResource, IntegrationRef } from "@/lib/widgets-types";
import type { LineState } from "@/lib/types";
import { Gate, perSize, Quiet, RowsSkeleton, useIntegrationWidget } from "./shared";
import { useSmartUrl } from "../core";
import { spanWords } from "../kit";
import type { IntegrationConfig } from "./media";
import l from "./live.module.css";
import c from "./coolify.module.css";

const LINE: Record<CoolifyDeployment["status"], LineState> = {
  queued: "starting",
  in_progress: "starting",
  finished: "running",
  failed: "unhealthy",
  cancelled: "stopped",
};

const RESOURCE_WORD: Record<LineState, string> = {
  running: "running",
  starting: "starting",
  unhealthy: "not healthy",
  stopped: "stopped",
  paused: "paused",
  unknown: "state unknown",
  attention: "needs you",
};

/** The one sentence at the top: what's happening now, else how the last deploy went. */
function verdict(d: CoolifyDeploymentsData): string {
  if (d.active.length) {
    const running = d.active.filter((x) => x.status === "in_progress");
    const first = running[0] ?? d.active[0]!;
    if (d.active.length === 1) return first.status === "queued" ? `${first.app} is waiting to deploy.` : `Deploying ${first.app}.`;
    return `${d.active.length} deploying: ${[...new Set(d.active.map((x) => x.app))].slice(0, 2).join(", ")}${d.active.length > 2 ? " and more" : ""}.`;
  }
  const last = d.recent[0];
  if (!last) return "Nothing deploying.";
  if (last.status === "failed") return `The last deploy of ${last.app} failed.`;
  if (last.status === "cancelled") return `The last deploy of ${last.app} was cancelled.`;
  return "Nothing deploying. The last deploy worked.";
}

function useNow(everyMs: number) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function DeploymentRow({ d, href, now }: { d: CoolifyDeployment; href: string | null; now: number }) {
  const fmt = useFormat();
  const { prefs } = usePrefs();
  const took = d.finishedAt && d.startedAt && d.finishedAt > d.startedAt ? fmt.duration(Math.round((d.finishedAt - d.startedAt) / 1000), 2) : null;
  let status: React.ReactNode;
  switch (d.status) {
    case "queued":
      status = d.startedAt ? <>Waiting for {spanWords(now - d.startedAt)}</> : "Waiting";
      break;
    case "in_progress":
      status = d.startedAt ? <>Deploying for {spanWords(now - d.startedAt)}</> : "Deploying";
      break;
    case "failed":
      status = (
        <span className={l.faultText}>
          Failed{d.finishedAt ? <> <Time ts={d.finishedAt} /></> : null}
        </span>
      );
      break;
    case "cancelled":
      status = <>Cancelled{d.finishedAt ? <> <Time ts={d.finishedAt} /></> : null}</>;
      break;
    default:
      status = (
        <>
          Finished{d.finishedAt ? <> <Time ts={d.finishedAt} /></> : null}
          {took ? ` · took ${took}` : ""}
        </>
      );
  }
  const what = [d.commit, d.message].filter(Boolean).join(" ");
  const body = (
    <>
      <StateLine state={LINE[d.status]} size={14} className={c.glyph} />
      <span className={l.rowText}>
        <span className={l.rowTitle} title={d.server ? `${d.app} on ${d.server}` : d.app}>
          {d.app}
        </span>
        <span className={`${l.rowMeta} num`}>
          <span className={c.status}>{status}</span>
          {what ? (
            <span className={c.commit} title={d.message ?? undefined}>
              {d.commit ? <span className="mono">{d.commit}</span> : null}
              {d.message ? ` ${d.message}` : ""}
            </span>
          ) : null}
        </span>
      </span>
    </>
  );
  return (
    <li>
      {href ? (
        <a className={`${c.row} ${c.link}`} href={href} target={prefs.openLinks === "new" ? "_blank" : undefined} rel="noopener noreferrer" aria-label={`${d.app}: open this deployment in Coolify`}>
          {body}
        </a>
      ) : (
        <div className={c.row}>{body}</div>
      )}
    </li>
  );
}

function Resources({ r }: { r: CoolifyDeploymentsData["resources"] }) {
  if (!r.total) return null;
  if (!r.problems.length) {
    return (
      <p className={c.foot}>
        <StateLine state="running" size={11} /> {r.total === 1 ? "The one resource is running." : `All ${r.total} resources are running.`}
      </p>
    );
  }
  const names = r.problems.map((p: CoolifyResource) => `${p.name} (${RESOURCE_WORD[p.line]})`);
  const shown = names.slice(0, 3).join(", ");
  const more = r.problems.length > 3 ? ` and ${r.problems.length - 3} more` : "";
  const worst: LineState = r.problems.some((p) => p.line === "unhealthy") ? "unhealthy" : "stopped";
  return (
    <p className={c.foot} title={names.join(", ")}>
      <StateLine state={worst} size={11} />
      <span className="truncate">
        {r.problems.length} of {r.total} {r.total === 1 ? "resource isn't" : "resources aren't"} running: {shown}
        {more}
      </span>
    </p>
  );
}

export function CoolifyDeployments({ item, size }: WidgetProps<IntegrationConfig>) {
  const limit = perSize(size, { s: 2, m: 3, t: 6, l: 6, w: 4, x: 8 }, 4);
  const q = useIntegrationWidget("coolify", "coolify.deployments", item.config.integration, { limit });
  const url = useSmartUrl();
  const now = useNow(30_000);
  const ref: IntegrationRef | null = q.source.state === "ok" ? q.source.ref : null;
  const base = ref ? url(ref.links) : null;
  const hrefFor = (d: CoolifyDeployment) => {
    if (!base) return null;
    try {
      return d.path ? new URL(d.path, base).toString() : null;
    } catch {
      return null;
    }
  };
  return (
    <Gate kind="coolify" source={q.source} q={q} skeleton={<RowsSkeleton rows={size === "s" ? 1 : 3} />}>
      {(d) => {
        const rows = [...d.active, ...d.recent].slice(0, Math.max(limit, d.active.length));
        if (!rows.length && !d.resources.total) {
          return (
            <Quiet title="Nothing in Coolify yet">
              {d.historyNote ?? "When Coolify builds something, how it went shows up here."}
            </Quiet>
          );
        }
        return (
          <div className={l.col}>
            {size !== "s" && (
              <p className={c.verdict} title={verdict(d)}>
                {verdict(d)}
              </p>
            )}
            {rows.length ? (
              <ul className={`${l.list} ${c.rows}`} role="list" data-cols={size === "w" || size === "x" ? 2 : undefined}>
                {rows.map((x) => (
                  <DeploymentRow key={x.id} d={x} href={hrefFor(x)} now={now} />
                ))}
              </ul>
            ) : (
              <p className={c.none}>{d.historyNote ?? "No deployments yet. When Coolify builds something, how it went shows up here."}</p>
            )}
            <Resources r={d.resources} />
          </div>
        );
      }}
    </Gate>
  );
}
