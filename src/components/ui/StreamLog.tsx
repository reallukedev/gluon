"use client";
import * as React from "react";
import { Dialog } from "./Dialog";
import { Button } from "./Button";
import s from "./streamLog.module.css";

export type StreamEvent =
  | { type: "line"; text: string; stream?: "out" | "err" }
  | { type: "step"; text: string; id?: string; state?: "running" | "done" | "failed" }
  | { type: "done"; ok: boolean; message: string }
  | { type: "error"; message: string }
  | { type: "progress"; done: number; total: number; current?: string };

export interface StreamState {
  steps: { text: string; state: "running" | "done" | "failed" }[];
  /** `n` counts every line ever added, so keys stay stable once old lines are trimmed. */
  lines: { text: string; err: boolean; n?: number }[];
  result: { ok: boolean; message: string } | null;
  progress: { done: number; total: number; current?: string } | null;
}

export const emptyStream: StreamState = { steps: [], lines: [], result: null, progress: null };

export function reduceStream(st: StreamState, e: StreamEvent): StreamState {
  switch (e.type) {
    case "line":
      return { ...st, lines: [...st.lines.slice(-4000), { text: e.text, err: e.stream === "err", n: (st.lines.at(-1)?.n ?? st.lines.length) + 1 }] };
    case "step": {
      const steps = st.steps.map((x) => (x.state === "running" ? { ...x, state: "done" as const } : x));
      return { ...st, steps: [...steps, { text: e.text, state: e.state ?? "running" }] };
    }
    case "progress":
      return { ...st, progress: { done: e.done, total: e.total, current: e.current } };
    case "done":
      return { ...st, steps: st.steps.map((x) => (x.state === "running" ? { ...x, state: e.ok ? "done" : "failed" } : x)), result: { ok: e.ok, message: e.message } };
    case "error":
      return { ...st, steps: st.steps.map((x) => (x.state === "running" ? { ...x, state: "failed" } : x)), result: { ok: false, message: e.message } };
  }
}

/** Steps + scrolling output + final result, for long server operations. */
export function StreamView({ state, height = 280 }: { state: StreamState; height?: number }) {
  const out = React.useRef<HTMLPreElement>(null);
  const stick = React.useRef(true);
  React.useEffect(() => {
    const el = out.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
    // The array, not its length: past the 4,000-line cap the length stops changing.
  }, [state.lines]);
  return (
    <div className={s.wrap}>
      {state.steps.length > 0 && (
        <ol className={s.steps}>
          {state.steps.map((st, i) => (
            <li key={i} data-state={st.state}>
              <span className={s.stepMark} aria-hidden />
              {st.text}
            </li>
          ))}
        </ol>
      )}
      {state.progress && state.progress.total > 0 && (
        <div className={s.progress} role="progressbar" aria-valuemin={0} aria-valuemax={state.progress.total} aria-valuenow={state.progress.done}>
          <div style={{ width: `${Math.min(100, (state.progress.done / state.progress.total) * 100)}%` }} />
          {state.progress.current && <span className="mono">{state.progress.current}</span>}
        </div>
      )}
      {state.lines.length > 0 && (
        <pre
          ref={out}
          className={s.out}
          style={{ maxHeight: height }}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {state.lines.map((l, i) => (
            <span key={l.n ?? i} data-err={l.err ? "" : undefined}>
              {l.text}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
      {state.result && (
        <p className={s.result} data-ok={state.result.ok ? "" : undefined} role="status">
          {state.result.message}
        </p>
      )}
    </div>
  );
}

/** A dialog that runs a streamed operation and shows its progress. Can't be closed while running. */
export function StreamDialog({ open, onClose, title, description, state, running }: { open: boolean; onClose: () => void; title: string; description?: string; state: StreamState; running: boolean }) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && !running && onClose()}
      title={title}
      description={description}
      size="wide"
      footer={
        <Button variant={running ? "ghost" : "primary"} onClick={onClose} disabled={running}>
          {running ? "Working…" : "Close"}
        </Button>
      }
    >
      <StreamView state={state} />
    </Dialog>
  );
}
