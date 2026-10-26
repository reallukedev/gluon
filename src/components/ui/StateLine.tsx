import * as React from "react";
import s from "./stateLine.module.css";

import type { LineState } from "@/lib/types";
export type { LineState };

const LABEL: Record<LineState, string> = {
  running: "Running",
  starting: "Starting",
  unhealthy: "Unhealthy",
  stopped: "Stopped",
  attention: "Needs you",
  paused: "Paused",
  unknown: "Unknown",
};

export const lineLabel = (st: LineState) => LABEL[st];

/**
 * Gluon's status glyph. State is carried by the line's form, never by colour alone:
 * solid = running, dashed = starting, short red = unhealthy, faint = stopped,
 * doubled = needs you, dotted = paused.
 */
export function StateLine({ state, size = 14, label, className }: { state: LineState; size?: number; label?: boolean | string; className?: string }) {
  const text = typeof label === "string" ? label : LABEL[state];
  return (
    <span className={`${s.wrap} ${className ?? ""}`} style={{ "--h": `${size}px` } as React.CSSProperties}>
      <span className={s.line} data-state={state} aria-hidden data-motion-gentle="" />
      {label ? <span className={s.text}>{text}</span> : <span className="sr-only">{text}</span>}
    </span>
  );
}
