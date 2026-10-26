"use client";
import * as React from "react";
import type { CheckPlanItem, CheckResult, CheckState, CheckupGroup } from "@/lib/diagnostics-types";
import s from "./checkup.module.css";

/** Where a check is: its result, probing now, or not reached yet. */
export type TickState = CheckState | "running" | "pending";

export const STATE_WORD: Record<TickState, string> = {
  ok: "Passed",
  warn: "Worth a look",
  fail: "Broken",
  skip: "Skipped",
  running: "Checking",
  pending: "Waiting",
};

/** StateLine geometry for a check. Probing marks keep breathing under reduced motion (opacity only). */
export function Mark({ state, className }: { state: TickState; className?: string }) {
  return <i className={`${s.mark} ${className ?? ""}`} data-state={state} data-motion-gentle={state === "running" ? "" : undefined} aria-hidden />;
}

export function tickState(id: string, results: Map<string, CheckResult>, running: Set<string>, live: boolean): TickState {
  const r = results.get(id);
  if (r) return r.state;
  if (running.has(id)) return "running";
  return live ? "pending" : "skip";
}

export function Legend() {
  return (
    <span className={s.legend}>
      {(["ok", "warn", "fail", "skip", "running"] as const).map((st) => (
        <span key={st}>
          <Mark state={st} />
          {st === "ok" ? "Passed" : st === "warn" ? "Look at this" : st === "fail" ? "Broken" : st === "skip" ? "Skipped" : "Checking"}
        </span>
      ))}
    </span>
  );
}

function rowSummary(states: TickState[], live: boolean): React.ReactNode {
  const done = states.filter((x) => x !== "running" && x !== "pending").length;
  const fail = states.filter((x) => x === "fail").length;
  const warn = states.filter((x) => x === "warn").length;
  if (live && done < states.length) {
    return (
      <>
        {done} of {states.length}
      </>
    );
  }
  if (fail || warn) {
    return (
      <>
        {fail ? <strong>{fail} broken</strong> : null}
        {fail && warn ? " · " : null}
        {warn ? <strong>{warn} to look at</strong> : null}
      </>
    );
  }
  const passed = states.filter((x) => x === "ok").length;
  return passed === states.length ? (states.length === 1 ? "Passed" : `All ${states.length} passed`) : `${passed} of ${states.length} passed`;
}

/**
 * The sweep: one row of hairline ticks per category, one tick per check, settling as results stream in.
 * One tab stop; arrow keys move between ticks (left/right) and rows (up/down); Enter opens the result.
 */
export function Sweep({ groups, plan, results, running, live, onOpen }: { groups: CheckupGroup[]; plan: CheckPlanItem[]; results: Map<string, CheckResult>; running: Set<string>; live: boolean; onOpen: (id: string) => void }) {
  const rows = React.useMemo(() => groups.map((g) => ({ g, items: plan.filter((p) => p.group === g.id) })).filter((r) => r.items.length), [groups, plan]);
  const flat = React.useMemo(() => rows.flatMap((r) => r.items), [rows]);
  const [active, setActive] = React.useState<string | null>(null);
  const [focusId, setFocusId] = React.useState<string | null>(null);
  const refs = React.useRef(new Map<string, HTMLButtonElement>());
  const tabId = focusId && flat.some((p) => p.id === focusId) ? focusId : (flat[0]?.id ?? null);
  const shown = active ? plan.find((p) => p.id === active) : null;
  const shownResult = shown ? results.get(shown.id) : null;
  const shownGroup = shown ? groups.find((g) => g.id === shown.group)?.label : null;

  const move = (id: string) => {
    setFocusId(id);
    setActive(id);
    refs.current.get(id)?.focus();
  };
  const onKey = (e: React.KeyboardEvent, rowIdx: number, idx: number) => {
    const row = rows[rowIdx]!.items;
    let next: string | undefined;
    if (e.key === "ArrowRight") next = row[Math.min(row.length - 1, idx + 1)]?.id;
    else if (e.key === "ArrowLeft") next = row[Math.max(0, idx - 1)]?.id;
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const r = rows[Math.max(0, Math.min(rows.length - 1, rowIdx + (e.key === "ArrowDown" ? 1 : -1)))]!.items;
      next = r[Math.min(r.length - 1, idx)]?.id;
    } else if (e.key === "Home") next = row[0]?.id;
    else if (e.key === "End") next = row.at(-1)?.id;
    else return;
    e.preventDefault();
    if (next) move(next);
  };

  return (
    <div>
      <div className={s.sweep} data-isolate={active ? "" : undefined} onPointerLeave={() => setActive(null)} role="group" aria-label="Checks by category">
        {rows.map(({ g, items }, rowIdx) => {
          const states = items.map((p) => tickState(p.id, results, running, live));
          const worst: TickState = states.includes("fail") ? "fail" : states.includes("warn") ? "warn" : "ok";
          const summary = rowSummary(states, live);
          return (
            <div key={g.id} className={s.sweepRow} data-state={worst}>
              <span className={s.sweepLabel} id={`sweep-${g.id}`}>
                {g.label}
              </span>
              <div className={s.ticks} role="group" aria-labelledby={`sweep-${g.id}`}>
                {items.map((p, idx) => {
                  const st = states[idx]!;
                  const r = results.get(p.id);
                  return (
                    <button
                      key={p.id}
                      ref={(el) => {
                        if (el) refs.current.set(p.id, el);
                        else refs.current.delete(p.id);
                      }}
                      type="button"
                      className={s.tick}
                      data-active={active === p.id ? "" : undefined}
                      tabIndex={p.id === tabId ? 0 : -1}
                      aria-label={`${p.label}: ${r ? r.title : STATE_WORD[st]}`}
                      onPointerEnter={() => setActive(p.id)}
                      onFocus={() => {
                        setFocusId(p.id);
                        setActive(p.id);
                      }}
                      onBlur={() => setActive((a) => (a === p.id ? null : a))}
                      onKeyDown={(e) => onKey(e, rowIdx, idx)}
                      onClick={() => r && onOpen(p.id)}
                    >
                      <Mark state={st} />
                    </button>
                  );
                })}
              </div>
              <span className={s.sweepCount}>{summary}</span>
            </div>
          );
        })}
      </div>
      <div className={s.readout} aria-live="polite">
        {shown ? (
          <>
            <span className={s.readoutGroup}>{shownGroup}</span>
            <span className={s.readoutText} title={shownResult?.title ?? shown.label}>
              {shownResult ? shownResult.title : `${shown.label}: ${STATE_WORD[tickState(shown.id, results, running, live)].toLowerCase()}…`}
            </span>
            {shownResult?.value && <span className={s.readoutValue}>{shownResult.value}</span>}
          </>
        ) : (
          <Legend />
        )}
      </div>
    </div>
  );
}

/**
 * The probe path: this server → … → the app, one hop per step. The rail into each hop is dotted until
 * reached, dashed while probing, drawn solid when it passes, and short red where it breaks.
 */
export function ProbePath({ origin, plan, results, running, live, onOpen }: { origin: string | null; plan: CheckPlanItem[]; results: Map<string, CheckResult>; running: Set<string>; live: boolean; onOpen: (id: string) => void }) {
  const hops = plan.filter((p) => p.hop);
  const label = `${origin ?? "Start"} to ${hops.at(-1)?.label ?? "the end"}`;
  return (
    <div className={s.pathWrap}>
      <ol className={s.path} style={{ "--n": hops.length + 1 } as React.CSSProperties} aria-label={`Path from ${label}`}>
        <li className={s.hop} data-origin="" data-state="ok">
          <span className={s.hopStem} aria-hidden>
            <Mark state="ok" />
          </span>
          <span className={s.hopText}>
            <span className={s.hopLabel}>{origin ?? "Start"}</span>
            <span className={s.hopSub}>&nbsp;</span>
            <span className={s.hopValue} />
          </span>
        </li>
        {hops.map((h) => {
          const st = tickState(h.id, results, running, live);
          const r = results.get(h.id);
          return (
            <li key={h.id} className={s.hop} data-state={st} data-clickable={r ? "" : undefined} onClick={() => r && onOpen(h.id)}>
              <span className={s.hopStem} aria-hidden>
                <span className={s.rail} />
                <span className={s.signal} data-motion-gentle={st === "running" ? "" : undefined} />
                <Mark state={st} />
              </span>
              {r ? (
                <button type="button" className={s.hopBtn} onClick={(e) => (e.stopPropagation(), onOpen(h.id))} aria-label={`${h.label}: ${STATE_WORD[st]}. ${r.title}`}>
                  <HopText h={h} value={r.value ?? null} />
                </button>
              ) : (
                <span className={s.hopBtn}>
                  <span className="sr-only">
                    {h.label}: {STATE_WORD[st]}
                  </span>
                  <HopText h={h} value={st === "running" ? "checking…" : null} hidden />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function HopText({ h, value, hidden }: { h: CheckPlanItem; value: string | null; hidden?: boolean }) {
  return (
    <span className={s.hopText} aria-hidden={hidden || undefined}>
      <span className={s.hopLabel} title={h.label}>
        {h.label}
      </span>
      <span className={`${s.hopSub} ${h.sub && /[.:/\d]/.test(h.sub) ? "mono" : ""}`} title={h.sub ?? undefined}>
        {h.sub ?? " "}
      </span>
      <span className={s.hopValue}>{value ?? " "}</span>
    </span>
  );
}
