"use client";
import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Download, Pause, Play, NavArrowDown, ArrowUp } from "iconoir-react";
import type { JournalEntry } from "@/lib/system-types";
import { api, useStream } from "@/lib/client/api";
import { usePrefs, useFormat } from "@/components/PrefsProvider";
import { Segmented, Checkbox } from "@/components/ui/Field";
import { Button, IconButton } from "@/components/ui/Button";
import l from "@/components/apps/logs.module.css";
import s from "./system.module.css";

const MAX = 10_000;
const level = (p: number) => (p <= 3 ? "error" : p === 4 ? "warn" : p >= 7 ? "debug" : undefined);

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

/** A service's journal: recent entries, then live. Same look and behaviour as the app log viewer. */
export function ServiceJournal({ unit }: { unit: string }) {
  const { prefs, setPrefs } = usePrefs();
  const fmt = useFormat();
  const [entries, setEntries] = React.useState<JournalEntry[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [olderBusy, setOlderBusy] = React.useState(false);
  const [noOlder, setNoOlder] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [lvl, setLvl] = React.useState<"all" | "warn" | "error">("all");
  const [follow, setFollow] = React.useState(true);
  const [missed, setMissed] = React.useState(0);
  const followRef = React.useRef(follow);
  followRef.current = follow;
  const parent = React.useRef<HTMLDivElement>(null);
  // Reconnects resume from the first cursor, so remember what we've shown to skip repeats.
  const seen = React.useRef(new Set<string>());
  const base = `/api/system/services/${encodeURIComponent(unit)}/logs`;

  React.useEffect(() => {
    let cancelled = false;
    setEntries([]);
    setLoaded(false);
    setLoadError(null);
    setCursor(null);
    setNoOlder(false);
    api
      .get<{ entries: JournalEntry[] }>(`${base}?lines=400`)
      .then((r) => {
        if (cancelled) return;
        seen.current = new Set(r.entries.map((e) => e.cursor));
        setEntries(r.entries);
        setCursor(r.entries.at(-1)?.cursor ?? "");
        setNoOlder(r.entries.length < 400);
        setLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "The log couldn't be read.");
        setLoaded(true);
        setCursor("");
      });
    return () => {
      cancelled = true;
    };
  }, [base]);

  // Go live once the history is in, continuing right after its last entry.
  const liveUrl = cursor === null ? null : `${base}/stream${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
  const status = useStream(
    liveUrl,
    {
      entry: (d) => {
        const e = d as JournalEntry;
        if (e.cursor && seen.current.has(e.cursor)) return;
        if (e.cursor) seen.current.add(e.cursor);
        setEntries((prev) => (prev.length >= MAX ? [...prev.slice(prev.length - MAX + 1), e] : [...prev, e]));
        if (!followRef.current) setMissed((m) => m + 1);
      },
    },
    [liveUrl],
  );

  async function loadOlder() {
    const first = entries[0];
    if (!first) return;
    setOlderBusy(true);
    try {
      const r = await api.get<{ entries: JournalEntry[] }>(`${base}?lines=400&before=${first.time}`);
      const known = new Set(entries.slice(0, 50).map((e) => e.cursor));
      const older = r.entries.filter((e) => !known.has(e.cursor));
      if (older.length < 1) setNoOlder(true);
      setFollow(false);
      setEntries((prev) => [...older, ...prev].slice(0, MAX));
    } catch {
      /* keep what we have */
    } finally {
      setOlderBusy(false);
    }
  }

  const term = q.trim().toLowerCase();
  const visible = React.useMemo(
    () =>
      entries.filter((e) => {
        if (lvl === "error" && e.priority > 3) return false;
        if (lvl === "warn" && e.priority > 4) return false;
        if (term && !e.message.toLowerCase().includes(term) && !(e.identifier ?? "").toLowerCase().includes(term)) return false;
        return true;
      }),
    [entries, lvl, term],
  );

  const v = useVirtualizer({
    count: visible.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 20,
    overscan: 30,
    measureElement: prefs.logsWrap ? (el) => el.getBoundingClientRect().height : undefined,
  });

  React.useEffect(() => {
    if (follow && visible.length) v.scrollToIndex(visible.length - 1, { align: "end" });
  }, [visible.length, follow, v]);

  const onScroll = () => {
    const el = parent.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom && !follow) {
      setFollow(true);
      setMissed(0);
    } else if (!atBottom && follow) setFollow(false);
  };

  function download() {
    const text = visible.map((e) => `${new Date(e.time).toISOString()} ${e.identifier ?? ""}${e.pid ? `[${e.pid}]` : ""}: ${e.message}`).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = `${unit.replace(/\.service$/, "")}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const showIdent = React.useMemo(() => new Set(entries.slice(-200).map((e) => e.identifier)).size > 1, [entries]);

  return (
    <div className={l.wrap}>
      <div className={l.toolbar}>
        <input className={l.search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the log" aria-label="Search the log" spellCheck={false} />
        <Segmented
          aria-label="Level"
          value={lvl}
          onChange={setLvl}
          options={[
            { value: "all", label: "Everything" },
            { value: "warn", label: "Warnings" },
            { value: "error", label: "Errors" },
          ]}
        />
        <span className={l.spacer} />
        <span className={l.status} data-status={status}>
          {liveUrl === null ? "Loading…" : status === "live" ? (follow ? "Live" : "Paused") : status === "connecting" ? "Connecting…" : "Reconnecting…"}
        </span>
        <IconButton
          label={follow ? "Pause" : "Follow new lines"}
          size="sm"
          onClick={() => {
            setFollow(!follow);
            setMissed(0);
          }}
        >
          {follow ? <Pause /> : <Play />}
        </IconButton>
        <IconButton label="Download" size="sm" onClick={download} disabled={!visible.length}>
          <Download />
        </IconButton>
      </div>
      <div className={l.opts}>
        <Checkbox checked={prefs.logsWrap} onChange={(w) => void setPrefs({ logsWrap: w })}>
          Wrap long lines
        </Checkbox>
        <Checkbox checked={prefs.logsTimestamps} onChange={(t) => void setPrefs({ logsTimestamps: t })}>
          Show times
        </Checkbox>
        {!noOlder && loaded && entries.length > 0 && (
          <Button size="sm" variant="ghost" icon={<ArrowUp />} loading={olderBusy} onClick={() => void loadOlder()}>
            Load older
          </Button>
        )}
        <span className={l.count}>
          {fmt.plural(visible.length, "line")}
          {visible.length !== entries.length && ` of ${entries.length.toLocaleString()}`}
        </span>
      </div>

      <div className={`${l.viewport} ${s.journalViewport}`} ref={parent} onScroll={onScroll} data-wrap={prefs.logsWrap ? "" : undefined} role="log" aria-live="off" aria-label={`Log for ${unit}`}>
        {!loaded ? (
          <p className={l.empty}>Loading the latest lines…</p>
        ) : loadError ? (
          <p className={l.empty}>Couldn't read the log: {loadError}</p>
        ) : visible.length === 0 ? (
          <p className={l.empty}>{entries.length ? "No lines match." : "Nothing logged yet. New lines appear here as they're written."}</p>
        ) : (
          <div style={{ height: v.getTotalSize(), position: "relative" }}>
            {v.getVirtualItems().map((item) => {
              const e = visible[item.index]!;
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={prefs.logsWrap ? v.measureElement : undefined}
                  className={l.line}
                  data-level={level(e.priority)}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {prefs.logsTimestamps && <span className={l.ts}>{fmt.dateTime(e.time)}</span>}
                  {showIdent && <span className={l.ctr}>{e.identifier ?? ""}</span>}
                  <span className={l.text}>{highlight(e.message, term)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {!follow && missed > 0 && (
        <div className={l.jump}>
          <Button
            size="sm"
            variant="primary"
            icon={<NavArrowDown />}
            onClick={() => {
              setFollow(true);
              setMissed(0);
            }}
          >
            {fmt.plural(missed, "new line")}
          </Button>
        </div>
      )}
    </div>
  );
}
