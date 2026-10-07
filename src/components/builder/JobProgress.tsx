"use client";
import * as React from "react";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { Disclosure } from "@/components/ui/Disclosure";
import type { JobView } from "./state";
import s from "./builder.module.css";

/**
 * A running (or finished) builder job: where it is in its plan, what it's doing now, Umbrel's
 * own percentage while it downloads, the full output, and how it ended. Nothing advances on a
 * timer; every stage comes from the server.
 */
export function JobProgress({ view, stages, running, openOutput, label, closeNote = "This keeps going if you close it. Your apps list shows how it went." }: { view: JobView; stages: { key: string; label: string }[]; running: boolean; openOutput?: boolean; label: string; closeNote?: string | null }) {
  const current = view.stage ?? stages[0]?.key ?? "";
  const ok = view.result?.ok === true;
  const failed = view.result?.ok === false;
  const pct = view.progress && view.progress.total > 0 ? Math.round((view.progress.done / view.progress.total) * 100) : null;
  const out = React.useRef<HTMLPreElement>(null);
  const stick = React.useRef(true);
  React.useEffect(() => {
    const el = out.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [view.lines.length]);

  return (
    <div className={s.job}>
      {stages.length > 1 && <FlowSteps label={label} steps={stages} current={ok ? stages[stages.length - 1]!.key : current} working={running && !view.result} failed={failed} complete={ok} />}
      {view.steps.length > 0 && (
        <ol className={s.jobSteps} aria-live="polite">
          {view.steps.slice(-6).map((st, i) => (
            <li key={`${i}-${st.text}`} data-state={st.state}>
              {st.text}
            </li>
          ))}
        </ol>
      )}
      {pct !== null && running && (
        <div className={s.pct}>
          <span className="num">{pct}%</span>
          <span className={s.track} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={view.progress?.current ?? "Progress"}>
            <span style={{ transform: `scaleX(${pct / 100})` }} />
          </span>
        </div>
      )}
      {view.result && (
        <div className={s.result} data-ok={String(view.result.ok)} role="status">
          <span>{view.result.message}</span>
        </div>
      )}
      {view.result?.detail && view.result.detail.length > 0 && (
        <Disclosure summary={view.result.ok ? "Details" : "What went wrong"} meta={`${view.result.detail.length} ${view.result.detail.length === 1 ? "line" : "lines"}`} defaultOpen={!view.result.ok}>
          <pre className={s.log}>{view.result.detail.join("\n")}</pre>
        </Disclosure>
      )}
      {view.lines.length > 0 && (
        <Disclosure summary="Output" meta={`${view.lines.length.toLocaleString()} ${view.lines.length === 1 ? "line" : "lines"}`} defaultOpen={openOutput}>
          <pre
            ref={out}
            className={`${s.log} ${s.logTall}`}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {view.lines.map((l, i) => (
              <span key={i} data-err={l.err ? "" : undefined}>
                {l.text}
                {"\n"}
              </span>
            ))}
          </pre>
        </Disclosure>
      )}
      {running && !view.result && closeNote && <p className={s.closeNote}>{closeNote}</p>}
    </div>
  );
}
