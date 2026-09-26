"use client";
import * as React from "react";
import { useFormat } from "@/components/PrefsProvider";

type Kind = "relative" | "time" | "dateTime" | "date";

/**
 * A timestamp. Relative times re-render each minute; all variants tolerate the unavoidable
 * server/client difference in "now".
 */
export function Time({ ts, kind = "relative", seconds, className }: { ts: number; kind?: Kind; seconds?: boolean; className?: string }) {
  const fmt = useFormat();
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    if (kind !== "relative") return;
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [kind]);
  const text = kind === "relative" ? fmt.relative(ts) : kind === "time" ? fmt.time(ts, seconds) : kind === "date" ? fmt.date(ts) : fmt.dateTime(ts);
  return (
    <time dateTime={new Date(ts).toISOString()} title={kind === "relative" ? fmt.dateTime(ts) : undefined} className={className} suppressHydrationWarning>
      {text}
    </time>
  );
}
