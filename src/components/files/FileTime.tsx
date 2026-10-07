"use client";
import { Time } from "@/components/ui/Time";
import { timeKind } from "./logic";

/** A file's time: "2 days ago", or a plain date when the time is in the future (a clock that's off). */
export function FileTime({ ts, className }: { ts: number; className?: string }) {
  return <Time ts={ts} kind={timeKind(ts, Date.now())} className={className} />;
}
