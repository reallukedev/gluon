"use client";
import * as React from "react";
import Link from "next/link";
import { OpenNewWindow } from "iconoir-react";
import type { StatusApp } from "@/server/status";
import type { Finding } from "@/server/findings";
import { findingWord } from "@/lib/finding-words";
import { trouble } from "@/components/apps/plain";
import type { LineState } from "@/lib/types";
import { usePrefs, useFormat } from "@/components/PrefsProvider";
import { instanceHints, sourceName } from "@/lib/app-names";
import { StateLine } from "@/components/ui/StateLine";
import { Disclosure } from "@/components/ui/Disclosure";
import { Tooltip } from "@/components/ui/Tooltip";
import { AppIcon } from "@/components/apps/AppIcon";
import r from "./roster.module.css";

/**
 * Every app on the server: icon, name, state in a word, a way in. Apps that aren't right come first
 * with a link to their fix in Needs you; stopped apps and old copies left by another installer fold
 * away. How each app is put together (Compose, parts) is in the name's tooltip, one step deeper.
 */
export function AppRoster({ apps, findings }: { apps: StatusApp[]; findings: Finding[] }) {
  const { viewer, prefs } = usePrefs();
  const fmt = useFormat();

  const byId = React.useMemo(() => new Map(apps.map((a) => [a.id, a])), [apps]);
  const findingFor = React.useMemo(() => {
    const m = new Map<string, Finding>();
    for (const f of findings) if (f.subject && byId.has(f.subject) && !m.has(f.subject)) m.set(f.subject, f);
    return m;
  }, [findings, byId]);

  const current = apps.filter((a) => !(a.copyOf && byId.has(a.copyOf.id)));
  const copies = apps.filter((a) => a.copyOf && byId.has(a.copyOf.id));
  const hints = instanceHints(current);

  const needsLook = (a: StatusApp) => findingFor.has(a.id) || a.line === "unhealthy" || a.line === "starting" || a.line === "paused" || a.line === "unknown";
  const byName = (x: StatusApp, y: StatusApp) => x.name.localeCompare(y.name);
  const trouble = current.filter(needsLook).sort((x, y) => rank(x, findingFor) - rank(y, findingFor) || byName(x, y));
  const running = current.filter((a) => !needsLook(a) && a.line === "running").sort(byName);
  const stopped = current.filter((a) => !needsLook(a) && a.line === "stopped").sort(byName);

  const row = (a: StatusApp, opts: { copy?: boolean } = {}) => (
    <RosterRow
      key={a.id}
      app={a}
      hint={opts.copy ? `Old copy from ${sourceName(a.source)}` : (hints.get(a.id) ?? null)}
      finding={findingFor.get(a.id) ?? null}
      openHref={openHref(a.urls, viewer.zone)}
      newTab={prefs.openLinks === "new"}
    />
  );

  if (!current.length) {
    return <p className={r.none}>No apps yet. Apps from the app store or Docker show up here.</p>;
  }

  return (
    <div className={r.roster}>
      <ul className={r.list} role="list" aria-label="Apps">
        {trouble.map((a) => row(a))}
        {running.map((a) => row(a))}
      </ul>
      {(stopped.length > 0 || copies.length > 0) && (
        <div className={r.folds}>
          {stopped.length > 0 && (
            <Disclosure variant="panel" summary={fmt.plural(stopped.length, "stopped app")} meta={<span className={r.foldMeta}>{listNames(stopped)}</span>}>
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
              <p className={r.foldNote}>Left behind by a reinstall. Open one to remove it.</p>
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

function RosterRow({ app: a, hint, finding, openHref: href, newTab }: { app: StatusApp; hint: string | null; finding: Finding | null; openHref: string | null; newTab: boolean }) {
  const parts = a.containers.length;
  const how = [sourceName(a.source), parts > 1 ? `${parts} parts` : null].filter(Boolean).join(" · ");
  const state = stateOf(a, finding);
  const broken = state.line === "unhealthy" || state.line === "attention";
  return (
    <li className={r.row} data-state={state.line} data-broken={broken ? "" : undefined}>
      <Tooltip content={how}>
        <Link href={`/apps/${encodeURIComponent(a.id)}`} className={r.main} aria-label={`${a.name}${hint ? `, ${hint}` : ""}. ${how}`}>
          <span className={r.icon}>
            <AppIcon src={a.icon} name={a.name} size={36} />
          </span>
          <span className={r.name}>
            <span className={r.title}>{a.name}</span>
            {hint && <span className={r.hint}>{hint}</span>}
          </span>
        </Link>
      </Tooltip>
      <span className={r.state} title={a.summary && a.summary !== state.word ? a.summary : undefined}>
        <StateLine state={state.line} label={state.word} size={14} />
      </span>
      <span className={r.open}>
        {finding ? (
          <a href={`#${finding.id}`} className={r.openLink} title={finding.title}>
            See fix
          </a>
        ) : (
          href &&
          a.line !== "stopped" && (
            <a href={href} className={r.openLink} target={newTab ? "_blank" : undefined} rel="noopener noreferrer" aria-label={`Open ${a.name}`}>
              Open
              <OpenNewWindow aria-hidden width={14} height={14} />
            </a>
          )
        )}
      </span>
    </li>
  );
}

/** The state in one short word. Why it isn't fine lives in Needs you, right above. */
function stateOf(a: StatusApp, finding: Finding | null): { line: LineState; word: string } {
  if (finding) return { line: finding.severity === "fault" ? "unhealthy" : "attention", word: findingWord(finding) };
  switch (a.line) {
    case "running":
      return { line: "running", word: "Running" };
    case "starting":
      return { line: "starting", word: "Starting" };
    case "unhealthy":
      return { line: "unhealthy", word: trouble(a) ?? "Not working" };
    case "stopped":
      return { line: "stopped", word: "Stopped" };
    case "paused":
      return { line: "paused", word: "Paused" };
    default:
      return { line: a.line, word: a.summary || "Unknown" };
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
