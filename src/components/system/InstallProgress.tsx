"use client";
import * as React from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { StateLine, type LineState } from "@/components/ui/StateLine";
import { StreamView, type StreamState } from "@/components/ui/StreamLog";
import { Disclosure } from "@/components/ui/Disclosure";
import { useFormat } from "@/components/PrefsProvider";
import u from "./updates.module.css";

/**
 * Reads apt's own output and draws each package moving through its three steps
 * (download → unpack → set up), so a long install shows where it is instead of a wall of text.
 * The raw output is one click away.
 */

type Stage = 0 | 1 | 2 | 3; // waiting, downloaded, unpacked, set up

const GET = /^Get:\d+\s+\S+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+\S+\s+\[/;
const UNPACK = /^Unpacking (\S+?)(?::[a-z0-9]+)? \(/;
const SETUP = /^Setting up (\S+?)(?::[a-z0-9]+)? \(/;
const FETCHED = /^Fetched /;
const TRIGGERS = /^Processing triggers for /;

interface Parsed {
  stages: Map<string, Stage>;
  phase: "preparing" | "downloading" | "installing" | "finishing";
}

function parse(lines: StreamState["lines"], expected: string[]): Parsed {
  const stages = new Map<string, Stage>(expected.map((n) => [n, 0]));
  let phase: Parsed["phase"] = "preparing";
  const bump = (name: string, st: Stage) => {
    if ((stages.get(name) ?? -1) < st) stages.set(name, st);
  };
  for (const { text } of lines) {
    let m: RegExpMatchArray | null;
    if ((m = text.match(GET))) {
      bump(m[1]!, 1);
      phase = "downloading";
    } else if (FETCHED.test(text)) {
      for (const [k, v] of stages) if (v < 1) stages.set(k, 1);
      phase = "installing";
    } else if ((m = text.match(UNPACK))) {
      bump(m[1]!, 2);
      phase = "installing";
    } else if ((m = text.match(SETUP))) {
      bump(m[1]!, 3);
      phase = "installing";
    } else if (TRIGGERS.test(text)) phase = "finishing";
  }
  return { stages, phase };
}

const PHASE_WORDS: Record<Parsed["phase"], string> = {
  preparing: "Getting ready…",
  downloading: "Downloading…",
  installing: "Installing…",
  finishing: "Finishing up…",
};

export function InstallProgress({ state, expected, running }: { state: StreamState; expected: string[]; running: boolean }) {
  const fmt = useFormat();
  const [showOutput, setShowOutput] = React.useState(false);
  const { stages, phase } = React.useMemo(() => parse(state.lines, expected), [state.lines, expected]);
  const rows = [...stages.entries()];
  const done = rows.filter(([, v]) => v === 3).length;
  const result = state.result;
  const failed = result && !result.ok;

  const headline = result ? result.message : PHASE_WORDS[phase];
  return (
    <div className={u.progress}>
      <div className={u.progressHead} role="status" aria-live="polite">
        <StateLine state={result ? (result.ok ? "running" : "unhealthy") : "starting"} size={18} />
        <span className={u.progressText}>
          <span className={u.progressTitle}>{headline}</span>
          {rows.length > 0 && (
            <span className={`${u.dim} num`}>
              {done} of {fmt.plural(rows.length, "package")} set up
            </span>
          )}
        </span>
      </div>

      {rows.length > 0 && (
        <ul className={u.tracks} aria-label="Packages">
          {rows.map(([name, st]) => {
            const line: LineState = st === 3 ? "running" : failed ? "stopped" : st > 0 || (running && phase !== "preparing") ? "starting" : "stopped";
            return (
              <li key={name} className={u.track}>
                <StateLine state={line} label={false} size={12} />
                <span className={`${u.trackName} mono`} title={name}>
                  {name}
                </span>
                <span className={u.steps} aria-label={st === 3 ? "Set up" : st === 2 ? "Unpacked" : st === 1 ? "Downloaded" : "Waiting"}>
                  {[1, 2, 3].map((k) => (
                    <i key={k} data-on={st >= k ? "" : undefined} />
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > 0 && (
        <p className={u.stepLegend} aria-hidden>
          <span>Download</span>
          <span>Unpack</span>
          <span>Set up</span>
        </p>
      )}

      {(state.lines.length > 0 || failed) && (
        <Disclosure summary="The full output" meta={fmt.plural(state.lines.length, "line")} open={showOutput || !!failed} onOpenChange={setShowOutput}>
          <div className={u.output}>
            <StreamView state={{ ...state, steps: [], result: null }} height={260} />
          </div>
        </Disclosure>
      )}
    </div>
  );
}

export function InstallDialog({
  open,
  onClose,
  title,
  description,
  state,
  running,
  expected,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  state: StreamState;
  running: boolean;
  expected: string[];
}) {
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
      <InstallProgress state={state} expected={expected} running={running} />
    </Dialog>
  );
}
