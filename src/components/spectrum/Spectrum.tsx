"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import type { LineState } from "@/lib/types";
import { lineLabel } from "@/components/ui/StateLine";
import { useContainerStats } from "@/lib/client/live";
import { useFormat, usePrefs } from "@/components/PrefsProvider";
import { shortName } from "@/lib/app-names";
import { placeLabels } from "./layout";
import s from "./spectrum.module.css";

export interface SpectrumLine {
  id: string;
  label: string;
  state: LineState;
  /** Extra readout text, e.g. "92% of 6.7 GB". Live CPU/memory is added for containers automatically. */
  detail?: string;
  /** Said before the state in the readout, e.g. "Old copy from CasaOS". */
  note?: string;
  /** Leave a small gap before this line (a sub-cluster inside the group, like an old copy). */
  gapBefore?: boolean;
  container?: string;
  href?: string;
}

export interface SpectrumGroup {
  id: string;
  label: string;
  href?: string;
  lines: SpectrumLine[];
}

interface Props {
  groups: SpectrumGroup[];
  /** Show the legend row. */
  legend?: boolean;
  height?: number;
  /** Label rows below the lines (1–3). Labels use the fewest rows that keep every name whole. */
  labelRows?: number;
  label?: string;
}

const LEGEND: { state: LineState; text: string }[] = [
  { state: "running", text: "Running" },
  { state: "starting", text: "Starting" },
  { state: "unhealthy", text: "Unhealthy" },
  { state: "stopped", text: "Stopped" },
  { state: "attention", text: "Needs you" },
];

const ROW_H = 17;
const GAP = 16;

/** A group's own width: its lines' hit areas, gaps and side padding. */
const natural = (g: SpectrumGroup) => g.lines.length * 12 + g.lines.filter((l) => l.gapBefore).length * 8 + 22;

// The rise plays once per page session: the first spectrum to mount claims it.
let playedIntro = false;

/**
 * The machine at a glance: every container (grouped by app) and every filesystem as one line.
 * State is carried by the line's form. Hover or arrow keys isolate a line and pin a live readout.
 */
export function Spectrum({ groups, legend = true, height = 88, labelRows: maxRows = 3, label = "Everything running on this server" }: Props) {
  const router = useRouter();
  const stats = useContainerStats();
  const fmt = useFormat();
  const { serverName } = usePrefs();
  const flat = React.useMemo(() => groups.flatMap((g) => g.lines.map((l) => ({ ...l, group: g }))), [groups]);
  const names = React.useMemo(() => groups.map((g) => shortName(g.label, serverName)), [groups, serverName]);
  const [active, setActive] = React.useState<number | null>(null);
  const [focusIdx, setFocusIdx] = React.useState(0);
  const [intro] = React.useState(() => !playedIntro);
  const refs = React.useRef<(HTMLAnchorElement | null)[]>([]);
  const fieldRef = React.useRef<HTMLDivElement>(null);
  const groupRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const labelRefs = React.useRef<(HTMLSpanElement | null)[]>([]);
  const [layout, setLayout] = React.useState<{ rows: number[]; max: (number | null)[]; min: number[] }>({ rows: [], max: [], min: [] });
  const rowsAllowed = Math.max(1, Math.min(3, maxRows));

  // Callouts: every group reserves a share of its label's width (so neighbours can't crowd it
  // into an ellipsis), then each label drops to the first row where it clears the one before it.
  React.useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const run = () => {
      const widths = groups.map((_, gi) => labelRefs.current[gi]?.scrollWidth ?? 0);
      // Each group reserves half its label, so any two neighbours can always hold both names.
      const min = widths.map((w) => Math.ceil((w + GAP) / Math.min(rowsAllowed, 2)));
      const lefts = groups.map((_, gi) => groupRefs.current[gi]?.offsetLeft ?? 0);
      const placed = placeLabels(
        lefts.map((left, i) => ({ left, width: widths[i]! })),
        rowsAllowed,
        GAP,
      );
      setLayout((prev) => {
        const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);
        const rows = placed.map((p) => p.row);
        const max = placed.map((p) => p.max);
        return same(prev.rows, rows) && same(prev.max, max) && same(prev.min, min) ? prev : { rows, max, min };
      });
    };
    run();
    const ro = new ResizeObserver(run);
    ro.observe(field);
    return () => ro.disconnect();
  }, [groups, names, rowsAllowed]);
  const rowCount = Math.max(1, ...layout.rows.map((r) => r + 1));

  // On narrow screens the field scrolls sideways with no scrollbar; fade whichever edge has more.
  const [more, setMore] = React.useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  React.useEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 2;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setMore((p) => (p.left === left && p.right === right ? p : { left, right }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [groups]);

  React.useEffect(() => {
    playedIntro = true;
  }, []);

  const current = active !== null ? flat[active] : null;
  const currentGroup = current ? groups.indexOf(current.group) : -1;
  const stat = current?.container ? stats.get(current.container) : undefined;

  function move(delta: number) {
    const next = Math.max(0, Math.min(flat.length - 1, (active ?? focusIdx) + delta));
    setFocusIdx(next);
    setActive(next);
    refs.current[next]?.focus();
  }

  let i = -1;
  return (
    <div className={s.wrap} data-intro={intro ? "" : undefined}>
      <div
        ref={fieldRef}
        className={s.field}
        data-more-left={more.left ? "" : undefined}
        data-more-right={more.right ? "" : undefined}
        style={{ height: height + rowCount * ROW_H + 6, paddingBottom: rowCount * ROW_H + 6 }}
        role="list"
        aria-label={label}
        onPointerLeave={() => setActive(null)}
        data-active={active !== null ? "" : undefined}
      >
        {groups.map((g, gi) => {
          const max = layout.max[gi];
          return (
            <div
              key={g.id}
              ref={(el) => {
                groupRefs.current[gi] = el;
              }}
              className={s.group}
              style={{ flexGrow: Math.max(g.lines.length, 2), minWidth: layout.min[gi] ? Math.max(layout.min[gi]!, natural(g)) : undefined, "--row": layout.rows[gi] ?? 0 } as React.CSSProperties}
              role="presentation"
            >
              <div className={s.lines}>
                {g.lines.map((l) => {
                  i++;
                  const idx = i;
                  return (
                    <a
                      key={l.id}
                      ref={(el) => {
                        refs.current[idx] = el;
                      }}
                      role="listitem"
                      href={l.href ?? g.href ?? "#"}
                      className={s.hit}
                      data-gap={l.gapBefore ? "" : undefined}
                      tabIndex={idx === focusIdx ? 0 : -1}
                      aria-label={`${names[gi]}: ${l.label}, ${l.note ? `${l.note}, ` : ""}${lineLabel(l.state)}${l.detail ? `, ${l.detail}` : ""}`}
                      data-on={active === idx ? "" : undefined}
                      style={{ "--i": idx } as React.CSSProperties}
                      onPointerEnter={() => setActive(idx)}
                      onFocus={() => {
                        setFocusIdx(idx);
                        setActive(idx);
                      }}
                      onBlur={() => setActive(null)}
                      onClick={(e) => {
                        e.preventDefault();
                        const href = l.href ?? g.href;
                        if (href) router.push(href);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                          e.preventDefault();
                          move(1);
                        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                          e.preventDefault();
                          move(-1);
                        } else if (e.key === "Home") {
                          e.preventDefault();
                          move(-flat.length);
                        } else if (e.key === "End") {
                          e.preventDefault();
                          move(flat.length);
                        }
                      }}
                    >
                      <span className={s.line} data-state={l.state} />
                    </a>
                  );
                })}
              </div>
              <span
                ref={(el) => {
                  labelRefs.current[gi] = el;
                }}
                className={s.groupLabel}
                data-on={currentGroup === gi ? "" : undefined}
                title={g.label}
                // Only when every row is taken does a name get capped; too little room even for a
                // few letters keeps the hairline and drops the text (hover still names it).
                style={max != null ? { maxWidth: max, visibility: max < 36 ? "hidden" : undefined } : undefined}
              >
                {names[gi]}
              </span>
            </div>
          );
        })}
      </div>

      <div className={s.readout} aria-live="polite">
        {current ? (
          <>
            <span className={s.readoutName}>
              <span className={s.readoutLine} data-state={current.state} aria-hidden />
              {currentGroup >= 0 ? names[currentGroup] : current.group.label}
              {current.label !== current.group.label && <span className={s.readoutSub}>{current.label}</span>}
            </span>
            <span className={s.readoutState}>
              {current.note ? `${current.note}, ${lineLabel(current.state).toLowerCase()}` : lineLabel(current.state)}
            </span>
            {stat && (
              <span className={`${s.readoutVal} num`}>
                {fmt.percent(stat.cpu, 1)} CPU · {fmt.bytes(stat.mem)}
                {stat.rx !== null && ` · ↓ ${fmt.rate(stat.rx)}`}
              </span>
            )}
            {current.detail && <span className={`${s.readoutVal} num`}>{current.detail}</span>}
          </>
        ) : legend ? (
          <span className={s.legend}>
            {LEGEND.map((l) => (
              <span key={l.state} className={s.legendItem}>
                <span className={s.readoutLine} data-state={l.state} aria-hidden />
                {l.text}
              </span>
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}
