"use client";
import * as React from "react";
import { ArrowDown, ArrowUp } from "iconoir-react";
import type { WidgetProps } from "../types";
import { useLive } from "@/lib/client/live";
import { useFormat } from "@/components/PrefsProvider";
import { Skeleton } from "@/components/ui/Surface";
import { Age } from "./kit";
import s from "./network.module.css";

/** Size of an element, kept current as the widget is resized. */
function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = React.useRef<T>(null);
  const [size, setSize] = React.useState({ w: 0, h: 0 });
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setSize({
        w: Math.floor(e!.contentRect.width),
        h: Math.floor(e!.contentRect.height),
      }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

const FLOOR = 1000; // 1 kB/s: below this a home network is idle.
/** Log scale: every decade (1 kB/s, 10 kB/s, 1 MB/s…) gets the same height, so a quiet baseline and a burst both read. */
const scale = (v: number, top: number) => Math.log10(1 + Math.max(0, v) / FLOOR) / Math.log10(1 + top / FLOOR);

/**
 * Network traffic as a seismograph: one hairline per sample, incoming above the rail and outgoing below, on a
 * log scale with a dashed rule per decade. Hover, touch or arrow keys read any moment back into the figures.
 */
export function NetworkWidget({ size }: WidgetProps) {
  const { host, status } = useLive();
  const fmt = useFormat();
  const [ref, box] = useSize<HTMLDivElement>();
  const offline = status === "offline";
  const [cursor, setCursor] = React.useState<number | null>(null);
  const samples = host.length > 1 ? host : [];
  const last = host.at(-1);
  const sel = cursor !== null ? samples[Math.min(cursor, samples.length - 1)] : undefined;
  const shown = sel ?? last;

  const peakIn = Math.max(0, ...samples.map((h) => h.net.rx));
  const peakOut = Math.max(0, ...samples.map((h) => h.net.tx));
  // Top of the scale: the next decade above the busiest moment, never less than 100 kB/s.
  const top = 10 ** Math.max(5, Math.ceil(Math.log10(Math.max(peakIn, peakOut, 1))));
  const decades: number[] = [];
  for (let d = FLOOR * 10; d < top; d *= 10) decades.push(d);

  const t0 = samples[0]?.t ?? 0;
  const t1 = samples.at(-1)?.t ?? 1;
  const span = Math.max(1, t1 - t0);
  const minutes = Math.max(1, Math.round(span / 60_000));
  const { w, h } = box;
  const mid = Math.round(h * 0.56) + 0.5; // incoming gets a little more room: it's what people watch
  const up = mid - 4;
  const down = h - mid - 4;
  const x = (t: number) => 1 + ((t - t0) / span) * (w - 2 - 44);

  function pick(clientX: number, rect: DOMRect) {
    const px = clientX - rect.left;
    const t = t0 + ((px - 1) / Math.max(1, w - 46)) * span;
    let best = 0;
    for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i]!.t - t) < Math.abs(samples[best]!.t - t)) best = i;
    setCursor(best);
  }

  const compact = size === "s";
  const label = samples.length
    ? `Network traffic over the last ${minutes} minutes. Now ${fmt.rate(last?.net.rx)} in, ${fmt.rate(last?.net.tx)} out. Busiest: ${fmt.rate(peakIn)} in, ${fmt.rate(peakOut)} out.`
    : "Network traffic, waiting for the first readings";

  return (
    <div className={s.net} data-size={size}>
      <div className={s.figures} aria-live="off">
        <div className={s.figure}>
          <span className="label">
            <ArrowDown aria-hidden /> In
          </span>
          <strong>{shown ? fmt.rate(shown.net.rx) : "—"}</strong>
        </div>
        <div className={s.figure} data-out="">
          <span className="label">
            <ArrowUp aria-hidden /> Out
          </span>
          <strong>{shown ? fmt.rate(shown.net.tx) : "—"}</strong>
        </div>
        {!compact && <span className={s.when}>{sel ? fmt.time(sel.t, true) : offline && last ? <Age at={last.t} expectMs={10_000} /> : "Now"}</span>}
      </div>

      <div className={s.plot} ref={ref}>
        {!samples.length && offline ? (
          <p className={s.waiting}>Waiting for the server. Live readings pick up again as soon as it answers.</p>
        ) : !samples.length || w < 40 || h < 30 ? (
          <Skeleton height="100%" />
        ) : (
          <svg
            className={s.svg}
            width={w}
            height={h}
            role="img"
            aria-label={label}
            tabIndex={0}
            onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
            onPointerDown={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
            onPointerLeave={(e) => e.pointerType === "mouse" && setCursor(null)}
            onBlur={() => setCursor(null)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                const cur = cursor ?? samples.length - 1;
                setCursor(Math.max(0, Math.min(samples.length - 1, cur + (e.key === "ArrowLeft" ? -1 : 1))));
              } else if (e.key === "Escape") setCursor(null);
            }}
          >
            {decades.map((d) => {
              const yUp = mid - scale(d, top) * up;
              const yDown = mid + scale(d, top) * down;
              return (
                <g key={d} className={s.grid}>
                  <line x1={0} x2={w - 44} y1={Math.round(yUp) + 0.5} y2={Math.round(yUp) + 0.5} />
                  {!compact && <line x1={0} x2={w - 44} y1={Math.round(yDown) + 0.5} y2={Math.round(yDown) + 0.5} />}
                  <text x={w - 40} y={yUp + 3.5}>
                    {fmt.rate(d)}
                  </text>
                </g>
              );
            })}
            <line className={s.rail} x1={0} x2={w - 44} y1={mid} y2={mid} />
            {samples.map((p, i) => {
              const xi = Math.round(x(p.t)) + 0.5;
              const hi = Math.max(1, scale(p.net.rx, top) * up);
              const ho = Math.max(1, scale(p.net.tx, top) * down);
              const on = cursor === i;
              return (
                <g key={p.t} className={s.tick} data-on={on ? "" : undefined}>
                  <line x1={xi} x2={xi} y1={mid - 1} y2={mid - 1 - hi} className={s.in} />
                  <line x1={xi} x2={xi} y1={mid + 1} y2={mid + 1 + ho} className={s.out} />
                </g>
              );
            })}
            {cursor !== null && samples[cursor] && (
              <line className={s.cursor} x1={Math.round(x(samples[cursor]!.t)) + 0.5} x2={Math.round(x(samples[cursor]!.t)) + 0.5} y1={0} y2={h} />
            )}
            <text className={s.axis} x={w - 40} y={h - 2}>
              {minutes} min
            </text>
          </svg>
        )}
      </div>

      {(size === "t" || size === "l" || size === "w") && samples.length > 0 && (
        <p className={s.foot}>
          Busiest: <b className="num">{fmt.rate(peakIn)}</b> in · <b className="num">{fmt.rate(peakOut)}</b> out
        </p>
      )}
    </div>
  );
}
