"use client";
import * as React from "react";
import { isPlainStyle, styleOf, type AnsiScreen, type Run } from "@/lib/terminal/ansi";
import s from "./terminal.module.css";

const CHUNK = 200;

function attrs(st: number): { "data-fg"?: number; "data-bg"?: number; className?: string } | null {
  if (isPlainStyle(st)) return null;
  const a = styleOf(st);
  let fg = a.fg;
  let bg = a.bg;
  if (a.inverse) [fg, bg] = [bg ?? -1, fg ?? -1];
  const cls = [a.bold && s.b, a.dim && s.dim, a.italic && s.i, a.underline && s.u].filter(Boolean).join(" ");
  return { "data-fg": fg ?? undefined, "data-bg": bg ?? undefined, className: cls || undefined };
}

const Line = React.memo(
  function Line({ runs }: { runs: Run[]; rev: number }) {
    if (!runs.length) return <div className={s.line}>{"\n"}</div>;
    return (
      <div className={s.line}>
        {runs.map((r, i) => {
          const a = attrs(r.s);
          return a ? (
            <span key={i} {...a}>
              {r.text}
            </span>
          ) : (
            <React.Fragment key={i}>{r.text}</React.Fragment>
          );
        })}
      </div>
    );
  },
  (a, b) => a.rev === b.rev && a.runs === b.runs,
);

/**
 * A command's output as the terminal drew it, in the theme's colours. Lines are grouped in chunks
 * the browser can skip laying out while they're off screen, so a long output stays quick.
 */
export function AnsiOutput({ screen, version, label }: { screen: AnsiScreen; version: number; label: string }) {
  void version;
  const n = screen.lineCount;
  // A trailing empty line is just the cursor waiting on a new line.
  const shown = n > 0 && screen.runs(n - 1).length === 0 ? n - 1 : n;
  const chunks: React.ReactNode[] = [];
  for (let start = 0; start < shown; start += CHUNK) {
    const end = Math.min(shown, start + CHUNK);
    const lines: React.ReactNode[] = [];
    for (let i = start; i < end; i++) lines.push(<Line key={i} runs={screen.runs(i)} rev={screen.lineRev(i)} />);
    chunks.push(
      <div key={start} className={s.chunk} style={{ containIntrinsicSize: `auto ${(end - start) * 19}px` }}>
        {lines}
      </div>,
    );
  }
  return (
    <div className={s.output} role="log" aria-label={label} tabIndex={0}>
      {screen.dropped > 0 && <p className={s.dropped}>The first {screen.dropped.toLocaleString()} lines aren&apos;t shown, to keep the page quick. To keep all of it, run the command again with its output sent to a file.</p>}
      {chunks}
    </div>
  );
}
