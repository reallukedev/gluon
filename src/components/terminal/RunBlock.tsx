"use client";
import * as React from "react";
import { Copy, Refresh, Square } from "iconoir-react";
import type { AnsiScreen } from "@/lib/terminal/ansi";
import { exitMeaning } from "@/lib/terminal/exit";
import { shortPath } from "@/lib/terminal/paths";
import type { ExitReason, TargetId } from "@/lib/terminal/types";
import { useFormat } from "@/components/PrefsProvider";
import { IconButton, Button } from "@/components/ui/Button";
import { StateLine } from "@/components/ui/StateLine";
import { Notice } from "@/components/ui/Surface";
import { copyText } from "@/lib/client/clipboard";
import { toast } from "@/components/ui/Toast";
import { AnsiOutput } from "./AnsiOutput";
import s from "./terminal.module.css";

export type BlockState = "running" | "ok" | "failed" | "stopped" | "error";

export interface Block {
  key: number;
  target: TargetId;
  where: string;
  cwd: string;
  home: string | null;
  command: string;
  screen: AnsiScreen;
  state: BlockState;
  exit: { code: number | null; ms: number; truncated: boolean; reason: ExitReason } | null;
  error: string | null;
  startedAt: number;
  stopping: boolean;
}

const LINE = { running: "starting", ok: "running", failed: "unhealthy", stopped: "stopped", error: "unhealthy" } as const;

function seconds(ms: number, fmt: ReturnType<typeof useFormat>) {
  if (ms < 1000) return `${Math.max(0.01, ms / 1000).toFixed(ms < 100 ? 2 : 1)} s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return fmt.duration(Math.round(ms / 1000));
}

function ending(b: Block): string | null {
  if (b.state === "error") return b.error;
  if (!b.exit) return null;
  const r = b.exit.reason;
  if (r === "stopped") return b.exit.code === 130 ? "Stopped with Ctrl-C." : "Stopped.";
  if (r === "idle") return "Stopped after 30 minutes with no output and no typing.";
  if (r === "timeout") return "Stopped at the 3 hour limit.";
  if (r === "closed") return "Stopped because the connection closed.";
  if (b.exit.code === 0 || b.exit.code === null) return null;
  const why = exitMeaning(b.exit.code);
  return why ? `Exit code ${b.exit.code}: ${why}.` : `Exit code ${b.exit.code}.`;
}

/** One command and what it printed: how it ended, how long it took, copy, run again, stop. */
export const RunBlock = React.memo(function RunBlock({ block: b, version, onStop, onAgain, onOpenTerminal }: { block: Block; version: number; onStop: (b: Block) => void; onAgain: (b: Block) => void; onOpenTerminal: (b: Block) => void }) {
  const fmt = useFormat();
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (b.state !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [b.state]);

  const end = ending(b);
  const empty = b.screen.lineCount <= 1 && b.screen.runs(0).length === 0;
  const elapsed = b.exit ? b.exit.ms : Math.max(0, now - b.startedAt);
  const failed = b.state === "failed" || b.state === "error";
  const program = b.command.trim().split(/\s+/)[0] ?? "This program";

  return (
    <article className={s.block} data-state={b.state} aria-label={`${b.command}, ${b.state === "running" ? "running" : (end ?? "finished")}`}>
      <header className={s.blockHead}>
        <span aria-hidden className={s.blockLine}>
          <StateLine state={LINE[b.state]} />
        </span>
        <p className={s.blockCommand}>
          <span className={s.blockCwd}>{shortPath(b.cwd, b.home)}</span>
          <span className={s.blockText}>{b.command}</span>
        </p>
        <div className={s.blockMeta}>
          <span className="num" aria-label={b.state === "running" ? "Running for" : "Took"}>
            {b.state === "running" && elapsed < 1000 ? "" : seconds(elapsed, fmt)}
          </span>
          {b.state === "running" ? (
            <Button size="sm" variant="ghost" icon={<Square />} onClick={() => onStop(b)} loading={b.stopping}>
              Stop
            </Button>
          ) : (
            <>
              <IconButton
                size="sm"
                label="Copy output"
                disabled={empty}
                onClick={() => {
                  void copyText(b.screen.text()).then((ok) => (ok ? toast.success("Output copied") : toast.error("Couldn't copy. Select the text instead.")));
                }}
              >
                <Copy />
              </IconButton>
              <IconButton size="sm" label="Run again" onClick={() => onAgain(b)}>
                <Refresh />
              </IconButton>
            </>
          )}
        </div>
      </header>
      {!empty && <AnsiOutput screen={b.screen} version={version} label={`Output of ${b.command}`} />}
      {b.state === "running" && b.screen.altScreen && (
        <div className={s.blockNotice}>
          <Notice tone="attention" title={`${program} draws on the whole screen`} action={<Button size="sm" onClick={() => onOpenTerminal(b)}>Open in the terminal</Button>}>
            Only the terminal can show it properly. Opening it there stops it here.
          </Notice>
        </div>
      )}
      {end && (
        <p className={s.blockEnd} data-tone={failed ? "fault" : "neutral"} role={failed ? "alert" : undefined}>
          <span className={s.endMark} aria-hidden />
          {end}
          {b.exit?.truncated && " Output past 1 MB was left out."}
        </p>
      )}
      {!end && b.exit?.truncated && (
        <p className={s.blockEnd} data-tone="neutral">
          <span className={s.endMark} aria-hidden />
          Output past 1 MB was left out.
        </p>
      )}
      {b.state === "ok" && empty && <p className={s.blockQuiet}>Finished without printing anything.</p>}
    </article>
  );
});
