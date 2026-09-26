"use client";
import * as React from "react";
import type { LiveLogins, SignInHistory, SignInLane, SignInSpan } from "@/lib/system-types";
import { usePrefs, useFormat } from "@/components/PrefsProvider";
import { Segmented } from "@/components/ui/Field";
import { peopleList } from "./loginWords";
import s from "./signins.module.css";

const HOUR = 3_600_000;

/** Local midnights (in the person's timezone) between `from` and `to`. */
function midnights(from: number, to: number, timeZone: string | undefined): number[] {
  const f = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    timeZone,
  });
  const out: number[] = [];
  for (let t = Math.ceil(from / HOUR) * HOUR; t <= to; t += HOUR) {
    const parts = f.formatToParts(t);
    const h = Number(parts.find((p) => p.type === "hour")?.value);
    const m = Number(parts.find((p) => p.type === "minute")?.value);
    // Half-hour timezones: midnight lands between whole UTC hours.
    if (h === 0) out.push(t - m * 60_000);
    else if (h === 23 && m >= 30) out.push(t + (60 - m) * 60_000);
  }
  return [...new Set(out)];
}

/** Whole hours divisible by `every` (local time) between `from` and `to`. */
function everyHours(from: number, to: number, every: number, timeZone: string | undefined): number[] {
  const f = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hourCycle: "h23",
    timeZone,
  });
  const out: number[] = [];
  for (let t = Math.ceil(from / HOUR) * HOUR; t <= to; t += HOUR) if (Number(f.format(t)) % every === 0) out.push(t);
  return out;
}

function spanAt(lane: SignInLane, t: number, slack: number): SignInSpan | null {
  for (const sp of lane.spans) if (t >= sp.start - slack && t <= sp.end + slack) return sp;
  return null;
}

/**
 * The week as swimlanes: one lane per person, sessions as hairline segments (overlapping ones
 * merged), sign-ins from outside the home drawn as the doubled "needs you" line, and the failed
 * attempts as a strip of hourly ticks underneath on the same time axis. A cursor (pointer or
 * arrow keys) reads out who was on at that moment.
 */
export function SignInChart({ history: h, live }: { history: SignInHistory; live: LiveLogins }) {
  const fmt = useFormat();
  const { timeZone } = usePrefs();
  const plotRef = React.useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = React.useState<number | null>(null);
  const [range, setRange] = React.useState<"week" | "day">("week");
  const from = range === "day" ? h.to - 24 * HOUR : h.from;
  const span = h.to - from;
  const pos = (t: number) => `${(((Math.min(h.to, Math.max(from, t)) - from) / span) * 100).toFixed(3)}%`;
  const width = (a: number, b: number) => `${((Math.max(0, Math.min(h.to, b) - Math.max(from, a)) / span) * 100).toFixed(3)}%`;

  const days = React.useMemo(() => (range === "week" ? midnights(from, h.to, timeZone) : everyHours(from, h.to, 3, timeZone)), [range, from, h.to, timeZone]);
  const dayFmt = React.useMemo(() => new Intl.DateTimeFormat(undefined, range === "week" ? { weekday: "short", day: "numeric", timeZone } : { hour: "numeric", timeZone }), [range, timeZone]);
  const cursorFmt = React.useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
        timeZone,
      }),
    [timeZone],
  );

  const f = h.failures;
  const firstBin = Math.max(0, Math.floor((from - f.from) / f.binMs));
  const maxBin = Math.max(1, ...f.bins.slice(firstBin));
  const visibleFails = f.bins.slice(firstBin).reduce((a, b) => a + b, 0);
  const lanes = range === "week" ? h.lanes : h.lanes.filter((l) => l.spans.some((sp) => sp.end >= from));
  const slack = span / 400; // a pixel or two either side, so short sessions are hoverable

  function fromPointer(clientX: number): number | null {
    const el = plotRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || r.width <= 0) return null;
    return from + ((clientX - r.left) / r.width) * span;
  }

  function onKey(e: React.KeyboardEvent) {
    const step = e.shiftKey ? 24 * HOUR : HOUR;
    const base = cursor ?? h.to;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = Math.max(from, base - step);
    else if (e.key === "ArrowRight") next = Math.min(h.to, base + step);
    else if (e.key === "Home") next = from;
    else if (e.key === "End") next = h.to;
    else if (e.key === "Escape") return setCursor(null);
    if (next !== null) {
      e.preventDefault();
      setCursor(next);
    }
  }

  // ---------------------------------------------------------------- readout
  let readout: React.ReactNode;
  if (cursor === null) {
    const now = [...new Set(live.sessions.map((x) => x.user))];
    readout = (
      <>
        <span className={s.readTime}>Now</span>
        <span>{now.length ? `${peopleList(now)} ${now.length === 1 ? "is" : "are"} connected.` : "Nobody is connected."}</span>
        <span className={s.readHint}>Point at the timeline, or focus it and use the arrow keys, to see who was on.</span>
      </>
    );
  } else {
    const on = lanes.map((l) => ({ l, sp: spanAt(l, cursor, slack) })).filter((x) => x.sp);
    const bin = Math.floor((cursor - f.from) / f.binMs);
    const fails = f.bins[bin] ?? 0;
    const awayFails = f.awayBins[bin] ?? 0;
    const boot = h.boots.find((b) => Math.abs(b - cursor) < slack * 2);
    readout = (
      <>
        <span className={`${s.readTime} num`}>{cursorFmt.format(cursor)}</span>
        {h.oldestRecord && cursor < h.oldestRecord && !on.length ? (
          <span className={s.dim}>No sign-in records this far back</span>
        ) : on.length ? (
          on.map(({ l, sp }) => (
            <span key={l.user}>
              <b>{l.user}</b> {sp!.console ? "at the server" : sp!.sources.filter(Boolean).length ? `from ${sp!.sources.filter(Boolean).join(", ")}` : ""}
              {sp!.count > 1 ? ` · ${fmt.plural(sp!.count, "sign-in")}` : ""}
              {sp!.away ? <b className={s.away}> · outside your home</b> : null}
            </span>
          ))
        ) : (
          <span className={s.dim}>Nobody signed in</span>
        )}
        {fails > 0 && (
          <span className="num">
            {fmt.plural(fails, "failed attempt")} that hour
            {awayFails ? `, ${awayFails} from outside` : ""}
          </span>
        )}
        {boot && <span>The server started up</span>}
      </>
    );
  }

  return (
    <div className={`${s.chart} appear`}>
      <div className={s.chartTop}>
        <div className={s.readout} aria-live="polite">
          {readout}
        </div>
        <Segmented
          aria-label="Time span"
          value={range}
          onChange={(v) => {
            setRange(v);
            setCursor(null);
          }}
          options={[
            { value: "day", label: "24 hours" },
            { value: "week", label: "7 days" },
          ]}
        />
      </div>
      <div
        className={s.plotWrap}
        tabIndex={0}
        role="group"
        aria-label="Sign-ins over the last 7 days. Use the left and right arrow keys to move an hour, with Shift to move a day."
        aria-describedby="signin-summary"
        onPointerMove={(e) => {
          if (e.pointerType === "touch") return;
          setCursor(fromPointer(e.clientX));
        }}
        onPointerDown={(e) => setCursor(fromPointer(e.clientX))}
        onPointerLeave={(e) => e.pointerType !== "touch" && setCursor(null)}
        onKeyDown={onKey}
        onBlur={() => setCursor(null)}
        style={{
          gridTemplateRows: `22px repeat(${Math.max(1, lanes.length)}, var(--lane-h)) var(--fail-h)`,
        }}
      >
        {/* axis */}
        <div className={s.axisLabel} aria-hidden />
        <div className={s.axis} aria-hidden>
          {days.map((d) =>
            d < h.to - span * 0.07 && d > from + span * 0.02 ? (
              <span key={d} className={s.day} style={{ left: pos(d) }}>
                {dayFmt.format(d)}
              </span>
            ) : null,
          )}
          <span className={s.nowLabel}>now</span>
        </div>

        {/* lanes */}
        {lanes.map((l, i) => (
          <React.Fragment key={l.user}>
            <div className={s.laneLabel}>
              <span className={s.laneText}>
                <span className={s.laneName}>{l.user}</span>
                <span className={`${s.laneMeta} num`}>
                  {range === "week"
                    ? fmt.plural(l.sessions, "sign-in")
                    : fmt.plural(
                        l.spans.filter((sp) => sp.end >= from).reduce((a, sp) => a + sp.count, 0),
                        "sign-in",
                      )}
                  {l.open ? ` · ${l.open} now` : ""}
                </span>
              </span>
            </div>
            <div className={s.lane} style={{ "--i": i } as React.CSSProperties} aria-hidden>
              {l.spans
                .filter((sp) => sp.end >= from)
                .map((sp) => (
                  <span
                    key={`${sp.start}-${sp.end}`}
                    className={s.span}
                    data-away={sp.away ? "" : undefined}
                    data-open={sp.open ? "" : undefined}
                    style={{
                      left: pos(sp.start),
                      width: width(sp.start, sp.end),
                    }}
                  />
                ))}
            </div>
          </React.Fragment>
        ))}

        {lanes.length === 0 && (
          <>
            <div className={s.laneLabel} />
            <div className={`${s.lane} ${s.laneEmpty}`}>Nobody signed in this week</div>
          </>
        )}

        {/* failed attempts */}
        <div className={s.laneLabel}>
          <span className={s.laneText}>
            <span className={s.laneName}>Failed</span>
            <span className={`${s.laneMeta} num`}>{visibleFails ? fmt.plural(visibleFails, "attempt") : "none"}</span>
          </span>
        </div>
        <div className={s.failTrack} aria-hidden>
          {f.bins.map((n, i) =>
            n > 0 && i >= firstBin ? (
              <span
                key={i}
                className={s.failBin}
                style={
                  {
                    left: pos(f.from + i * f.binMs),
                    width: `${(f.binMs / span) * 100}%`,
                    "--h": Math.sqrt(n / maxBin),
                    "--a": n ? f.awayBins[i]! / n : 0,
                  } as React.CSSProperties
                }
              />
            ) : null,
          )}
          {visibleFails > 0 && <span className={`${s.failMax} num`}>{maxBin}/h</span>}
        </div>

        {/* grid, restarts, now, cursor: drawn over the lane column */}
        <div className={s.overlay} ref={plotRef} aria-hidden>
          {days.map((d) => (
            <span key={d} className={s.gridDay} style={{ left: pos(d) }} />
          ))}
          {h.boots
            .filter((b) => b >= from)
            .map((b) => (
              <span key={b} className={s.boot} style={{ left: pos(b) }} title="The server started" />
            ))}
          {h.oldestRecord && h.oldestRecord > from + span / 200 && <span className={s.noRecords} style={{ width: pos(h.oldestRecord) }} title="No sign-in records this far back" />}
          <span className={s.now} />
          {cursor !== null && <span className={s.cursor} style={{ left: pos(cursor) }} />}
        </div>
      </div>

      <div id="signin-summary" className="sr-only">
        {lanes.length
          ? lanes
              .map(
                (l) =>
                  `${l.user}: ${fmt.plural(l.sessions, "sign-in")}${l.awaySessions ? `, ${l.awaySessions} from outside the home network` : ""}${l.open ? `, ${l.open} connected now` : ""}${l.lastAt ? `, last at ${fmt.dateTime(l.lastAt)}` : ""}.`,
              )
              .join(" ")
          : "Nobody signed in during the last 7 days."}{" "}
        {f.total ? `${fmt.plural(f.total, "failed attempt")}, ${f.away} from outside the home network.` : "No failed attempts."}
      </div>

      <div className={s.legend} aria-hidden>
        <span>
          <i className={s.legendLine} /> Signed in
        </span>
        <span>
          <i className={s.legendAway} /> From outside your home
        </span>
        <span>
          <i className={s.legendFail} /> Failed attempts per hour, darker from outside
        </span>
        {h.boots.length > 0 && (
          <span>
            <i className={s.legendBoot} /> Server started
          </span>
        )}
      </div>
    </div>
  );
}
