"use client";
import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Download, Pause, Play, Trash, NavArrowDown } from "iconoir-react";
import type { LogEntry, LogLevel } from "@/lib/diagnostics-types";
import { useApi, useStream } from "@/lib/client/api";
import { usePrefs, useFormat } from "@/components/PrefsProvider";
import { Select } from "@/components/ui/Select";
import { Segmented, Checkbox } from "@/components/ui/Field";
import { Button, IconButton } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Surface";
import lg from "@/components/apps/logs.module.css";
import s from "./diagnostics.module.css";

type Source = "kernel" | "journal" | "docker";
const MAX = 20_000;

const band = (l: LogLevel): "error" | "warn" | "debug" | undefined =>
  l === "emergency" || l === "alert" || l === "critical" || l === "error" ? "error" : l === "warning" ? "warn" : l === "debug" ? "debug" : undefined;

const PRIORITIES = [
  { value: "7", label: "Everything" },
  { value: "6", label: "Info and worse" },
  { value: "5", label: "Notices and worse" },
  { value: "4", label: "Warnings and worse" },
  { value: "3", label: "Errors and worse" },
] as const;

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

export function LogsTab({ initialSource, initialUnit }: { initialSource: Source; initialUnit: string | null }) {
  const { prefs, setPrefs } = usePrefs();
  const fmt = useFormat();
  const [source, setSource] = React.useState<Source>(initialUnit ? "journal" : initialSource);
  const [unit, setUnit] = React.useState(initialUnit ?? "");
  const [priority, setPriority] = React.useState<string>("7");
  const [lines, setLines] = React.useState<LogEntry[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [follow, setFollow] = React.useState(true);
  const [missed, setMissed] = React.useState(0);
  const followRef = React.useRef(follow);
  followRef.current = follow;
  const parent = React.useRef<HTMLDivElement>(null);
  const units = useApi<{ units: string[] }>(source === "journal" ? "/api/diagnostics/logs/units" : null);

  const params = new URLSearchParams({ source, lines: "500" });
  if (source === "journal" && unit) params.set("unit", unit);
  if (source !== "docker" && priority !== "7") params.set("priority", priority);
  const url = `/api/diagnostics/logs?${params}`;

  React.useEffect(() => {
    setLines([]);
    setLoaded(false);
    setMissed(0);
    setError(null);
  }, [url]);

  const status = useStream(
    url,
    {
      snapshot: (d) => {
        setLines((d as { entries: LogEntry[] }).entries);
        setLoaded(true);
      },
      entries: (d) => {
        const add = d as LogEntry[];
        setLines((prev) => (prev.length + add.length > MAX ? [...prev.slice(prev.length + add.length - MAX), ...add] : [...prev, ...add]));
        if (!followRef.current) setMissed((m) => m + add.length);
      },
      error: (d) => {
        setError((d as { message: string }).message);
        setLoaded(true);
      },
    },
    [url],
  );

  const term = q.trim().toLowerCase();
  const visible = React.useMemo(() => (term ? lines.filter((l) => `${l.message} ${l.identifier ?? ""} ${l.unit ?? ""}`.toLowerCase().includes(term)) : lines), [lines, term]);

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
    const text = visible.map((l) => `${new Date(l.time).toISOString()} ${l.level.toUpperCase()} ${l.identifier ? `[${l.identifier}] ` : ""}${l.message}`).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = `${source}${unit ? `-${unit}` : ""}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const showWho = source !== "kernel" && !(source === "journal" && unit);
  return (
    <div className={lg.wrap}>
      <div className={lg.toolbar}>
        <Segmented
          aria-label="Log"
          value={source}
          onChange={setSource}
          options={[
            { value: "kernel", label: "Kernel and hardware" },
            { value: "journal", label: "Services" },
            { value: "docker", label: "Container events" },
          ]}
        />
        {source === "journal" && (
          <Select aria-label="Service" value={unit} onChange={setUnit} options={[{ value: "", label: "Every service" }, ...[...new Set([...(units.data?.units ?? []), ...(unit ? [unit] : [])])].map((u) => ({ value: u, label: u.replace(/\.service$/, "") }))]} />
        )}
        {source !== "docker" && <Select aria-label="Priority" value={priority} onChange={setPriority} options={PRIORITIES} />}
        <input className={lg.search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search the log" spellCheck={false} />
        <span className={lg.spacer} />
        <span className={lg.status} data-status={status}>
          {status === "live" ? (follow ? "Live" : "Paused") : status === "connecting" ? "Connecting…" : "Reconnecting…"}
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
        <IconButton label="Clear" size="sm" onClick={() => setLines([])}>
          <Trash />
        </IconButton>
        <IconButton label="Download" size="sm" onClick={download} disabled={!visible.length}>
          <Download />
        </IconButton>
      </div>
      <div className={lg.opts}>
        <Checkbox checked={prefs.logsWrap} onChange={(x) => void setPrefs({ logsWrap: x })}>
          Wrap long lines
        </Checkbox>
        <Checkbox checked={prefs.logsTimestamps} onChange={(x) => void setPrefs({ logsTimestamps: x })}>
          Show times
        </Checkbox>
        <span className={lg.count}>
          {fmt.plural(visible.length, "line")}
          {visible.length !== lines.length && ` of ${lines.length.toLocaleString()}`}
        </span>
      </div>

      {error && <Notice tone="fault" title="The log stopped">{error}</Notice>}

      <div className={lg.viewport} ref={parent} onScroll={onScroll} data-wrap={prefs.logsWrap ? "" : undefined} role="log" aria-live="off" aria-label={`${source} log`}>
        {!loaded ? (
          <p className={lg.empty}>Loading the latest lines…</p>
        ) : visible.length === 0 ? (
          <p className={lg.empty}>
            {lines.length
              ? "No lines match."
              : source === "docker"
                ? "No container events since Gluon started. Starts, stops and crashes appear here as they happen."
                : "Nothing logged with these filters. New lines appear here as they're written."}
          </p>
        ) : (
          <div style={{ height: v.getTotalSize(), position: "relative" }}>
            {v.getVirtualItems().map((item) => {
              const l = visible[item.index]!;
              return (
                <div key={item.key} data-index={item.index} ref={prefs.logsWrap ? v.measureElement : undefined} className={lg.line} data-level={band(l.level)} style={{ transform: `translateY(${item.start}px)` }}>
                  {prefs.logsTimestamps && <span className={lg.ts}>{fmt.time(l.time, true)}</span>}
                  {showWho && <span className={`${lg.ctr} ${s.who16}`}>{l.identifier ?? l.unit ?? ""}</span>}
                  <span className={lg.text}>{highlight(l.message, term)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {!follow && missed > 0 && (
        <div className={lg.jump}>
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
