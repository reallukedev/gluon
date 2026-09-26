"use client";
import * as React from "react";
import Link from "next/link";
import { AppWindow, Globe, Wifi, Cpu, Database, HardDrive, ShieldCheck } from "iconoir-react";
import type { CheckupKind, CheckupRunRow, CheckupTargets, CheckState } from "@/lib/diagnostics-types";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Panel, Empty } from "@/components/ui/Surface";
import { Time } from "@/components/ui/Time";
import { Disclosure } from "@/components/ui/Disclosure";
import { Mark } from "./Instruments";
import s from "./checkup.module.css";

type Targeted = Exclude<CheckupKind, "full">;

interface Symptom {
  kind: Targeted;
  label: string;
  hint: string;
  icon: React.ReactNode;
  pick?: "apps" | "addresses" | "disks";
  placeholder?: string;
}

const SYMPTOMS: Symptom[] = [
  { kind: "app", label: "An app won't open", hint: "Follows it from the address to the container", icon: <AppWindow />, pick: "apps", placeholder: "Pick the app" },
  { kind: "address", label: "A public address isn't working", hint: "DNS, Caddy, certificate and the app behind it", icon: <Globe />, pick: "addresses", placeholder: "Pick the address" },
  { kind: "internet", label: "The internet feels slow", hint: "Router, lookups, delay and a small speed test", icon: <Wifi /> },
  { kind: "server", label: "The server feels slow", hint: "Processor, memory, disks and what's busy", icon: <Cpu /> },
  { kind: "space", label: "Running out of space", hint: "What's full, what's big, what can go", icon: <Database /> },
  { kind: "drive", label: "A drive is acting up", hint: "Health counters, self-test and the kernel log", icon: <HardDrive />, pick: "disks", placeholder: "Pick the drive" },
  { kind: "safety", label: "Is my server safe on the internet?", hint: "What's exposed, logins, SSH and two-step", icon: <ShieldCheck /> },
];

function options(pick: NonNullable<Symptom["pick"]>, t: CheckupTargets) {
  if (pick === "apps") return t.apps.map((a) => {
    const twin = t.apps.some((b) => b.id !== a.id && b.name === a.name);
    return { value: a.id, label: `${a.name}${twin ? ` · ${a.id}` : ""}${a.running ? "" : " (stopped)"}` };
  });
  if (pick === "addresses") return t.addresses.map((a) => ({ value: a.id, label: `${a.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}${a.enabled ? "" : " (off)"}` }));
  return t.disks.map((d) => ({ value: d.id, label: `${d.title} · ${d.name}${d.model ? ` · ${d.model}` : ""}` }));
}

/** "Check something specific": one row per plain-language symptom; the ones about one thing ask which. */
export function Symptoms({ targets, busy, onRun }: { targets: CheckupTargets | null; busy: boolean; onRun: (kind: Targeted, target: string | null) => void }) {
  const [picked, setPicked] = React.useState<Partial<Record<Targeted, string>>>({});
  return (
    <Panel title="Check something specific" flush>
      <ul className={s.symptoms} role="list">
        {SYMPTOMS.map((sym) => {
          const opts = sym.pick && targets ? options(sym.pick, targets) : [];
          const value = picked[sym.kind] ?? "";
          const needs = !!sym.pick;
          const empty = needs && targets !== null && opts.length === 0;
          return (
            <li key={sym.kind} className={s.symptom}>
              <span className={s.symIcon} aria-hidden>
                {sym.icon}
              </span>
              <span className={s.symText}>
                <span className={s.symLabel}>{sym.label}</span>
                <span className={s.symHint}>{empty ? `Nothing to pick: no ${sym.pick === "disks" ? "drives" : sym.pick === "apps" ? "apps with a web page" : "public addresses"} found.` : sym.hint}</span>
              </span>
              <span className={s.symPick}>
                {needs && !empty && (
                  <Select<string>
                    aria-label={sym.placeholder}
                    value={value}
                    placeholder={targets ? sym.placeholder : "Loading…"}
                    disabled={!targets}
                    onChange={(v) => setPicked((p) => ({ ...p, [sym.kind]: v }))}
                    options={opts}
                  />
                )}
              </span>
              <Button className={s.symGo} size="sm" disabled={busy || empty || (needs && !value)} onClick={() => onRun(sym.kind, needs ? value : null)}>
                Check
              </Button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

export function rowState(r: CheckupRunRow): CheckState | "running" {
  if (r.status === "running") return "running";
  if (r.status !== "done" || !r.counts) return "skip";
  return r.counts.fail ? "fail" : r.counts.warn ? "warn" : "ok";
}

const SHOWN = 8;

function HistoryRow({ r, current, hrefFor }: { r: CheckupRunRow; current: string | null; hrefFor: (id: string) => string }) {
  const st = rowState(r);
  return (
    <li className={s.hist}>
      <Link href={hrefFor(r.id)} className={s.histLink} aria-current={current === r.id ? "true" : undefined} scroll={false}>
        <Mark state={st} />
        <span className={s.histText}>
          <span className={s.histTitle}>{r.title}</span>
          <span className={s.histVerdict}>{r.status === "running" ? "Running now" : r.status === "cancelled" ? "Stopped before it finished" : (r.verdict ?? "")}</span>
        </span>
        <span className={s.histWhen}>
          <Time ts={r.startedAt} />
        </span>
      </Link>
    </li>
  );
}

/** Recent checkups, newest first; the one on screen is marked. */
export function History({ runs, current, hrefFor }: { runs: CheckupRunRow[]; current: string | null; hrefFor: (id: string) => string }) {
  return (
    <Panel title="Recent checkups" meta={runs.length ? <span className="num">{runs.length}</span> : undefined} flush>
      {!runs.length ? (
        <Empty title="No checkups yet">Each checkup is kept here with what it found, so the next one can tell you what's new and what got fixed.</Empty>
      ) : (
        <>
          <ul className={s.history} role="list">
            {runs.slice(0, SHOWN).map((r) => (
              <HistoryRow key={r.id} r={r} current={current} hrefFor={hrefFor} />
            ))}
          </ul>
          {runs.length > SHOWN && (
            <Disclosure variant="panel" summary={`${runs.length - SHOWN} older`}>
              <ul className={`${s.history} ${s.historyMore}`} role="list">
                {runs.slice(SHOWN).map((r) => (
                  <HistoryRow key={r.id} r={r} current={current} hrefFor={hrefFor} />
                ))}
              </ul>
            </Disclosure>
          )}
          <p className={s.histFoot}>Gluon keeps the last 50 checkups.</p>
        </>
      )}
    </Panel>
  );
}
