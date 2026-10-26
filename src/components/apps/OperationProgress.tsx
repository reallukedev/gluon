"use client";
import type { StreamState } from "@/components/ui/StreamLog";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { Disclosure } from "@/components/ui/Disclosure";
import s from "./operation.module.css";

export type UmbrelOperation = "install" | "update";

const STAGES: Record<UmbrelOperation, { key: string; word: string | null; label: string }[]> = {
  install: [
    { key: "ask", word: null, label: "Asked Umbrel" },
    { key: "work", word: "Installing", label: "Downloading and installing" },
    { key: "start", word: "Starting", label: "Starting" },
    { key: "run", word: "Running", label: "Running" },
  ],
  update: [
    { key: "ask", word: null, label: "Asked Umbrel" },
    { key: "work", word: "Updating", label: "Downloading the new version" },
    { key: "start", word: "Starting", label: "Starting" },
    { key: "run", word: "Running", label: "Running" },
  ],
};

/**
 * Umbrel's install or update as FlowSteps, with Umbrel's own percentage under the rail while it
 * downloads. Every stage comes from what Umbrel reports; nothing advances on a timer.
 */
export function OperationProgress({ state, op, running }: { state: StreamState; op: UmbrelOperation; running: boolean }) {
  const stages = STAGES[op];
  const words = state.lines.map((l) => l.text);
  let reached = 0;
  stages.forEach((st, i) => {
    if (st.word && words.includes(st.word)) reached = Math.max(reached, i);
  });
  const result = state.result;
  const pct = state.progress && state.progress.total > 0 ? Math.round((state.progress.done / state.progress.total) * 100) : null;
  const showPct = pct !== null && running && stages[reached]?.word !== null && reached < stages.length - 1;

  return (
    <div className={s.wrap}>
      <FlowSteps
        label={op === "install" ? "Install progress" : "Update progress"}
        steps={stages.map((st) => ({ key: st.key, label: st.label }))}
        current={stages[reached]!.key}
        working={running && !result}
        failed={!!result && !result.ok}
        complete={!!result?.ok}
      />
      {showPct && (
        <div className={s.pct}>
          <span className="num">{pct}%</span>
          <span className={s.track} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={stages[reached]!.label}>
            <span style={{ transform: `scaleX(${pct / 100})` }} />
          </span>
        </div>
      )}
      {result ? (
        <p className={s.result} data-ok={result.ok ? "" : undefined} role="status">
          {result.message}
        </p>
      ) : (
        <p className={s.hint}>Umbrel carries on if you close this. Big apps can take several minutes to download.</p>
      )}
      {state.lines.length > 0 && (
        <Disclosure summary="What Umbrel reported" meta={`${state.lines.length} ${state.lines.length === 1 ? "update" : "updates"}`}>
          <ol className={s.log}>
            {state.lines.map((l, i) => (
              <li key={i} data-err={l.err ? "" : undefined}>
                {l.text}
              </li>
            ))}
          </ol>
        </Disclosure>
      )}
    </div>
  );
}
