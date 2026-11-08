"use client";
import { Time } from "@/components/ui/Time";
import { timeKind } from "./logic";

export function FileTime({ ts, className }: { ts: number; className?: string }) {
  return <Time ts={ts} kind={timeKind(ts, Date.now())} className={className} />;
}
