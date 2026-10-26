"use client";
import s from "./moodCoil.module.css";

/**
 * The gluon coil as a mood: open and slowly breathing in green when all is well, wound tighter in sodium when
 * something needs the person. Same trochoid as the mark (mark.ts), drawn at hero size. With `draw` it sketches itself
 * in (Home passes its once-a-session entrance); reduced motion shows it drawn and still.
 */

export type Mood = "calm" | "tense" | "fault" | "quiet";

const W = 120;
const BASE = 50;
const X0 = 14;
const X1 = 106;

/** x = c·t − a·sin t, y = −a·cos t, from trough to trough, so both ends sit on the baseline. */
function trochoid(loops: number, a: number): string {
  const steps = 40 * loops;
  const c = (X1 - X0) / (2 * Math.PI * loops);
  let d = "";
  for (let i = 0; i <= steps; i++) {
    const t = Math.PI + (i / steps) * 2 * Math.PI * loops;
    const x = X0 + c * (t - Math.PI) - a * Math.sin(t);
    const y = BASE - a - a * Math.cos(t);
    d += `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return d;
}

const CALM = trochoid(2, 17);
const TENSE = trochoid(3, 13);

export function MoodCoil({ mood, draw, className }: { mood: Mood; draw?: boolean; className?: string }) {
  return (
    <svg className={`${s.coil} ${className ?? ""}`} viewBox={`0 0 ${W} 64`} fill="none" aria-hidden data-mood={mood} data-draw={draw ? "" : undefined}>
      <g className={s.calm} data-motion-gentle="">
        <path className={s.breathe} d={CALM} pathLength={1} />
      </g>
      <g className={s.tense} data-motion-gentle="">
        <path d={TENSE} pathLength={1} />
      </g>
      <circle className={s.dot} cx={X0} cy={BASE} r={4.2} />
      <circle className={s.dot} cx={X1} cy={BASE} r={4.2} />
    </svg>
  );
}
