"use client";
import * as React from "react";
import type { ProcessSnapshot } from "@/lib/diagnostics-types";
import { useLive } from "@/lib/client/live";
import { useFormat } from "@/components/PrefsProvider";
import { Skeleton } from "@/components/ui/Surface";
import s from "./instruments.module.css";

/**
 * The processor and memory at a glance: one hairline per CPU thread (its height is how busy it is),
 * and memory as one strip split by who holds it. Hover a segment to see who it is.
 */
export function Faceplate({ snap }: { snap: ProcessSnapshot | null }) {
  const fmt = useFormat();
  const live = useLive();
  const h = live.host.at(-1);
  const [active, setActive] = React.useState<string | null>(null);

  const segs = React.useMemo(() => {
    if (!snap || !h) return [];
    const by = new Map<string, number>();
    for (const p of snap.byMem) {
      const k = p.kernel ? "Kernel" : p.ownerLabel;
      by.set(k, (by.get(k) ?? 0) + p.memBytes);
    }
    const list = [...by.entries()].sort((a, b) => b[1] - a[1]);
    const top = list.slice(0, 7);
    const topSum = top.reduce((a, [, b]) => a + b, 0);
    const rest = Math.max(0, h.mem.used - topSum);
    return [...top.map(([name, bytes], i) => ({ name, bytes, tone: String(Math.min(4, i + 1)) })), ...(rest > 0 ? [{ name: "Everything else", bytes: rest, tone: "rest" }] : [])];
  }, [snap, h]);

  if (!h) {
    return (
      <div className={s.plate}>
        <div className={s.plateCell}>
          <Skeleton height={110} />
        </div>
        <div className={s.plateCell}>
          <Skeleton height={110} />
        </div>
      </div>
    );
  }
  const busiest = h.cores.reduce((m, v, i) => (v > m.v ? { v, i } : m), { v: -1, i: 0 });
  const shown = segs.find((x) => x.name === active);
  const memPct = (h.mem.used / h.mem.total) * 100;
  return (
    <div className={s.plate}>
      <section className={s.plateCell} aria-label="Processor">
        <div className={s.plateHead}>
          <span className={s.plateLabel}>Processor</span>
          <span className={s.figure}>
            {Math.round(h.cpu)}%<small>busy</small>
          </span>
        </div>
        <div className={s.coresWrap}>
          <div className={s.cores} role="img" aria-label={`${h.cores.length} threads; the busiest, number ${busiest.i}, is at ${Math.round(busiest.v)}%`}>
            {h.cores.map((v, i) => (
              <span key={i} className={s.core} data-hot={v >= 90 ? "" : undefined} title={`Thread ${i}: ${Math.round(v)}%`}>
                <span className={s.coreLine} style={{ transform: `scaleY(${Math.max(0.03, Math.min(1, v / 100))})` }} />
                <span className={s.coreNum}>{i}</span>
              </span>
            ))}
          </div>
        </div>
        <div className={s.plateFoot}>
          <span>
            Load <strong>{h.load[0].toFixed(2)}</strong> on {h.cores.length} threads
          </span>
          {snap && (
            <>
              <span>
                <strong>{snap.totals.running}</strong> running now
              </span>
              <span data-bad={snap.totals.blocked > 2 ? "" : undefined} title="Processes stuck waiting for a disk. More than a couple means storage is slow.">
                <strong>{snap.totals.blocked}</strong> waiting on disks
              </span>
              {snap.totals.zombies > 0 && (
                <span title="Finished processes their parent hasn't cleaned up. Harmless unless there are many.">
                  <strong>{snap.totals.zombies}</strong> finished, not cleaned up
                </span>
              )}
            </>
          )}
        </div>
      </section>
      <section className={s.plateCell} aria-label="Memory">
        <div className={s.plateHead}>
          <span className={s.plateLabel}>Memory</span>
          <span className={s.figure}>
            {fmt.bytes(h.mem.used)}
            <small>of {fmt.bytes(h.mem.total)}</small>
          </span>
        </div>
        {segs.length ? (
          <div className={s.strip} data-isolate={active ? "" : undefined} onPointerLeave={() => setActive(null)} role="list" aria-label="Memory by app or program">
            {segs.map((x) => (
              <span
                key={x.name}
                role="listitem"
                tabIndex={0}
                className={s.seg}
                data-tone={x.tone}
                data-active={active === x.name ? "" : undefined}
                style={{ width: `${(x.bytes / h.mem.total) * 100}%` }}
                aria-label={`${x.name}: ${fmt.bytes(x.bytes)}`}
                onPointerEnter={() => setActive(x.name)}
                onFocus={() => setActive(x.name)}
                onBlur={() => setActive(null)}
              />
            ))}
          </div>
        ) : (
          <Skeleton height={14} />
        )}
        <div className={s.readout} aria-live="polite">
          {shown ? (
            <>
              <span>{shown.name}</span>
              <span>
                {fmt.bytes(shown.bytes)} · {fmt.percent((shown.bytes / h.mem.total) * 100, 1)}
              </span>
            </>
          ) : (
            <>
              <span style={{ color: "var(--muted)" }}>{segs[0] ? `Most: ${segs[0].name}` : " "}</span>
              <span>{fmt.percent(memPct)} used</span>
            </>
          )}
        </div>
        <div className={s.plateFoot}>
          <span>
            <strong>{fmt.bytes(h.mem.available)}</strong> available
          </span>
          {h.swap.total > 0 && (
            <span>
              Swap <strong>{fmt.bytes(h.swap.used)}</strong> of {fmt.bytes(h.swap.total)}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
