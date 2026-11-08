"use client";
import * as React from "react";
import { useFormat } from "@/components/PrefsProvider";

type Kind = "relative" | "time" | "dateTime" | "date";

const noop = () => () => {};

/**
 * A timestamp. Relative times re-render every 30 seconds. The server's clock, locale and zone can
 * differ from the browser's, so the element is re-keyed once hydrated: React keeps server text it
 * was told to ignore, and the browser's own wording would otherwise only show after the next tick.
 * A missing or broken timestamp says so instead of printing 1970 or throwing.
 */
export function Time({ ts, kind = "relative", seconds, className }: { ts: number; kind?: Kind; seconds?: boolean; className?: string }) {
  const fmt = useFormat();
  const hydrated = React.useSyncExternalStore(noop, () => true, () => false);
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    if (kind !== "relative") return;
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [kind]);
  if (!Number.isFinite(ts) || ts <= 0) {
    return <span className={className}>{kind === "relative" ? "never" : "unknown"}</span>;
  }
  const text = kind === "relative" ? fmt.relative(ts) : kind === "time" ? fmt.time(ts, seconds) : kind === "date" ? fmt.date(ts) : fmt.dateTime(ts);
  return (
    <time
      key={hydrated ? "client" : "server"}
      dateTime={new Date(ts).toISOString()}
      title={kind === "relative" ? fmt.dateTime(ts) : undefined}
      className={className}
      suppressHydrationWarning
    >
      {text}
    </time>
  );
}
