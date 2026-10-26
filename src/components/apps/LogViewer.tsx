"use client";
import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Download, Pause, Play, Trash, NavArrowDown, NavArrowUp, Search } from "iconoir-react";
import type { LogLine } from "@/server/docker/logs";
import { useStream } from "@/lib/client/api";
import { usePrefs, useFormat } from "@/components/PrefsProvider";
import { Select } from "@/components/ui/Select";
import { Segmented, Checkbox } from "@/components/ui/Field";
import { Button, IconButton } from "@/components/ui/Button";
import s from "./logs.module.css";

const MAX = 20_000;
const BUCKETS = 160;

// ---- minimal ANSI SGR → spans (colours mapped onto the palette, not raw terminal colours)
const COLOR: Record<number, string> = { 31: "red", 91: "red", 33: "yellow", 93: "yellow", 32: "green", 92: "green", 34: "blue", 94: "blue", 36: "blue", 96: "blue", 35: "blue", 95: "blue", 90: "dim", 2: "dim" };
const SGR = /\x1b\[([\d;]*)m/g;
const CSI = /\x1b\[[\d;?]*[A-Za-z]/g;
function ansi(text: string): { t: string; c?: string; b?: boolean }[] {
  const out: { t: string; c?: string; b?: boolean }[] = [];
  let c: string | undefined;
  let b = false;
  const re = new RegExp(SGR);
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: text.slice(last, m.index), c, b });
    for (const code of (m[1] || "0").split(";").map(Number)) {
      if (code === 0) {
        c = undefined;
        b = false;
      } else if (code === 1) b = true;
      else if (code === 22) b = false;
      else if (code === 39) c = undefined;
      else if (COLOR[code]) c = COLOR[code];
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ t: text.slice(last), c, b });
  return out.map((p) => ({ ...p, t: p.t.replace(CSI, "") }));
}
const stripAnsi = (t: string) => t.replace(CSI, "");

function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  for (;;) {
    const j = lower.indexOf(q, i);
    if (j < 0) break;
    parts.push(text.slice(i, j), <mark key={k++}>{text.slice(j, j + q.length)}</mark>);
    i = j + q.length;
  }
  parts.push(text.slice(i));
  return parts;
}

interface Row extends LogLine {
  plain: string;
}

/**
 * Live logs: follow new lines, search with next/previous, jump between errors, and a strip down
 * the right edge that maps where errors, warnings and matches are in everything loaded.
 */
export function LogViewer({ appId, containers, initialContainer }: { appId: string; containers: { name: string; label: string }[]; initialContainer: string | null }) {
  const { prefs, setPrefs } = usePrefs();
  const fmt = useFormat();
  const names = containers.map((c) => c.name);
  const labelOf = React.useMemo(() => new Map(containers.map((c) => [c.name, c.label])), [containers]);
  const [container, setContainer] = React.useState(initialContainer && names.includes(initialContainer) ? initialContainer : "");
  const [lines, setLines] = React.useState<Row[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [onlyMatches, setOnlyMatches] = React.useState(false);
  const [level, setLevel] = React.useState<"all" | "warn" | "error">("all");
  const [follow, setFollow] = React.useState(true);
  const [missed, setMissed] = React.useState(0);
  const [cursor, setCursor] = React.useState<number | null>(null);
  const [range, setRange] = React.useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const followRef = React.useRef(follow);
  followRef.current = follow;
  const parent = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  const url = `/api/apps/${encodeURIComponent(appId)}/logs?tail=500${container ? `&container=${encodeURIComponent(container)}` : ""}`;
  const [prevUrl, setPrevUrl] = React.useState(url);
  if (prevUrl !== url) {
    setPrevUrl(url);
    setLines([]);
    setLoaded(false);
    setMissed(0);
    setCursor(null);
  }

  const toRows = (d: unknown) => (d as LogLine[]).map((l) => ({ ...l, plain: stripAnsi(l.text) }));
  const status = useStream(
    url,
    {
      history: (d) => {
        setLines(toRows(d));
        setLoaded(true);
      },
      lines: (d) => {
        const add = toRows(d);
        setLines((prev) => (prev.length + add.length > MAX ? [...prev.slice(prev.length + add.length - MAX), ...add] : [...prev, ...add]));
        if (!followRef.current) setMissed((m) => m + add.length);
      },
    },
    [url],
  );

  const term = React.useDeferredValue(q.trim().toLowerCase());
  const visible = React.useMemo(
    () =>
      lines.filter((l) => {
        if (level === "error" && l.level !== "error") return false;
        if (level === "warn" && l.level !== "error" && l.level !== "warn") return false;
        if (term && onlyMatches && !l.plain.toLowerCase().includes(term)) return false;
        return true;
      }),
    [lines, level, term, onlyMatches],
  );
  const matches = React.useMemo(() => (term ? visible.flatMap((l, i) => (l.plain.toLowerCase().includes(term) ? [i] : [])) : []), [visible, term]);
  const errors = React.useMemo(() => visible.flatMap((l, i) => (l.level === "error" ? [i] : [])), [visible]);

  const v = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 20,
    overscan: 30,
    measureElement: prefs.logsWrap ? (el) => el.getBoundingClientRect().height : undefined,
    onChange: (inst) => {
      const items = inst.getVirtualItems();
      const start = items.find((it) => it.end > (inst.scrollOffset ?? 0))?.index ?? 0;
      const end = [...items].reverse().find((it) => it.start < (inst.scrollOffset ?? 0) + (inst.scrollRect?.height ?? 0))?.index ?? start;
      setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
    },
  });

  // Stick to the bottom while following.
  React.useEffect(() => {
    if (follow && visible.length) v.scrollToIndex(visible.length - 1, { align: "end" });
  }, [visible.length, follow, v]);

  const onScroll = () => {
    const el = parent.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom && !follow && cursor === null) {
      setFollow(true);
      setMissed(0);
    } else if (!atBottom && follow) setFollow(false);
  };

  function goTo(index: number) {
    setFollow(false);
    setCursor(index);
    v.scrollToIndex(index, { align: "center" });
  }
  /** Next (or previous) index in `list` after the cursor, wrapping around. */
  function step(list: number[], dir: 1 | -1) {
    if (!list.length) return;
    const from = cursor ?? (dir === 1 ? range.start - 1 : range.end + 1);
    const next = dir === 1 ? (list.find((i) => i > from) ?? list[0]!) : ([...list].reverse().find((i) => i < from) ?? list[list.length - 1]!);
    goTo(next);
  }
  const matchPos = cursor !== null ? matches.indexOf(cursor) : -1;
  const errorPos = cursor !== null ? errors.indexOf(cursor) : -1;

  // The overview strip: one mark per slice of the loaded lines, the most serious thing in it wins.
  const marks = React.useMemo(() => {
    const n = visible.length;
    if (!n) return [];
    const size = Math.max(1, Math.ceil(n / BUCKETS));
    const out: { top: number; kind: "error" | "warn" | "match"; index: number }[] = [];
    const matchSet = new Set(matches);
    for (let b = 0; b * size < n; b++) {
      let kind: "error" | "warn" | "match" | null = null;
      let at = b * size;
      for (let i = b * size; i < Math.min(n, (b + 1) * size); i++) {
        const l = visible[i]!;
        const k = l.level === "error" ? "error" : l.level === "warn" ? "warn" : matchSet.has(i) ? "match" : null;
        if (k && (!kind || rank(k) > rank(kind))) {
          kind = k;
          at = i;
        }
      }
      if (kind) out.push({ top: (at / n) * 100, kind, index: at });
    }
    return out;
  }, [visible, matches]);

  function download() {
    const text = visible.map((l) => `${new Date(l.t).toISOString()} ${names.length > 1 ? `[${labelOf.get(l.container) ?? l.container}] ` : ""}${l.plain}`).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = `${appId}${container ? `-${container}` : ""}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const multi = names.length > 1 && !container;
  const n = visible.length;
  return (
    <div className={s.wrap}>
      <div className={s.toolbar}>
        {names.length > 1 && (
          <Select aria-label="Container" value={container} onChange={setContainer} options={[{ value: "", label: "All containers" }, ...containers.map((c) => ({ value: c.name, label: c.label, description: c.label !== c.name ? c.name : undefined }))]} />
        )}
        <label className={s.search}>
          <Search aria-hidden />
          <input
            ref={searchRef}
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setCursor(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                step(matches, e.shiftKey ? -1 : 1);
              }
            }}
            placeholder="Search the logs"
            aria-label="Search the logs"
            spellCheck={false}
          />
          {term && (
            <span className={`${s.searchCount} num`} aria-live="polite">
              {matches.length ? (matchPos >= 0 ? `${matchPos + 1} of ${matches.length}` : fmt.plural(matches.length, "match", "matches")) : "No matches"}
            </span>
          )}
        </label>
        {term && (
          <span className={s.stepper}>
            <IconButton label="Previous match (Shift+Enter)" size="sm" disabled={!matches.length} onClick={() => step(matches, -1)}>
              <NavArrowUp />
            </IconButton>
            <IconButton label="Next match (Enter)" size="sm" disabled={!matches.length} onClick={() => step(matches, 1)}>
              <NavArrowDown />
            </IconButton>
          </span>
        )}
        <Segmented
          aria-label="Show"
          value={level}
          onChange={(x) => {
            setLevel(x);
            setCursor(null);
          }}
          options={[
            { value: "all", label: "Everything" },
            { value: "warn", label: "Warnings" },
            { value: "error", label: "Errors" },
          ]}
        />
        <span className={s.spacer} />
        <span className={s.live}>
        <span className={s.status} data-status={status} data-paused={status === "live" && !follow ? "" : undefined}>
          {status === "live" ? (follow ? "Following" : "Paused") : status === "connecting" ? "Connecting…" : "Reconnecting…"}
        </span>
        <IconButton
          label={follow ? "Pause" : "Follow new lines"}
          size="sm"
          onClick={() => {
            setFollow(!follow);
            setMissed(0);
            setCursor(null);
          }}
        >
          {follow ? <Pause /> : <Play />}
        </IconButton>
        <IconButton label="Clear the screen" size="sm" onClick={() => setLines([])} disabled={!lines.length}>
          <Trash />
        </IconButton>
        <IconButton label="Download what's shown" size="sm" onClick={download} disabled={!n}>
          <Download />
        </IconButton>
        </span>
      </div>
      <div className={s.opts}>
        <Checkbox checked={prefs.logsWrap} onChange={(v2) => void setPrefs({ logsWrap: v2 })}>
          Wrap long lines
        </Checkbox>
        <Checkbox checked={prefs.logsTimestamps} onChange={(v2) => void setPrefs({ logsTimestamps: v2 })}>
          Show times
        </Checkbox>
        {term && (
          <Checkbox checked={onlyMatches} onChange={setOnlyMatches}>
            Only matching lines
          </Checkbox>
        )}
        <span className={s.errNav}>
          {errors.length > 0 ? (
            <>
              <button type="button" className={s.errJump} onClick={() => step(errors, -1)} aria-label="Previous error">
                <NavArrowUp aria-hidden />
              </button>
              <span className={`${s.errCount} num`}>{errorPos >= 0 ? `Error ${errorPos + 1} of ${errors.length}` : fmt.plural(errors.length, "error")}</span>
              <button type="button" className={s.errJump} onClick={() => step(errors, 1)} aria-label="Next error">
                <NavArrowDown aria-hidden />
              </button>
            </>
          ) : (
            loaded && <span className={s.errNone}>No errors in what's loaded</span>
          )}
        </span>
        <span className={`${s.count} num`}>
          {fmt.plural(n, "line")}
          {n !== lines.length && ` of ${lines.length.toLocaleString()}`}
        </span>
      </div>

      <div className={s.frame}>
        <div className={s.viewport} style={{ "--ctr-w": `${Math.min(16, Math.max(6, ...containers.map((c) => c.label.length)))}ch` } as React.CSSProperties} ref={parent} onScroll={onScroll} data-wrap={prefs.logsWrap ? "" : undefined} role="log" aria-live="off" aria-label="Logs" tabIndex={0}>
          {!loaded ? (
            <p className={s.empty}>Loading the latest lines…</p>
          ) : n === 0 ? (
            <p className={s.empty}>{lines.length ? "No lines match." : "Nothing logged yet. New lines appear here as they're written."}</p>
          ) : (
            <div style={{ height: v.getTotalSize(), position: "relative" }}>
              {v.getVirtualItems().map((item) => {
                const l = visible[item.index]!;
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={prefs.logsWrap ? v.measureElement : undefined}
                    className={s.line}
                    data-level={l.level ?? undefined}
                    data-current={cursor === item.index ? "" : undefined}
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    {prefs.logsTimestamps && (
                      <span className={s.ts} title={fmt.dateTime(l.t)}>
                        {fmt.time(l.t, true)}
                      </span>
                    )}
                    {multi && (
                      <span className={s.ctr} title={l.container}>
                        {labelOf.get(l.container) ?? l.container}
                      </span>
                    )}
                    <span className={s.text}>
                      {term
                        ? highlight(l.plain, term)
                        : ansi(l.text).map((p, i) => (
                            <span key={i} data-c={p.c} data-b={p.b ? "" : undefined}>
                              {p.t}
                            </span>
                          ))}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className={s.map} aria-label="Where errors, warnings and matches are" role="group">
          {n > 0 && <span className={s.mapView} style={{ top: `${(range.start / n) * 100}%`, height: `${Math.max(2, ((range.end - range.start + 1) / n) * 100)}%` }} aria-hidden />}
          {marks.map((m) => (
            <button key={`${m.kind}${m.index}`} type="button" tabIndex={-1} className={s.mark} data-kind={m.kind} style={{ top: `${m.top}%` }} onClick={() => goTo(m.index)} aria-label={`Go to ${m.kind === "match" ? "match" : m.kind === "error" ? "error" : "warning"} on line ${m.index + 1}`} />
          ))}
        </div>
        {!follow && missed > 0 && (
          <div className={s.jump}>
            <Button
              size="sm"
              variant="primary"
              icon={<NavArrowDown />}
              onClick={() => {
                setFollow(true);
                setMissed(0);
                setCursor(null);
              }}
            >
              {fmt.plural(missed, "new line")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

const rank = (k: "error" | "warn" | "match") => (k === "error" ? 3 : k === "warn" ? 2 : 1);
