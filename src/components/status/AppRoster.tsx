"use client";
import * as React from "react";
import Link from "next/link";
import { OpenNewWindow } from "iconoir-react";
import type { StatusApp } from "@/server/status";
import type { Finding } from "@/server/findings";
import type { LineState } from "@/lib/types";
import { useLive } from "@/lib/client/live";
import { usePrefs, useFormat } from "@/components/PrefsProvider";
import { instanceHints, sourceName } from "@/lib/app-names";
import { StateLine } from "@/components/ui/StateLine";
import { Disclosure } from "@/components/ui/Disclosure";
import { AppIcon } from "@/components/apps/AppIcon";
import { CpuMeter, MemMeter, useAppUsage } from "@/components/apps/Meters";
import r from "./roster.module.css";

/**
 * Every app on the server in plain words: what state it's in, what it's using, and a way in.
 * Apps that aren't right come first; stopped apps and old copies left by another installer fold
 * away, since nobody needs to read them to know whether things are fine.
 */
export function AppRoster({ apps, findings }: { apps: StatusApp[]; findings: Finding[] }) {
  const { viewer, prefs } = usePrefs();
  const fmt = useFormat();
  const { host } = useLive();
  const memTotal = host.at(-1)?.mem.total ?? null;

  const byId = React.useMemo(() => new Map(apps.map((a) => [a.id, a])), [apps]);
  const findingFor = React.useMemo(() => {
    const m = new Map<string, Finding>();
    for (const f of findings) if (f.subject && byId.has(f.subject) && !m.has(f.subject)) m.set(f.subject, f);
    return m;
  }, [findings, byId]);

  const current = apps.filter((a) => !(a.copyOf && byId.has(a.copyOf.id)));
  const copies = apps.filter((a) => a.copyOf && byId.has(a.copyOf.id));
  const hints = instanceHints(current);
  const usage = useAppUsage(apps);
  const memScale = Math.max(0, ...[...usage.values()].map((u) => u.mem));

  const needsLook = (a: StatusApp) => findingFor.has(a.id) || a.line === "unhealthy" || a.line === "starting" || a.line === "paused" || a.line === "unknown";
  const byName = (x: StatusApp, y: StatusApp) => x.name.localeCompare(y.name);
  const trouble = current.filter(needsLook).sort((x, y) => rank(x, findingFor) - rank(y, findingFor) || byName(x, y));
  const running = current.filter((a) => !needsLook(a) && a.line === "running").sort(byName);
  const stopped = current.filter((a) => !needsLook(a) && a.line === "stopped").sort(byName);

  const row = (a: StatusApp, opts: { copy?: boolean } = {}) => (
    <RosterRow
      key={a.id}
      app={a}
      hint={opts.copy ? `Old copy from ${sourceName(a.source)}` : hints.get(a.id) ?? null}
      finding={findingFor.get(a.id) ?? null}
      usage={usage.get(a.id) ?? null}
      memScale={memScale}
      memTotal={memTotal}
      openHref={openHref(a.urls, viewer.zone)}
      newTab={prefs.openLinks === "new"}
    />
  );

  if (!current.length) {
    return <p className={r.none}>No apps are installed yet. Apps you install from the app store, or start with Docker, show up here.</p>;
  }

  return (
    <div className={r.roster}>
      <div className={r.head} aria-hidden>
        <span>App</span>
        <span>State</span>
        <span className={`${r.headNum} ${r.cpu}`}>CPU</span>
        <span className={r.headNum}>Memory</span>
        <span />
      </div>
      {trouble.length > 0 && (
        <section aria-label="Apps that need a look">
          <h3 className={`label ${r.group}`}>
            Not right <span className="num">{trouble.length}</span>
          </h3>
          <ul className={r.list} role="list">
            {trouble.map((a) => row(a))}
          </ul>
        </section>
      )}
      <section aria-label="Running apps">
        {trouble.length > 0 && (
          <h3 className={`label ${r.group}`}>
            Running <span className="num">{running.length}</span>
          </h3>
        )}
        {running.length ? (
          <ul className={r.list} role="list">
            {running.map((a) => row(a))}
          </ul>
        ) : (
          <p className={r.none}>Nothing else is running.</p>
        )}
      </section>
      {(stopped.length > 0 || copies.length > 0) && (
        <div className={r.folds}>
          {stopped.length > 0 && (
            <Disclosure
              variant="panel"
              summary={`${fmt.plural(stopped.length, "stopped app")}`}
              meta={<span className={r.foldMeta}>{listNames(stopped)}</span>}
            >
              <ul className={r.list} role="list">
                {stopped.map((a) => row(a))}
              </ul>
            </Disclosure>
          )}
          {copies.length > 0 && (
            <Disclosure
              variant="panel"
              summary={copies.length === 1 ? "1 old copy from another installer" : `${copies.length} old copies from other installers`}
              meta={<span className={r.foldMeta}>{listNames(copies)}</span>}
            >
              <p className={r.foldNote}>
                Left behind when these apps were installed again with a different installer. The copy in use is the one above; open an old copy to
                remove it and free the space it takes.
              </p>
              <ul className={r.list} role="list">
                {copies.map((a) => row(a, { copy: true }))}
              </ul>
            </Disclosure>
          )}
        </div>
      )}
    </div>
  );
}

function RosterRow({
  app: a,
  hint,
  finding,
  usage,
  memScale,
  memTotal,
  openHref: href,
  newTab,
}: {
  app: StatusApp;
  hint: string | null;
  finding: Finding | null;
  usage: { cpu: number; mem: number; cpuSeries: number[] } | null;
  memScale: number;
  memTotal: number | null;
  openHref: string | null;
  newTab: boolean;
}) {
  const parts = a.containers.length;
  const where = [hint ?? sourceName(a.source), parts > 1 ? `${parts} parts` : null].filter(Boolean).join(" · ");
  const state = stateOf(a, finding);
  const running = a.line !== "stopped";
  return (
    <li className={r.row} data-state={state.line}>
      <Link href={`/apps/${encodeURIComponent(a.id)}`} className={r.main}>
        <AppIcon src={a.icon} name={a.name} size={32} />
        <span className={r.name}>
          <span className={r.title} title={a.name}>
            {a.name}
          </span>
          <span className={r.where}>{where}</span>
        </span>
      </Link>
      <span className={r.state}>
        <StateLine state={state.line} label={false} size={14} />
        <span className={r.stateText}>
          <span className={r.stateWord}>{state.word}</span>
          {state.why && (
            <span className={r.why} title={state.why}>
              {state.why}
            </span>
          )}
        </span>
      </span>
      <span className={`${r.meter} ${r.cpu}`}>{running ? <CpuMeter series={usage?.cpuSeries ?? null} value={usage?.cpu ?? null} name={a.name} /> : null}</span>
      <span className={`${r.meter} ${r.mem}`}>{running ? <MemMeter value={usage?.mem ?? null} scale={memScale} total={memTotal} name={a.name} /> : null}</span>
      <span className={r.open}>
        {href && a.line !== "stopped" && (
          <a href={href} className={r.openLink} target={newTab ? "_blank" : undefined} rel="noopener noreferrer" aria-label={`Open ${a.name}`}>
            Open
            <OpenNewWindow aria-hidden width={14} height={14} />
          </a>
        )}
      </span>
    </li>
  );
}

/** The state in words: one short word, and why when it isn't simply fine. */
function stateOf(a: StatusApp, finding: Finding | null): { line: LineState; word: string; why: string | null } {
  if (finding) {
    return { line: finding.severity === "fault" ? "unhealthy" : "attention", word: finding.severity === "fault" ? "Broken" : "Needs you", why: finding.title.replace(/\.$/, "") };
  }
  switch (a.line) {
    case "running":
      return { line: "running", word: "Running", why: null };
    case "starting":
      return { line: "starting", word: "Starting", why: a.summary !== "Starting" ? a.summary : null };
    case "unhealthy":
      return { line: "unhealthy", word: "Not right", why: a.summary };
    case "stopped":
      return { line: "stopped", word: "Stopped", why: null };
    case "paused":
      return { line: "paused", word: "Paused", why: null };
    default:
      return { line: a.line, word: a.summary || "Unknown", why: null };
  }
}

function rank(a: StatusApp, findings: Map<string, Finding>): number {
  const f = findings.get(a.id);
  if (f?.severity === "fault" || a.line === "unhealthy") return 0;
  if (f) return 1;
  return 2;
}

function listNames(apps: StatusApp[]): string {
  const names = apps.map((a) => a.name);
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
}

function openHref(urls: StatusApp["urls"], zone: string): string | null {
  return zone === "home" ? (urls.home ?? urls.away) : (urls.away ?? urls.home);
}
